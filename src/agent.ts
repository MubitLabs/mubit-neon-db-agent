import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type pg from "pg";
import { LIMITS, type Config, type EnvironmentConfig } from "./config.js";
import { describeTable, isFailure, listTables, readSchemaSignature, runAgentQuery, type ExecutedQuery, type SchemaSignature } from "./db.js";
import type { ExcludedLesson, MubitClient, ModelReply, ToolCall } from "./mubit.js";
import { buildUserContext, PROMPT_VERSION, SYSTEM_INSTRUCTIONS, TOOLS } from "./prompt.js";
import type { RunRow, Store } from "./store.js";
import { MODEL_ANSWER_JSON_SCHEMA, ModelAnswerSchema, type Answer, type AskInput, type Lesson, type Scope, type Verification } from "./types.js";

export type AgentDeps = {
  config: Config;
  store: Store;
  mubit: MubitClient;
  environment: EnvironmentConfig;
  readerPool: pg.Pool;
  /** Evaluation runs keep their calls out of Mubit's training data and never write runtime calibration. */
  evaluation?: boolean;
};

export type RunOutcome = {
  runId: string;
  status: RunRow["status"];
  answer: Answer | null;
  verification: Verification;
  reused: boolean;
  error?: string;
};

type Counters = { turns: number; toolCalls: number; failedQueries: number; schemaRefreshes: number; corrections: number };

export class RunConflict extends Error {}

function parseJsonAnswer(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("the final message is not a JSON object");
  return JSON.parse(trimmed.slice(start, end + 1));
}

function toolMessage(callId: string, result: unknown): ChatCompletionMessageParam {
  let content = JSON.stringify(result);
  if (Buffer.byteLength(content) > LIMITS.maxToolOutputBytes) {
    content = JSON.stringify({ error: { code: "output_too_large", message: "the tool output is too large; narrow the request" } });
  }
  return { role: "tool", tool_call_id: callId, content };
}

/** Runs one question: a fresh conversation, a bounded tool loop, a validated answer. Every step is an event. */
export async function runAgent(input: AskInput, deps: AgentDeps): Promise<RunOutcome> {
  const { config, store, mubit, environment, readerPool } = deps;
  const claimed = await store.claim({
    tenantId: config.tenantId,
    environmentId: input.environmentId,
    mode: input.mode,
    question: input.question,
    idempotencyKey: input.idempotencyKey,
    evaluation: deps.evaluation ?? false,
  });
  if (claimed.kind === "conflict") throw new RunConflict("this idempotency key was used for a different request");
  if (claimed.kind === "existing") {
    const r = claimed.run;
    return { runId: r.id, status: r.status, answer: r.answer, verification: r.verification, reused: true, ...(r.error ? { error: r.error } : {}) };
  }
  const runId = claimed.run.id;
  const deadline = Date.now() + LIMITS.requestDeadlineMs;
  const abort = AbortSignal.timeout(LIMITS.requestDeadlineMs);
  let sequence = 0;
  const event = (kind: string, payload: unknown) => store.append(runId, ++sequence, kind, payload);
  const counters: Counters = { turns: 0, toolCalls: 0, failedQueries: 0, schemaRefreshes: 0, corrections: 0 };
  const usage = { inputTokens: 0 as number | null, outputTokens: 0 as number | null, modelCalls: 0 };
  const served = { requestedModel: config.baseModel ?? null, servedModels: new Set<string>(), requestIds: [] as string[], fallback: false as boolean };
  const queries = new Map<string, ExecutedQuery>();

  const finish = async (status: RunRow["status"], answer: Answer | null, error?: string): Promise<RunOutcome> => {
    const resultOk = answer?.resultQueryId ? queries.get(answer.resultQueryId) : undefined;
    const verification: Verification = status === "answered" && resultOk && !isFailure(resultOk) ? "execution_only" : "unverified";
    await store.finish(runId, {
      status,
      answer,
      servedIdentity: { requestedModel: served.requestedModel, servedModels: [...served.servedModels], requestIds: served.requestIds, fallback: served.fallback, promptVersion: PROMPT_VERSION },
      usage,
      verification,
      ...(error ? { error } : {}),
    });
    await event("finished", { status, verification, error: error ?? null, counters });
    return { runId, status, answer, verification, reused: false, ...(error ? { error } : {}) };
  };

  try {
    if (!config.baseModel) return await finish("failed", null, "BASE_MODEL is not configured");

    let signature: SchemaSignature = await readSchemaSignature(readerPool);
    const scopeOf = (sig: SchemaSignature): Scope => ({
      tenantId: config.tenantId,
      databaseId: config.logicalDatabaseId,
      environmentId: environment.id,
      calibrationNamespace: config.calibrationNamespace,
      semanticVersion: sig.semanticVersion,
      schemaHash: sig.hash,
      schemaVersion: sig.schemaVersion,
    });
    let scope = scopeOf(signature);

    let lessons: Lesson[] = [];
    let excluded: ExcludedLesson[] = [];
    let calibrationStatus = "off (baseline)";
    let calibrationNote = "None: this run uses no runtime calibration.";
    if (input.mode !== "baseline") {
      const recalled = await mubit.recall(scope, input.question, signature.identifiers);
      lessons = recalled.lessons;
      excluded = recalled.excluded ?? [];
      calibrationStatus = `${config.calibrationBackend}:${recalled.status}`;
      calibrationNote =
        recalled.status === "degraded"
          ? "None: runtime calibration could not be read for this run."
          : "None yet: no verified lesson applies to this database and schema.";
      await event("calibration_recall", {
        backend: config.calibrationBackend,
        status: recalled.status,
        reason: recalled.reason ?? null,
        received: recalled.received,
        injectionId: recalled.injectionId ?? null,
        used: lessons.map((l) => ({ id: l.id, kind: l.kind, source: l.source, remoteId: l.remoteId ?? null, schemaVersion: l.scope.schemaVersion, text: l.text })),
        excluded,
      });
    }
    await store.setScope(runId, { ...scope, identifiers: [...signature.identifiers].sort(), excludedLessonIds: excluded.map((e) => e.id) }, { connectUrl: config.mubitConnectUrl, model: config.baseModel, mode: input.mode, record: deps.evaluation ? "metadata" : "full", promptVersion: PROMPT_VERSION }, calibrationStatus);
    await event("context", { schemaVersion: signature.schemaVersion, schemaHash: signature.hash, semanticVersion: signature.semanticVersion, migrationId: signature.migrationId, lessons: lessons.length });

    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_INSTRUCTIONS },
      {
        role: "user",
        content: buildUserContext({ question: input.question, scope, contract: signature.contract, reportingClock: config.reportingClock, lessons, calibrationNote }),
      },
    ];

    while (counters.turns < LIMITS.maxTurns) {
      if (Date.now() > deadline - 2_000) return await finish("abstained", abstention("The investigation ran out of time."), "deadline");
      counters.turns += 1;
      const lastTurn = counters.turns === LIMITS.maxTurns || counters.toolCalls >= LIMITS.maxToolCalls;
      if (lastTurn) {
        messages.push({ role: "user", content: "This is your last turn. Do not call tools. Reply now with the JSON answer, using only the successful queries above, or abstain." });
        await event("final_turn", { turn: counters.turns, toolCalls: counters.toolCalls });
      }
      let reply: ModelReply;
      try {
        reply = await mubit.complete({
          model: config.baseModel,
          messages,
          tools: TOOLS,
          responseFormat: config.responseFormat,
          jsonSchema: MODEL_ANSWER_JSON_SCHEMA as unknown as Record<string, unknown>,
          sessionId: runId,
          toolChoice: lastTurn ? "none" : "auto",
          record: deps.evaluation ? "metadata" : "full",
          signal: abort,
        });
      } catch (error) {
        const e = error as { message?: string; status?: number | null; requestId?: string | null };
        await event("model_error", { status: e.status ?? null, requestId: e.requestId ?? null, message: e.message ?? "model call failed" });
        return await finish("failed", null, `model call failed: ${e.message ?? "unknown"}`);
      }
      usage.modelCalls += 1;
      usage.inputTokens = reply.usage.inputTokens === null || usage.inputTokens === null ? null : usage.inputTokens + reply.usage.inputTokens;
      usage.outputTokens = reply.usage.outputTokens === null || usage.outputTokens === null ? null : usage.outputTokens + reply.usage.outputTokens;
      if (reply.servedModel) served.servedModels.add(reply.servedModel);
      if (reply.requestId) served.requestIds.push(reply.requestId);
      await event("model_reply", {
        turn: counters.turns,
        requestId: reply.requestId,
        servedModel: reply.servedModel,
        finishReason: reply.finishReason,
        usage: reply.usage,
        attempts: reply.attempts,
        toolCalls: reply.toolCalls.map((t) => ({ id: t.id, name: t.name, arguments: t.arguments.slice(0, 4_000) })),
        content: (reply.message.content ?? "").slice(0, 4_000),
      });
      messages.push({
        role: "assistant",
        content: reply.message.content ?? null,
        ...(reply.message.tool_calls?.length ? { tool_calls: reply.message.tool_calls } : {}),
      } as ChatCompletionMessageParam);

      if (reply.toolCalls.length === 0) {
        const verdict = validateFinal(reply.message.content ?? "", queries);
        if (verdict.ok) {
          await event("answer", verdict.answer);
          return await finish(verdict.answer.status, verdict.answer);
        }
        await event("answer_invalid", { reason: verdict.reason });
        if (counters.corrections >= 1) return await finish("abstained", abstention(`No valid answer: ${verdict.reason}`), "invalid final answer");
        counters.corrections += 1;
        messages.push({ role: "user", content: `Your final message was not accepted: ${verdict.reason} Reply again with the JSON answer only.` });
        continue;
      }

      for (const call of reply.toolCalls) {
        if (Date.now() > deadline - 2_000) return await finish("abstained", abstention("The investigation ran out of time."), "deadline");
        counters.toolCalls += 1;
        const result =
          counters.toolCalls > LIMITS.maxToolCalls
            ? { error: { code: "budget_exhausted", message: "The tool-call budget is used up. Answer now with the evidence you have, or abstain." } }
            : await executeTool(call, { readerPool, signature, counters, queries });
        await event("tool_result", { callId: call.id, name: call.name, arguments: call.arguments.slice(0, 4_000), result });
        messages.push(toolMessage(call.id, result));

        const sqlstate = (result as { error?: { sqlstate?: string } }).error?.sqlstate;
        if ((sqlstate === "42P01" || sqlstate === "42703") && counters.schemaRefreshes < LIMITS.maxSchemaRefreshes) {
          counters.schemaRefreshes += 1;
          const fresh = await readSchemaSignature(readerPool);
          if (fresh.hash !== signature.hash) {
            const before = signature;
            signature = fresh;
            scope = scopeOf(fresh);
            const dropped = lessons.filter((l) => l.kind === "schema" || l.identifiers.some((id) => !fresh.identifiers.has(id)));
            lessons = lessons.filter((l) => !dropped.includes(l));
            await event("schema_refresh", { from: before.hash, to: fresh.hash, schemaVersion: fresh.schemaVersion, droppedLessons: dropped.map((l) => l.id) });
            messages.push({
              role: "user",
              content: `The database schema changed during this run (schema ${fresh.schemaVersion}, hash ${fresh.hash}). Lessons ${dropped.map((l) => l.id).join(", ") || "(none)"} no longer apply. Inspect the tables again before you query.`,
            });
          } else {
            await event("schema_refresh", { from: signature.hash, to: fresh.hash, unchanged: true });
          }
        }
      }
    }
    return await finish("abstained", abstention("The investigation limit was reached before a supported answer."), "turn limit");
  } catch (error) {
    const message = (error as Error).message ?? "run failed";
    await event("error", { message: message.slice(0, 400) }).catch(() => undefined);
    return await finish("failed", null, message.slice(0, 400)).catch(() => ({ runId, status: "failed" as const, answer: null, verification: "unverified" as const, reused: false, error: message }));
  }
}

function abstention(text: string): Answer {
  return { status: "abstained", text, evidenceQueryIds: [], assumptions: [] };
}

async function executeTool(
  call: ToolCall,
  ctx: { readerPool: pg.Pool; signature: SchemaSignature; counters: Counters; queries: Map<string, ExecutedQuery> },
): Promise<unknown> {
  let args: Record<string, unknown>;
  try {
    args = call.arguments.trim() ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
  } catch {
    return { error: { code: "bad_arguments", message: "the tool arguments are not valid JSON" } };
  }
  switch (call.name) {
    case "list_tables":
      return { tables: await listTables(ctx.readerPool) };
    case "describe_table": {
      if (typeof args.table !== "string") return { error: { code: "bad_arguments", message: "table must be a string" } };
      return describeTable(ctx.readerPool, args.table);
    }
    case "query": {
      if (typeof args.sql !== "string" || !args.sql.trim()) return { error: { code: "bad_arguments", message: "sql must be a non-empty string" } };
      const params = Array.isArray(args.params) ? args.params : [];
      if (params.some((p) => p !== null && !["string", "number", "boolean"].includes(typeof p))) {
        return { error: { code: "bad_arguments", message: "params must be scalars" } };
      }
      if (ctx.counters.failedQueries >= LIMITS.maxFailedQueries) {
        return { error: { code: "budget_exhausted", message: "Two queries have failed. Answer with the evidence you have, or abstain." } };
      }
      const q = await runAgentQuery(ctx.readerPool, args.sql, params.map((p) => (p === null ? null : String(p))), ctx.signature.relations);
      ctx.queries.set(q.queryId, q);
      if (isFailure(q)) {
        ctx.counters.failedQueries += 1;
        return { queryId: q.queryId, error: q.error };
      }
      return { queryId: q.queryId, columns: q.columns.map((c) => c.name), rows: q.rows, truncated: q.truncated, rowCount: q.rows.length, durationMs: q.durationMs };
    }
    default:
      return { error: { code: "unknown_tool", message: `there is no tool named ${call.name}` } };
  }
}

/** The final message must parse, and an answer must point at successful queries of this run. */
export function validateFinal(content: string, queries: Map<string, ExecutedQuery>): { ok: true; answer: Answer } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = parseJsonAnswer(content);
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  const v = ModelAnswerSchema.safeParse(parsed);
  if (!v.success) return { ok: false, reason: `the JSON does not match the answer format (${v.error.issues.map((i) => i.path.join(".") || i.message).slice(0, 3).join("; ")}).` };
  const a = v.data;
  const answer: Answer = {
    status: a.status,
    text: a.text,
    evidenceQueryIds: a.evidenceQueryIds,
    assumptions: a.assumptions,
    ...(a.resultQueryId ? { resultQueryId: a.resultQueryId } : {}),
    ...(a.clarification ? { clarification: a.clarification } : {}),
  };
  if (answer.status === "abstained") return { ok: true, answer };
  if (!answer.resultQueryId) return { ok: false, reason: "an answered status needs resultQueryId." };
  const ids = new Set([answer.resultQueryId, ...answer.evidenceQueryIds]);
  for (const id of ids) {
    const q = queries.get(id);
    if (!q) return { ok: false, reason: `query ${id} was not run in this conversation.` };
    if (isFailure(q)) return { ok: false, reason: `query ${id} failed, so it cannot support the answer.` };
  }
  const result = queries.get(answer.resultQueryId)!;
  if (!isFailure(result) && result.truncated) return { ok: false, reason: `query ${answer.resultQueryId} was truncated at ${LIMITS.maxRows} rows; aggregate or narrow it.` };
  if (!answer.evidenceQueryIds.includes(answer.resultQueryId)) answer.evidenceQueryIds = [...answer.evidenceQueryIds, answer.resultQueryId];
  return { ok: true, answer };
}
