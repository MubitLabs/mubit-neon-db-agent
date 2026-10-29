import OpenAI from "openai";
import type { ChatCompletionMessage, ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { LIMITS, type Config } from "./config.js";
import type { Lesson, Outcome, Scope, Usage } from "./types.js";

/** Everything Mubit-specific lives in this file. The agent only sees the MubitClient interface. */

export type ModelCall = {
  model: string;
  messages: ChatCompletionMessageParam[];
  tools: ChatCompletionTool[];
  responseFormat: Config["responseFormat"];
  jsonSchema: Record<string, unknown>;
  sessionId: string;
  /** "none" on the last allowed turn: the model must answer from the evidence it has. */
  toolChoice: "auto" | "none";
  /** "metadata" keeps evaluation calls out of Mubit's kept examples (x-middleware-record). */
  record: "full" | "metadata";
  signal: AbortSignal;
};

export type ToolCall = { id: string; name: string; arguments: string };

export type ModelReply = {
  message: ChatCompletionMessage;
  toolCalls: ToolCall[];
  usage: Usage;
  requestId: string | null;
  servedModel: string | null;
  finishReason: string | null;
  attempts: number;
};

export type ExcludedLesson = { id: string; kind: Lesson["kind"]; schemaVersion: string; reason: string; text: string };

export type RecallResult = {
  lessons: Lesson[];
  /** Lessons that came back but do not apply here (another schema, missing identifiers), shown as obsolete mappings. */
  excluded?: ExcludedLesson[];
  status: "ok" | "empty" | "degraded" | "off";
  reason?: string;
  injectionId?: string | null;
  received: number;
};

export type Capabilities = {
  calibration: boolean;
  calibrationBackend: Config["calibrationBackend"];
  outcomeUpload: boolean;
  evaluationIsolation: boolean;
  notes: string[];
};

export interface MubitClient {
  capabilities(): Promise<Capabilities>;
  complete(call: ModelCall): Promise<ModelReply>;
  recall(scope: Scope, question: string, identifiers: Set<string>): Promise<RecallResult>;
  remember(lesson: Lesson, idempotencyKey: string): Promise<void>;
  report(outcome: Outcome, idempotencyKey: string): Promise<void>;
}

export class MubitError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly requestId: string | null = null,
  ) {
    super(message);
  }
}

// ── Lesson encoding ─────────────────────────────────────────────────────────────────────────────────────────────
// A lesson travels as text. Its first line carries the scope, so a lesson read back from Mubit (as a person approved
// it) can still be checked against the tenant, database, namespace and schema before it reaches the model.

const HEADER = "[acme-db-agent lesson]";

type LessonHeader = {
  v: 1;
  id: string;
  kind: Lesson["kind"];
  db: string;
  ns: string;
  semver: string;
  schema: string;
  schemaVersion: string;
  ids: string[];
  ev: string[];
  sup?: string;
};

export function encodeLesson(lesson: Lesson): string {
  const header: LessonHeader = {
    v: 1,
    id: lesson.id,
    kind: lesson.kind,
    db: lesson.scope.databaseId,
    ns: lesson.scope.calibrationNamespace,
    semver: lesson.scope.semanticVersion,
    schema: lesson.scope.schemaHash,
    schemaVersion: lesson.scope.schemaVersion,
    ids: lesson.identifiers,
    ev: lesson.evidenceIds,
    ...(lesson.supersedesId ? { sup: lesson.supersedesId } : {}),
  };
  return `${HEADER} ${JSON.stringify(header)}\n${lesson.text}`;
}

export function decodeLesson(text: string, scope: Scope, remoteId?: string): Lesson | null {
  const at = text.indexOf(HEADER);
  if (at < 0) return null;
  const rest = text.slice(at + HEADER.length).trimStart();
  const newline = rest.indexOf("\n");
  if (newline < 0) return null;
  let h: LessonHeader;
  try {
    h = JSON.parse(rest.slice(0, newline)) as LessonHeader;
  } catch {
    return null;
  }
  if (h.v !== 1 || !h.id || !["semantic", "schema", "procedure"].includes(h.kind)) return null;
  return {
    id: h.id,
    kind: h.kind,
    text: rest.slice(newline + 1).trim(),
    scope: { ...scope, databaseId: h.db, calibrationNamespace: h.ns, semanticVersion: h.semver, schemaHash: h.schema, schemaVersion: h.schemaVersion },
    evidenceIds: Array.isArray(h.ev) ? h.ev : [],
    verification: "verified",
    identifiers: Array.isArray(h.ids) ? h.ids : [],
    ...(h.sup ? { supersedesId: h.sup } : {}),
    source: "mubit",
    ...(remoteId ? { remoteId } : {}),
  };
}

/**
 * The compatibility rules. Semantic lessons need the same database and contract; schema lessons need the exact schema
 * hash; procedure lessons need every identifier they name to exist now. Superseded lessons drop out.
 */
export function isApplicable(l: Lesson, scope: Scope, identifiers: Set<string>): boolean {
  if (l.verification !== "verified") return false;
  if (l.scope.databaseId !== scope.databaseId || l.scope.calibrationNamespace !== scope.calibrationNamespace) return false;
  if (l.scope.semanticVersion !== scope.semanticVersion) return false;
  if (l.kind === "schema") return l.scope.schemaHash === scope.schemaHash;
  if (l.kind === "procedure") return l.identifiers.every((id) => identifiers.has(id));
  return true;
}

export function explainExcluded(candidates: Lesson[], scope: Scope, identifiers: Set<string>): ExcludedLesson[] {
  return candidates
    .filter((l) => !isApplicable(l, scope, identifiers))
    .map((l) => {
      let reason = "not verified";
      if (l.scope.databaseId !== scope.databaseId || l.scope.calibrationNamespace !== scope.calibrationNamespace) reason = "another database or namespace";
      else if (l.scope.semanticVersion !== scope.semanticVersion) reason = "another business contract";
      else if (l.kind === "schema" && l.scope.schemaHash !== scope.schemaHash) reason = `schema ${l.scope.schemaVersion} mapping; this database is ${scope.schemaVersion}`;
      else if (l.kind === "procedure") reason = `names ${l.identifiers.filter((id) => !identifiers.has(id)).join(", ")}, which this schema does not have`;
      return { id: l.id, kind: l.kind, schemaVersion: l.scope.schemaVersion, reason, text: l.text.slice(0, 400) };
    })
    .slice(0, 10);
}

export function selectApplicable(candidates: Lesson[], scope: Scope, identifiers: Set<string>): Lesson[] {
  const seen = new Set<string>();
  const compatible = candidates.filter((l) => {
    if (seen.has(l.id)) return false;
    seen.add(l.id);
    return isApplicable(l, scope, identifiers);
  });
  // Only a lesson that applies here can retire another, so a v2 mapping never hides v1's lessons from a v1 branch.
  const superseded = new Set(compatible.map((l) => l.supersedesId).filter(Boolean) as string[]);
  const ok = compatible.filter((l) => !superseded.has(l.id));
  const rank = { schema: 0, procedure: 1, semantic: 2 } as const;
  ok.sort((a, b) => rank[a.kind] - rank[b.kind]);
  const out: Lesson[] = [];
  let tokens = 0;
  for (const l of ok) {
    const cost = Math.ceil(l.text.length / 4) + 20;
    if (out.length >= LIMITS.recallMaxLessons || tokens + cost > LIMITS.recallTokenBudget) continue;
    out.push(l);
    tokens += cost;
  }
  return out;
}

/** Some upstream models (Gemini through the Neon AI Gateway) answer with content as an array of text parts. */
export function contentText(content: unknown): string | null {
  if (content === null || content === undefined) return null;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === "string" ? p : typeof (p as { text?: unknown })?.text === "string" ? (p as { text: string }).text : "")).join("");
  }
  return String(content);
}

// ── The client ─────────────────────────────────────────────────────────────────────────────────────────────────

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    }, { once: true });
  });

function classify(error: unknown): MubitError {
  if (error instanceof MubitError) return error;
  const e = error as { status?: number; message?: string; headers?: Headers | Record<string, string>; name?: string };
  const status = typeof e.status === "number" ? e.status : null;
  const headers = e.headers;
  const requestId =
    headers instanceof Headers ? headers.get("x-middleware-request-id") : (headers?.["x-middleware-request-id"] ?? null);
  const retryable = status === null ? e.name !== "AbortError" && !/aborted/i.test(e.message ?? "") : status === 429 || status >= 500;
  return new MubitError((e.message ?? "model call failed").slice(0, 300), status, retryable, requestId);
}

export function createMubitClient(config: Config): MubitClient {
  const openai = new OpenAI({
    apiKey: config.mubitApiKey ?? "missing",
    baseURL: config.mubitConnectUrl,
    maxRetries: 0, // the app retries, so retries never multiply
    timeout: LIMITS.modelTimeoutMs,
  });

  async function mubitPost(path: string, body: unknown, signal?: AbortSignal): Promise<{ status: number; json: unknown; requestId: string | null }> {
    const res = await fetch(`${config.mubitApiOrigin}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.mubitApiKey ?? ""}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text.slice(0, 300) };
    }
    return { status: res.status, json, requestId: res.headers.get("x-middleware-request-id") };
  }

  const lessonRunId = `acme-db-agent-${config.calibrationNamespace}`;

  return {
    async capabilities() {
      const notes: string[] = [];
      let calibration = false;
      if (config.calibrationBackend === "mubit") {
        try {
          const res = await fetch(`${config.mubitApiOrigin}/v2/core/health`, { headers: { authorization: `Bearer ${config.mubitApiKey ?? ""}` }, signal: AbortSignal.timeout(10_000) });
          calibration = res.status === 200;
          notes.push(`calibration endpoints answered ${res.status}`);
        } catch (error) {
          notes.push(`calibration endpoints unreachable: ${(error as Error).message.slice(0, 120)}`);
        }
      }
      return {
        calibration,
        calibrationBackend: config.calibrationBackend,
        outcomeUpload: config.calibrationBackend === "mubit",
        evaluationIsolation: true,
        notes,
      };
    },

    async complete(call) {
      let attempt = 0;
      for (;;) {
        attempt += 1;
        try {
          const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
            model: call.model,
            messages: call.messages,
            tools: call.tools,
            tool_choice: call.toolChoice,
          };
          if (call.responseFormat === "json_schema") {
            body.response_format = { type: "json_schema", json_schema: { name: "answer", strict: true, schema: call.jsonSchema } };
          } else if (call.responseFormat === "json_object") {
            body.response_format = { type: "json_object" };
          }
          if (config.sendSessionMetadata) (body as unknown as { metadata: Record<string, string> }).metadata = { session_id: call.sessionId };
          const { data, response } = await openai.chat.completions
            .create(body, { signal: call.signal, headers: { "x-middleware-record": call.record } })
            .withResponse();
          const choice = data.choices[0];
          if (!choice) throw new MubitError("the model returned no choices", 502, true, response.headers.get("x-middleware-request-id"));
          choice.message.content = contentText(choice.message.content);
          const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).flatMap((t) =>
            t.type === "function" ? [{ id: t.id, name: t.function.name, arguments: t.function.arguments }] : [],
          );
          return {
            message: choice.message,
            toolCalls,
            usage: { inputTokens: data.usage?.prompt_tokens ?? null, outputTokens: data.usage?.completion_tokens ?? null },
            requestId: response.headers.get("x-middleware-request-id"),
            servedModel: typeof data.model === "string" && data.model ? data.model : null,
            finishReason: choice.finish_reason ?? null,
            attempts: attempt,
          };
        } catch (error) {
          const e = classify(error);
          if (!e.retryable || attempt > LIMITS.maxModelRetries || call.signal.aborted) throw e;
          const retryAfter = Number((error as { headers?: Headers }).headers?.get?.("retry-after") ?? NaN);
          const wait = Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 5_000) : 400 * attempt + Math.random() * 400;
          await sleep(wait, call.signal);
        }
      }
    },

    async recall(scope, question, identifiers) {
      if (config.calibrationBackend === "off") return { lessons: [], status: "off", received: 0 };
      try {
        // Semantic search over this namespace's calibration run. The key's project scopes it on Mubit's side, and the
        // lesson header scopes it again here (database, namespace, contract, schema).
        const r = await mubitPost("/v2/core/search", { query: question.slice(0, 2_000), run_id: lessonRunId, limit: 20 });
        if (r.status !== 200) return { lessons: [], status: "degraded", reason: `calibration search answered ${r.status}`, received: 0 };
        const hits = Array.isArray(r.json) ? (r.json as { metadata?: { content?: string; id?: string }; content?: string; id?: unknown }[]) : [];
        const candidates = hits
          .map((h) => decodeLesson(String(h.metadata?.content ?? h.content ?? ""), scope, String(h.metadata?.id ?? h.id ?? "")))
          .filter((l): l is Lesson => l !== null);
        const lessons = selectApplicable(candidates, scope, identifiers);
        return {
          lessons,
          excluded: explainExcluded(candidates, scope, identifiers),
          status: lessons.length ? "ok" : "empty",
          received: hits.length,
        };
      } catch (error) {
        return { lessons: [], status: "degraded", reason: (error as Error).message.slice(0, 160), received: 0 };
      }
    },

    async remember(lesson, idempotencyKey) {
      if (config.calibrationBackend === "off") return;
      const r = await mubitPost("/v2/control/ingest", {
        run_id: lessonRunId,
        agent_id: config.mubitAgentId,
        idempotency_key: idempotencyKey,
        parallel: false,
        items: [
          {
            item_id: lesson.id,
            content_type: "text",
            text: encodeLesson(lesson),
            intent: "fact",
            metadata_json: JSON.stringify({ kind: lesson.kind, evidence: lesson.evidenceIds, schema: lesson.scope.schemaHash, source: "acme-db-agent" }),
          },
        ],
      });
      if (r.status < 200 || r.status >= 300) throw new MubitError(`calibration ingest answered ${r.status}`, r.status, r.status >= 500 || r.status === 429, r.requestId);
    },

    async report(outcome, idempotencyKey) {
      if (config.calibrationBackend !== "mubit") return;
      const verified = outcome.verification === "verified";
      const r = await mubitPost("/v2/control/outcome", {
        run_id: lessonRunId,
        reference_id: "", // a run-level outcome: Mubit refuses a reference to an entry this app did not create
        outcome: verified ? "success" : "failure",
        signal: verified ? 1 : -1,
        rationale: `${outcome.source}: ${outcome.reason ?? outcome.verification} (evidence ${outcome.evidenceIds.join(", ")}; key ${idempotencyKey})`.slice(0, 500),
        idempotency_key: idempotencyKey, // Mubit applies an outcome once per key, so a resend after a lost reply is harmless
      });
      if (r.status < 200 || r.status >= 300) throw new MubitError(`outcome report answered ${r.status}`, r.status, r.status >= 500 || r.status === 429, r.requestId);
    },
  };
}
