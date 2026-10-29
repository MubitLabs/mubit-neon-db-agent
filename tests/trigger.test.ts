import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app.js";
import { LIMITS, loadConfig, type Config } from "../src/config.js";
import { closePools, poolFor } from "../src/db.js";
import { handle, TRIGGER_PATH } from "../src/http.js";
import { deliverPending } from "../src/learning.js";
import type { MubitClient } from "../src/mubit.js";
import { createStore, newId, type Delivery, type Store } from "../src/store.js";
import { hasDb, LOCAL } from "./helpers.js";

const TOKEN = "test-token-0123456789";

const configFor = (namespace: string): Config =>
  loadConfig({ ...process.env, BASE_MODEL: "test-model", CALIBRATION_BACKEND: "mubit", CALIBRATION_NAMESPACE: namespace, DEMO_ACCESS_TOKEN: TOKEN });

/** A schedule delivery as Neon sends it: the invocation id in the x-neon-trigger-invocation-id header and in the body. */
function tick(init: { header?: string | null; bodyId?: string; body?: string; token?: string; path?: string; method?: string } = {}): Request {
  const id = randomUUID();
  const headers: Record<string, string> = { "content-type": "application/json" };
  const header = init.header === undefined ? id : init.header;
  if (header !== null) headers["x-neon-trigger-invocation-id"] = header;
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const body =
    init.body ??
    JSON.stringify({ version: 1, invocation_id: init.bodyId ?? id, trigger: { type: "schedule", id: "trigger-test", name: "learning-deliveries" }, data: { scheduled_at: new Date().toISOString() } });
  const method = init.method ?? "POST";
  return new Request(`http://x${init.path ?? TRIGGER_PATH}`, { method, headers, ...(method === "GET" ? {} : { body }) });
}

/** A Mubit client that records the idempotency key of every send. `hold` delays each send; `fail` makes it throw. */
function mubitStub(opts: { fail?: boolean; hold?: Promise<void> } = {}) {
  const sent: string[] = [];
  const send = async (key: string) => {
    sent.push(key);
    await opts.hold;
    if (opts.fail) throw new Error("calibration ingest answered 503");
  };
  const client: MubitClient = {
    capabilities: async () => ({ calibration: true, calibrationBackend: "mubit", outcomeUpload: true, evaluationIsolation: true, notes: [] }),
    complete: async () => {
      throw new Error("not used");
    },
    recall: async () => ({ lessons: [], status: "empty", received: 0 }),
    remember: async (_lesson, key) => send(key),
    report: async (_outcome, key) => send(key),
  };
  return { client, sent };
}

const appWith = (config: Config, store: Store, mubit: MubitClient) => ({ config, store, mubit }) as unknown as App;

describe("the trigger route", () => {
  /** A store that records every call, so a refused request can be shown to touch nothing. */
  function recordingApp() {
    const calls: string[] = [];
    const store = new Proxy({}, { get: (_t, name) => (name === "then" ? undefined : async () => (calls.push(String(name)), null)) }) as unknown as Store;
    return { app: appWith(configFor("trigger-unit"), store, mubitStub().client), calls };
  }

  it("accepts a schedule delivery without the bearer token and returns counts only", async () => {
    const { app, calls } = recordingApp();
    const res = await handle(tick(), app);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ delivered: 0, failed: 0 });
    expect(calls).toContain("sendNextDelivery");
  });

  it("refuses a request without the trigger header, even with the bearer token", async () => {
    const { app, calls } = recordingApp();
    const res = await handle(tick({ header: null, token: TOKEN }), app);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "missing_header" });
    expect(calls).toEqual([]);
  });

  it("refuses a header that does not match the body", async () => {
    const { app, calls } = recordingApp();
    const res = await handle(tick({ header: "invocation-a", bodyId: "invocation-b" }), app);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invocation_id_mismatch" });
    expect(calls).toEqual([]);
  });

  it("refuses a body that is not a schedule delivery", async () => {
    const { app, calls } = recordingApp();
    const bad = await handle(tick({ body: "{}" }), app);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_body" });
    const id = randomUUID();
    const storage = JSON.stringify({ version: 1, invocation_id: id, trigger: { type: "storage_object_created", id: "trigger-x", name: "on-upload" }, data: { bucket_name: "b", object_key: "k" } });
    const other = await handle(tick({ header: id, body: storage }), app);
    expect(other.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("leaves every other route behind the bearer token, trigger header or not", async () => {
    const { app, calls } = recordingApp();
    const routes: [string, string][] = [
      ["GET", "/environments"],
      ["POST", "/runs"],
      ["GET", "/runs"],
      ["GET", "/runs/run_0123456789abcdef"],
      ["POST", "/runs/run_0123456789abcdef/feedback"],
      ["GET", TRIGGER_PATH],
    ];
    for (const [method, path] of routes) {
      const res = await handle(tick({ path, method }), app);
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    expect(calls).toEqual([]);
  });
});

describe.skipIf(!hasDb)("scheduled delivery", () => {
  let store: Store;
  beforeAll(() => {
    store = createStore(poolFor(LOCAL.control!, 2));
  });
  afterAll(() => closePools());

  const namespace = () => `trig-${randomUUID().slice(0, 8)}`;

  /** A reviewed run of `namespace` with `count` queued deliveries, queued `minutesAgo` minutes ago. */
  async function queue(config: Config, ns: string, count: number, minutesAgo: number) {
    const claimed = await store.claim({ tenantId: config.tenantId, environmentId: "demo-v1", mode: "calibration", question: `q ${randomUUID()}`, idempotencyKey: `trig-${randomUUID()}`, evaluation: false });
    if (claimed.kind !== "new") throw new Error("expected a new run");
    const runId = claimed.run.id;
    await store.setScope(runId, { tenantId: config.tenantId, databaseId: "acme-commerce", environmentId: "demo-v1", calibrationNamespace: ns, semanticVersion: "s", schemaHash: "h", schemaVersion: "v1" }, {}, "ok");
    const deliveries: Delivery[] = Array.from({ length: count }, (_, i) => ({ id: newId("dl"), runId, kind: "outcome", payload: { outcome: { runId } }, idempotencyKey: `test:${runId}:${i}` }));
    await store.setVerification(runId, "verified", deliveries);
    await ago(runId, minutesAgo);
    return { runId, keys: deliveries.map((d) => d.idempotencyKey) };
  }

  /** Moves a run's deliveries back in time, as if they had been queued `minutes` earlier. */
  const ago = (runId: string, minutes: number) =>
    store.pool.query("update agentctl.learning_deliveries set created_at = created_at - make_interval(mins => $2) where run_id = $1", [runId, minutes]);

  const rows = async (runId: string) =>
    (await store.pool.query("select idempotency_key, status, attempts, last_error, delivered_at from agentctl.learning_deliveries where run_id = $1 order by idempotency_key", [runId])).rows as {
      idempotency_key: string;
      status: string;
      attempts: number;
      last_error: string | null;
      delivered_at: Date | null;
    }[];

  const trigger = async (config: Config, mubit: MubitClient) => {
    const res = await handle(tick(), appWith(config, store, mubit));
    expect(res.status).toBe(200);
    return (await res.json()) as { delivered: number; failed: number };
  };

  it("drains this deployment's pending rows and leaves delivered ones untouched", async () => {
    const ns = namespace();
    const config = configFor(ns);
    const done = await queue(config, ns, 1, 5);
    await deliverPending(store, mubitStub().client, done.runId);
    const before = await rows(done.runId);
    const pending = await queue(config, ns, 3, 5);
    const mubit = mubitStub();
    expect(await trigger(config, mubit.client)).toEqual({ delivered: 3, failed: 0 });
    expect(mubit.sent.sort()).toEqual(pending.keys.sort());
    expect((await rows(pending.runId)).map((r) => [r.status, r.attempts])).toEqual([["delivered", 1], ["delivered", 1], ["delivered", 1]]);
    expect(await rows(done.runId)).toEqual(before);
  });

  it("keeps a failed send pending with one more attempt, and a later trigger retries it once it is due", async () => {
    const ns = namespace();
    const config = configFor(ns);
    const { runId, keys } = await queue(config, ns, 1, 1);
    const down = mubitStub({ fail: true });
    expect(await trigger(config, down.client)).toEqual({ delivered: 0, failed: 1 });
    const [failed] = await rows(runId);
    expect(failed).toMatchObject({ status: "pending", attempts: 1 });
    expect(failed!.last_error).toContain("503");
    // One failure: due 2 minutes after it was queued, so a tick right away leaves it alone.
    const early = mubitStub();
    expect(await trigger(config, early.client)).toEqual({ delivered: 0, failed: 0 });
    expect(early.sent).toEqual([]);
    await ago(runId, 1);
    const up = mubitStub();
    expect(await trigger(config, up.client)).toEqual({ delivered: 1, failed: 0 });
    expect(up.sent).toEqual(keys);
    expect(await rows(runId)).toMatchObject([{ status: "delivered", attempts: 2, last_error: null }]);
  });

  it("stops after LIMITS.maxDeliveryAttempts and leaves the row to learning:retry", async () => {
    const ns = namespace();
    const config = configFor(ns);
    const { runId, keys } = await queue(config, ns, 1, 2 ** LIMITS.maxDeliveryAttempts + 1);
    await store.pool.query("update agentctl.learning_deliveries set attempts = $2 where run_id = $1", [runId, LIMITS.maxDeliveryAttempts - 1]);
    expect(await trigger(config, mubitStub({ fail: true }).client)).toEqual({ delivered: 0, failed: 1 });
    expect(await rows(runId)).toMatchObject([{ status: "failed", attempts: LIMITS.maxDeliveryAttempts }]);
    const later = mubitStub();
    expect(await trigger(config, later.client)).toEqual({ delivered: 0, failed: 0 });
    expect(later.sent).toEqual([]);
    // npm run learning:retry: every row that is not delivered, whatever its attempts, each tried once per pass.
    const stillDown = mubitStub({ fail: true });
    await deliverPending(store, stillDown.client);
    expect(stillDown.sent.filter((k) => keys.includes(k))).toEqual(keys);
    expect(new Set(stillDown.sent).size).toBe(stillDown.sent.length);
    await deliverPending(store, mubitStub().client);
    expect(await rows(runId)).toMatchObject([{ status: "delivered", attempts: LIMITS.maxDeliveryAttempts + 2 }]);
  });

  it("sends only the runs of its own tenant and calibration namespace", async () => {
    const ns = namespace();
    const config = configFor(ns);
    const otherNamespace = await queue(config, namespace(), 1, 5);
    const otherTenant = await queue({ ...config, tenantId: "other-tenant" }, ns, 1, 5);
    const mubit = mubitStub();
    expect(await trigger(config, mubit.client)).toEqual({ delivered: 0, failed: 0 });
    expect(mubit.sent).toEqual([]);
    for (const foreign of [otherNamespace, otherTenant]) {
      expect(await rows(foreign.runId)).toMatchObject([{ status: "pending", attempts: 0 }]);
      await deliverPending(store, mubitStub().client, foreign.runId);
    }
  });

  it("sends at most LIMITS.maxDeliveriesPerTrigger rows per tick", async () => {
    const ns = namespace();
    const config = configFor(ns);
    const { runId } = await queue(config, ns, LIMITS.maxDeliveriesPerTrigger + 1, 5);
    expect(await trigger(config, mubitStub().client)).toEqual({ delivered: LIMITS.maxDeliveriesPerTrigger, failed: 0 });
    expect((await rows(runId)).filter((r) => r.status === "pending")).toHaveLength(1);
    expect(await trigger(config, mubitStub().client)).toEqual({ delivered: 1, failed: 0 });
  });

  it("sends each row once when a feedback request and the trigger overlap", async () => {
    const ns = namespace();
    const config = configFor(ns);
    const { runId, keys } = await queue(config, ns, 3, 5);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = mubitStub({ hold: gate });
    const feedback = deliverPending(store, slow.client, runId);
    const scheduled = trigger(config, slow.client);
    try {
      // Both senders are inside a send at the same time, each holding a different row.
      await vi.waitFor(() => expect(slow.sent).toHaveLength(2), { timeout: 5_000 });
    } finally {
      release();
    }
    const [a, b] = await Promise.all([feedback, scheduled]);
    expect(a.delivered + b.delivered).toBe(3);
    expect(a.failed + b.failed).toBe(0);
    expect(slow.sent.sort()).toEqual(keys.sort());
    expect((await rows(runId)).map((r) => [r.status, r.attempts])).toEqual([["delivered", 1], ["delivered", 1], ["delivered", 1]]);
  });

  it("survives a connection that drops while it waits on Mubit, and leaves the row to the next sender", async () => {
    const ns = namespace();
    const config = configFor(ns);
    const { runId, keys } = await queue(config, ns, 1, 5);
    const uncaught: unknown[] = [];
    const record = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", record);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = mubitStub({ hold: gate });
    try {
      const sending = deliverPending(store, slow.client, undefined, { due: { tenantId: config.tenantId, calibrationNamespace: ns } }).then(
        () => "finished",
        (error: Error) => error.message,
      );
      await vi.waitFor(() => expect(slow.sent).toHaveLength(1), { timeout: 5_000 });
      // The connection that holds the row drops while the sender waits on Mubit (a restart, or the pooler closing it).
      const killed = await store.pool.query(
        `select pg_terminate_backend(l.pid) from pg_locks l join pg_class c on c.oid = l.relation
         where c.relname = 'learning_deliveries' and l.mode = 'RowShareLock' and l.pid <> pg_backend_pid()`,
      );
      expect(killed.rowCount).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 300)); // the client sees the close while no query is running
      release();
      expect(await sending).toMatch(/connection/i);
    } finally {
      release();
      process.off("uncaughtException", record);
    }
    expect(uncaught).toEqual([]);
    expect(await rows(runId)).toMatchObject([{ status: "pending", attempts: 0 }]);
    const next = mubitStub();
    expect(await deliverPending(store, next.client, runId)).toEqual({ delivered: 1, failed: 0 });
    expect(next.sent).toEqual(keys);
  });

  it("returns its connection to the pool without the error listener it added", async () => {
    const ns = namespace();
    const config = configFor(ns);
    await queue(config, ns, 2, 5);
    const listeners: number[] = [];
    const count = (_error: unknown, client: pg.PoolClient) => listeners.push(client.listenerCount("error"));
    store.pool.on("release", count);
    try {
      expect(await trigger(config, mubitStub().client)).toEqual({ delivered: 2, failed: 0 });
    } finally {
      store.pool.off("release", count);
    }
    // The pool's own idle listener is the only one left on every connection it gets back.
    expect(listeners.length).toBeGreaterThan(0);
    expect(new Set(listeners)).toEqual(new Set([1]));
  });
});
