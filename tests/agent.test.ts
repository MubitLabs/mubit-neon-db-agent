import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAgent, RunConflict, validateFinal } from "../src/agent.js";
import type { App } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { closePools, poolFor } from "../src/db.js";
import { handle } from "../src/http.js";
import { deliverPending, verifyRun } from "../src/learning.js";
import type { MubitClient, ModelCall, ModelReply } from "../src/mubit.js";
import { initSqlPolicy } from "../src/sqlpolicy.js";
import { createStore } from "../src/store.js";
import type { Lesson } from "../src/types.js";
import { hasDb, LOCAL } from "./helpers.js";

type Script = (call: ModelCall, turn: number) => Partial<ModelReply> & { content?: string; tools?: { name: string; args: unknown }[] };

/** The Mubit client for loop tests: each turn reads the conversation so far and answers from a script, so the tests are deterministic. */
function scriptedMubit(script: Script, opts: { failRemember?: number } = {}) {
  let turn = 0;
  let failures = opts.failRemember ?? 0;
  const remembered: string[] = [];
  const reported: string[] = [];
  const client: MubitClient = {
    capabilities: async () => ({ calibration: true, calibrationBackend: "mubit", outcomeUpload: true, evaluationIsolation: true, notes: [] }),
    complete: async (call) => {
      turn += 1;
      const s = script(call, turn);
      const toolCalls = (s.tools ?? []).map((t, i) => ({ id: `call_${turn}_${i}`, name: t.name, arguments: JSON.stringify(t.args) }));
      return {
        message: {
          role: "assistant",
          content: s.content ?? null,
          refusal: null,
          ...(toolCalls.length ? { tool_calls: toolCalls.map((t) => ({ id: t.id, type: "function" as const, function: { name: t.name, arguments: t.arguments } })) } : {}),
        },
        toolCalls,
        usage: { inputTokens: 100, outputTokens: 10 },
        requestId: `mreq_test${turn}`,
        servedModel: "system.ai.test-model",
        finishReason: toolCalls.length ? "tool_calls" : "stop",
        attempts: 1,
      } as ModelReply;
    },
    recall: async () => ({ lessons: [] as Lesson[], status: "empty", received: 0 }),
    remember: async (lesson) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("calibration endpoint down");
      }
      remembered.push(lesson.id);
    },
    report: async (o) => {
      reported.push(o.runId);
    },
  };
  return { client, remembered, reported };
}

const lastQueryId = (call: ModelCall): string | undefined => {
  for (const m of [...call.messages].reverse()) {
    if (m.role === "tool" && typeof m.content === "string") {
      const id = (JSON.parse(m.content) as { queryId?: string }).queryId;
      if (id) return id;
    }
  }
  return undefined;
};

const answer = (queryId: string | undefined) =>
  JSON.stringify({ status: "answered", text: "Done.", evidenceQueryIds: queryId ? [queryId] : [], resultQueryId: queryId ?? "", assumptions: [], clarification: "" });

describe.skipIf(!hasDb)("the agent loop", () => {
  let app: Pick<App, "config" | "store">;
  beforeAll(async () => {
    await initSqlPolicy();
    const config = { ...loadConfig({ ...process.env, BASE_MODEL: "test-model", CALIBRATION_BACKEND: "mubit", DEMO_ACCESS_TOKEN: "test-token-0123456789" }) };
    config.environments = config.environments.map((e) => ({ ...e, readerUrl: e.id === "demo-v1" ? LOCAL.reader : LOCAL.readerV2, evalUrl: e.id === "demo-v1" ? LOCAL.owner : LOCAL.ownerV2 }));
    app = { config, store: createStore(poolFor(LOCAL.control!, 2)) };
  });
  afterAll(() => closePools());

  const deps = (mubit: MubitClient, extra: Record<string, unknown> = {}) => ({
    config: app.config,
    store: app.store,
    mubit,
    environment: app.config.environments[0]!,
    readerPool: poolFor(LOCAL.reader!),
    ...extra,
  });
  const ask = (question = "How many completed orders are there?") => ({ environmentId: "demo-v1", mode: "calibration" as const, question, idempotencyKey: `test-${randomUUID()}` });

  it("discovers, queries and answers with evidence from this run", async () => {
    const { client } = scriptedMubit((call, turn) => {
      if (turn === 1) return { tools: [{ name: "list_tables", args: {} }] };
      if (turn === 2) return { tools: [{ name: "query", args: { sql: "select count(*) as n from orders where status = $1", params: ["completed"] } }] };
      return { content: answer(lastQueryId(call)) };
    });
    const out = await runAgent(ask(), deps(client));
    expect(out.status).toBe("answered");
    expect(out.verification).toBe("execution_only");
    const found = await app.store.getRun(app.config.tenantId, out.runId);
    expect(found!.events.map((e) => e.kind)).toEqual(expect.arrayContaining(["context", "model_reply", "tool_result", "answer", "finished"]));
    expect(found!.events.map((e) => e.sequence)).toEqual(found!.events.map((_, i) => i + 1));
  });

  it("recovers from a SQL error", async () => {
    const { client } = scriptedMubit((call, turn) => {
      if (turn === 1) return { tools: [{ name: "query", args: { sql: "select nope from orders", params: [] } }] };
      if (turn === 2) return { tools: [{ name: "query", args: { sql: "select count(*) from orders", params: [] } }] };
      return { content: answer(lastQueryId(call)) };
    });
    const out = await runAgent(ask(), deps(client));
    expect(out.status).toBe("answered");
  });

  it("refuses an answer that cites a failed query, asks once, then abstains", async () => {
    const { client } = scriptedMubit((call, turn) => {
      if (turn === 1) return { tools: [{ name: "query", args: { sql: "select nope from orders", params: [] } }] };
      return { content: answer(lastQueryId(call)) };
    });
    const out = await runAgent(ask(), deps(client));
    expect(out.status).toBe("abstained");
  });

  it("allows one format correction", async () => {
    const { client } = scriptedMubit((call, turn) => {
      if (turn === 1) return { tools: [{ name: "query", args: { sql: "select 1", params: [] } }] };
      if (turn === 2) return { content: "the answer is one" };
      return { content: answer(lastQueryId(call)) };
    });
    expect((await runAgent(ask(), deps(client))).status).toBe("answered");
  });

  it("returns an error for an unknown tool and keeps going", async () => {
    const { client } = scriptedMubit((call, turn) => {
      if (turn === 1) return { tools: [{ name: "drop_database", args: {} }] };
      if (turn === 2) return { tools: [{ name: "query", args: { sql: "select 1", params: [] } }] };
      return { content: answer(lastQueryId(call)) };
    });
    const out = await runAgent(ask(), deps(client));
    const found = await app.store.getRun(app.config.tenantId, out.runId);
    expect(JSON.stringify(found!.events)).toContain("unknown_tool");
    expect(out.status).toBe("answered");
  });

  it("forces an answer on the last turn instead of looping", async () => {
    let lastChoice = "";
    const { client } = scriptedMubit((call) => {
      lastChoice = call.toolChoice;
      if (call.toolChoice === "none") return { content: JSON.stringify({ status: "abstained", text: "Not enough evidence.", evidenceQueryIds: [], resultQueryId: "", assumptions: [], clarification: "" }) };
      return { tools: [{ name: "list_tables", args: {} }] };
    });
    const out = await runAgent(ask(), deps(client));
    expect(lastChoice).toBe("none");
    expect(out.status).toBe("abstained");
  });

  it("returns the stored run for a repeated key, and refuses the key for another question", async () => {
    const { client } = scriptedMubit((call, turn) => (turn === 1 ? { tools: [{ name: "query", args: { sql: "select 1", params: [] } }] } : { content: answer(lastQueryId(call)) }));
    const input = ask();
    const first = await runAgent(input, deps(client));
    const again = await runAgent(input, deps(client));
    expect(again.reused).toBe(true);
    expect(again.runId).toBe(first.runId);
    await expect(runAgent({ ...input, question: "something else" }, deps(client))).rejects.toBeInstanceOf(RunConflict);
  });

  it("keeps a failed calibration delivery pending and delivers it once on retry", async () => {
    const { client } = scriptedMubit((call, turn) => (turn === 1 ? { tools: [{ name: "query", args: { sql: "select count(*) as n from orders", params: [] } }] } : { content: answer(lastQueryId(call)) }));
    const out = await runAgent(ask(), deps(client));
    const flaky = scriptedMubit(() => ({}), { failRemember: 5 });
    await verifyRun(app.store, app.config.tenantId, out.runId, { verification: "verified", source: "reviewer" }, { learn: true });
    const first = await deliverPending(app.store, flaky.client, out.runId);
    expect(first.failed).toBeGreaterThan(0);
    const healthy = scriptedMubit(() => ({}));
    const second = await deliverPending(app.store, healthy.client, out.runId);
    expect(second.failed).toBe(0);
    await verifyRun(app.store, app.config.tenantId, out.runId, { verification: "verified", source: "reviewer" }, { learn: true });
    const third = await deliverPending(app.store, healthy.client, out.runId);
    expect(third.delivered).toBe(0); // the same lesson keys are not queued twice
    expect(new Set(healthy.remembered).size).toBe(healthy.remembered.length);
  });

  it("never derives lessons from an evaluation run", async () => {
    const { client } = scriptedMubit((call, turn) => (turn === 1 ? { tools: [{ name: "query", args: { sql: "select 1", params: [] } }] } : { content: answer(lastQueryId(call)) }));
    const out = await runAgent(ask(), deps(client, { evaluation: true }));
    const { lessons, deliveries } = await verifyRun(app.store, app.config.tenantId, out.runId, { verification: "verified", source: "reference" }, { learn: true });
    expect(lessons).toHaveLength(0);
    expect(deliveries).toHaveLength(0);
  });

  it("serves the HTTP surface with a bearer token and validated input", async () => {
    const { client } = scriptedMubit((call, turn) => (turn === 1 ? { tools: [{ name: "query", args: { sql: "select 1", params: [] } }] } : { content: answer(lastQueryId(call)) }));
    const httpApp = {
      ...app,
      mubit: client,
      capabilities: () => client.capabilities(),
      environment: (id: string) => app.config.environments.find((e) => e.id === id),
      readerPool: () => poolFor(LOCAL.reader!),
      evalPool: () => poolFor(LOCAL.owner!),
    } as unknown as App;
    const req = (path: string, init: RequestInit = {}, token = "test-token-0123456789") =>
      handle(new Request(`http://x${path}`, { ...init, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) } }), httpApp);
    expect((await req("/health", {}, "")).status).toBe(200);
    expect((await req("/environments", {}, "")).status).toBe(401);
    expect((await req("/environments", {}, "wrong-token-000000000")).status).toBe(401);
    expect((await req("/environments")).status).toBe(200);
    const body = { environmentId: "demo-v1", mode: "calibration", question: "How many orders?", idempotencyKey: `http-${randomUUID()}` };
    expect((await req("/runs", { method: "POST", body: JSON.stringify({ ...body, tenantId: "evil" }) })).status).toBe(400);
    expect((await req("/runs", { method: "POST", body: JSON.stringify({ ...body, environmentId: "prod" }) })).status).toBe(400);
    const ok = await req("/runs", { method: "POST", body: JSON.stringify(body) });
    expect(ok.status).toBe(200);
    const run = (await ok.json()) as { runId: string };
    expect((await req(`/runs/${run.runId}`)).status).toBe(200);
    expect((await req("/runs", { method: "POST", body: JSON.stringify({ ...body, question: "different" }) })).status).toBe(409);
  });
});

describe("final answer validation", () => {
  it("requires JSON that matches the format", () => {
    expect(validateFinal("not json", new Map()).ok).toBe(false);
    expect(validateFinal('{"status":"answered"}', new Map()).ok).toBe(false);
  });
  it("accepts an abstention without evidence", () => {
    const v = validateFinal(JSON.stringify({ status: "abstained", text: "No data.", evidenceQueryIds: [], resultQueryId: "", assumptions: [], clarification: "" }), new Map());
    expect(v.ok).toBe(true);
  });
  it("refuses an answer citing a query that never ran", () => {
    expect(validateFinal(answer("q_missing"), new Map()).ok).toBe(false);
  });
});
