import { timingSafeEqual } from "node:crypto";
import { parseTriggerDelivery } from "@neon/functions/triggers";
import { runAgent, RunConflict } from "./agent.js";
import type { App } from "./app.js";
import { LIMITS } from "./config.js";
import { deliverPending, verifyRun } from "./learning.js";
import { AskInputSchema, FeedbackSchema } from "./types.js";

/** The path the schedule trigger in neon.ts posts to. */
export const TRIGGER_PATH = "/triggers/deliveries";

/** Requests in flight on this instance; beyond LIMITS.maxConcurrentRuns, POST /runs answers 429. */
let inFlight = 0;

const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });

function authorized(request: Request, token: string | undefined): boolean {
  if (!token) return false;
  const header = request.headers.get("authorization") ?? "";
  const given = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > LIMITS.maxBodyBytes) throw new HttpError(413, "the request body is too large");
  const text = await request.text();
  if (Buffer.byteLength(text) > LIMITS.maxBodyBytes) throw new HttpError(413, "the request body is too large");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "the body is not JSON");
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** The whole HTTP surface. No request input names a tenant, branch, Mubit project or calibration namespace. */
export async function handle(request: Request, app: App): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  try {
    if (request.method === "GET" && path === "/health") {
      return json(200, { ok: true, service: "mubit-neon-db-agent", environments: app.config.environments.length });
    }
    // The schedule trigger's only route. Neon posts it without the bearer token; Neon's proxy strips x-neon-* headers
    // from client requests, so parseTriggerDelivery's header check proves the delivery. No other route accepts it.
    if (request.method === "POST" && path === TRIGGER_PATH) {
      const parsed = await parseTriggerDelivery(request);
      if (!parsed.ok) return json(parsed.error === "invalid_body" ? 400 : 401, { error: parsed.error });
      if (parsed.invocation.type !== "schedule") return json(400, { error: "not a schedule delivery" });
      const due = { tenantId: app.config.tenantId, calibrationNamespace: app.config.calibrationNamespace };
      const counts = await deliverPending(app.store, app.mubit, undefined, { due });
      console.log(`[trigger] ${parsed.invocation.trigger.name}: delivered ${counts.delivered}, failed ${counts.failed}`);
      return json(200, counts);
    }
    if (!authorized(request, app.config.demoAccessToken)) return json(401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });

    if (request.method === "GET" && path === "/environments") {
      const caps = await app.capabilities().catch(() => null);
      return json(200, {
        calibrationBackend: app.config.calibrationBackend,
        model: app.config.baseModel ?? null,
        route: app.config.mubitConnectUrl,
        capabilities: caps,
        environments: app.config.environments.map((e) => ({
          id: e.id,
          label: e.label,
          configured: Boolean(e.readerUrl),
          modes: e.modes.map((m) => ({ mode: m, available: true })),
        })),
      });
    }

    if (request.method === "POST" && path === "/runs") {
      const parsed = AskInputSchema.safeParse(await readJson(request));
      if (!parsed.success) return json(400, { error: "invalid request", issues: parsed.error.issues.map((i) => i.path.join(".") || i.message) });
      const input = parsed.data;
      const env = app.environment(input.environmentId);
      if (!env || !env.readerUrl) return json(400, { error: "unknown environment" });
      if (!env.modes.includes(input.mode)) return json(400, { error: "mode not enabled for this environment" });
      if (inFlight >= LIMITS.maxConcurrentRuns) return json(429, { error: "too many runs in progress; retry shortly" }, { "retry-after": "5" });
      inFlight += 1;
      try {
        const outcome = await runAgent(input, {
          config: app.config,
          store: app.store,
          mubit: app.mubit,
          environment: env,
          readerPool: app.readerPool(env),
        });
        return json(outcome.status === "running" ? 202 : 200, outcome);
      } catch (error) {
        if (error instanceof RunConflict) return json(409, { error: error.message });
        throw error;
      } finally {
        inFlight -= 1;
      }
    }

    const runMatch = /^\/runs\/(run_[a-f0-9]{16})(\/feedback)?$/.exec(path);
    if (runMatch && request.method === "GET" && !runMatch[2]) {
      const found = await app.store.getRun(app.config.tenantId, runMatch[1]!);
      return found ? json(200, found) : json(404, { error: "run not found" });
    }
    if (runMatch && request.method === "POST" && runMatch[2]) {
      const parsed = FeedbackSchema.safeParse(await readJson(request));
      if (!parsed.success) return json(400, { error: "invalid feedback" });
      const found = await app.store.getRun(app.config.tenantId, runMatch[1]!);
      if (!found) return json(404, { error: "run not found" });
      const verification = parsed.data.verdict === "correct" ? "verified" : "rejected";
      const { lessons } = await verifyRun(
        app.store,
        app.config.tenantId,
        runMatch[1]!,
        { verification, source: "reviewer", ...(parsed.data.reason ? { reason: parsed.data.reason } : {}) },
        { learn: true },
      );
      const delivery = await deliverPending(app.store, app.mubit, runMatch[1]!);
      return json(200, { verification, lessons: lessons.map((l) => ({ id: l.id, kind: l.kind, text: l.text })), delivery, calibrationBackend: app.config.calibrationBackend });
    }

    if (request.method === "GET" && path === "/runs") {
      const runs = await app.store.recentRuns(app.config.tenantId, 25);
      return json(200, { runs: runs.map((r) => ({ id: r.id, environmentId: r.environment_id, mode: r.mode, question: r.question, status: r.status, verification: r.verification, startedAt: r.started_at })) });
    }
    return json(404, { error: "not found" });
  } catch (error) {
    if (error instanceof HttpError) return json(error.status, { error: error.message });
    console.error("[http]", (error as Error).message);
    return json(500, { error: "internal error" });
  }
}
