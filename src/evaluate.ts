import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { runAgent } from "./agent.js";
import type { App } from "./app.js";
import { deliverPending, verifyRun } from "./learning.js";
import { PROMPT_VERSION } from "./prompt.js";
import type { Mode } from "./types.js";
import { buildCases, CASES_VERSION, templateOf, type EvalCase, type Split } from "../eval/cases.js";
import { answerAgrees, compareResult } from "../eval/compare.js";

export type CaseResult = {
  caseId: string;
  split: Split;
  intent: string;
  schemaVersion: string;
  mode: Mode;
  repetition: number;
  runId: string | null;
  status: string;
  exact: boolean;
  finalAnswerAgrees: boolean | null;
  reason: string;
  toolCalls: number;
  schemaCalls: number;
  failedQueries: number;
  inputTokens: number | null;
  outputTokens: number | null;
  wallMs: number;
  calibrationStatus: string | null;
  servedModels: string[];
};

type RunEvents = { kind: string; payload: { name?: string; result?: { queryId?: string; columns?: string[]; rows?: unknown[][]; truncated?: boolean; error?: unknown } } }[];

/** Runs the reference outside the agent, under the evaluation credential, on the same branch. */
async function reference(app: App, c: EvalCase): Promise<{ columns: string[]; rows: unknown[][] }> {
  const env = app.environment(c.environmentId);
  if (!env) throw new Error(`unknown environment ${c.environmentId}`);
  const ref = templateOf(c).reference(c.schemaVersion, c.params);
  const res = await app.evalPool(env).query({ text: ref.sql, values: ref.params, rowMode: "array" });
  return { columns: res.fields.map((f) => f.name), rows: res.rows as unknown[][] };
}

export async function runCase(app: App, c: EvalCase, mode: Mode, repetition: number, options: { learn: boolean }): Promise<CaseResult> {
  const env = app.environment(c.environmentId);
  if (!env) throw new Error(`unknown environment ${c.environmentId}`);
  const started = Date.now();
  const outcome = await runAgent(
    { environmentId: c.environmentId, mode, question: c.question, idempotencyKey: `eval-${randomUUID()}` },
    { config: app.config, store: app.store, mubit: app.mubit, environment: env, readerPool: app.readerPool(env), evaluation: !options.learn },
  );
  const wallMs = Date.now() - started;
  const found = await app.store.getRun(app.config.tenantId, outcome.runId);
  const events = (found?.events ?? []) as unknown as RunEvents;
  const toolEvents = events.filter((e) => e.kind === "tool_result");
  const usage = (found?.run.usage ?? {}) as { inputTokens?: number | null; outputTokens?: number | null };
  const served = (found?.run.served_identity ?? {}) as { servedModels?: string[] };
  const base = {
    caseId: c.id, split: c.split, intent: c.intent, schemaVersion: c.schemaVersion, mode, repetition, runId: outcome.runId, status: outcome.status,
    toolCalls: toolEvents.length,
    schemaCalls: toolEvents.filter((e) => e.payload.name === "list_tables" || e.payload.name === "describe_table").length,
    failedQueries: toolEvents.filter((e) => e.payload.name === "query" && e.payload.result?.error).length,
    inputTokens: usage.inputTokens ?? null, outputTokens: usage.outputTokens ?? null, wallMs,
    calibrationStatus: found?.run.calibration_status ?? null, servedModels: served.servedModels ?? [],
  };
  if (outcome.status !== "answered" || !outcome.answer?.resultQueryId) {
    if (options.learn) await verifyRun(app.store, app.config.tenantId, outcome.runId, { verification: "rejected", source: "reference", reason: `no answer (${outcome.status})` }, { learn: false });
    return { ...base, exact: false, finalAnswerAgrees: null, reason: outcome.error ?? outcome.status };
  }
  const actual = toolEvents.find((e) => e.payload.result?.queryId === outcome.answer!.resultQueryId)?.payload.result;
  if (!actual?.columns || !actual.rows) return { ...base, exact: false, finalAnswerAgrees: null, reason: "result query not found in the events" };
  const expected = await reference(app, c);
  const cmp = compareResult(templateOf(c).shape(c.params), expected, { columns: actual.columns, rows: actual.rows, truncated: Boolean(actual.truncated) });
  const agrees = answerAgrees(outcome.answer.text, expected);
  if (options.learn) {
    await verifyRun(app.store, app.config.tenantId, outcome.runId, { verification: cmp.exact ? "verified" : "rejected", source: "reference", reason: cmp.reason }, { learn: true });
    await deliverPending(app.store, app.mubit, outcome.runId);
  }
  return { ...base, exact: cmp.exact, finalAnswerAgrees: agrees, reason: cmp.reason };
}

function shuffle<T>(items: T[], seed: number): T[] {
  const a = [...items];
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export type EvalOptions = { split: Split; modes: Mode[]; repetitions: number; learn: boolean; limit?: number; seed: number };

export async function runEvaluation(app: App, options: EvalOptions, log: (line: string) => void) {
  const cases = buildCases().filter((c) => c.split === options.split).slice(0, options.limit ?? Infinity);
  const results: CaseResult[] = [];
  for (let rep = 1; rep <= options.repetitions; rep++) {
    const modes = shuffle(options.modes, options.seed + rep);
    for (const mode of modes) {
      for (const c of cases) {
        const r = await runCase(app, c, mode, rep, { learn: options.learn });
        results.push(r);
        log(`${rep}/${options.repetitions} ${mode.padEnd(8)} ${c.id.padEnd(34)} ${r.exact ? "EXACT" : "miss "} ${r.status.padEnd(9)} tools ${r.toolCalls} schema ${r.schemaCalls} ${r.wallMs} ms${r.exact ? "" : `  (${r.reason.slice(0, 90)})`}`);
      }
    }
  }
  let commit = "unknown";
  try {
    commit = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    // not a git checkout
  }
  const manifest = {
    createdAt: new Date().toISOString(),
    code: commit,
    casesVersion: CASES_VERSION,
    promptVersion: PROMPT_VERSION,
    split: options.split,
    modes: options.modes,
    repetitions: options.repetitions,
    learning: options.learn,
    recording: options.learn ? "full (learning phase)" : "x-middleware-record: metadata (no kept examples)",
    model: app.config.baseModel,
    route: app.config.mubitConnectUrl,
    calibrationBackend: app.config.calibrationBackend,
    calibrationNamespace: app.config.calibrationNamespace,
    seed: options.seed,
  };
  const id = `eval_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const summary = summarize(results);
  await app.store.saveEvaluation(id, manifest, { results, summary });
  return { id, manifest, results, summary };
}

export function summarize(results: CaseResult[]) {
  const byMode = new Map<string, CaseResult[]>();
  for (const r of results) byMode.set(r.mode, [...(byMode.get(r.mode) ?? []), r]);
  return [...byMode.entries()].map(([mode, rs]) => {
    const n = rs.length;
    const sum = (f: (r: CaseResult) => number) => rs.reduce((s, r) => s + f(r), 0);
    const known = rs.filter((r) => r.inputTokens !== null);
    const walls = rs.map((r) => r.wallMs).sort((a, b) => a - b);
    return {
      mode,
      runs: n,
      exact: sum((r) => (r.exact ? 1 : 0)),
      exactRate: n ? sum((r) => (r.exact ? 1 : 0)) / n : 0,
      v2Exact: rs.filter((r) => r.schemaVersion === "v2" && r.exact).length,
      v2Runs: rs.filter((r) => r.schemaVersion === "v2").length,
      abstained: rs.filter((r) => r.status === "abstained").length,
      failed: rs.filter((r) => r.status === "failed").length,
      invalidQueries: sum((r) => r.failedQueries),
      schemaCallsPerQuestion: n ? sum((r) => r.schemaCalls) / n : 0,
      toolCallsPerQuestion: n ? sum((r) => r.toolCalls) / n : 0,
      inputTokens: known.length === n ? sum((r) => r.inputTokens ?? 0) : null,
      outputTokens: known.length === n ? sum((r) => r.outputTokens ?? 0) : null,
      medianWallMs: walls.length ? walls[Math.floor(walls.length / 2)]! : 0,
    };
  });
}

export function markdownTable(summary: ReturnType<typeof summarize>): string {
  const lines = [
    "| Mode | Exact | v2 exact | Abstained | Failed | Invalid SQL | Schema calls/q | Tool calls/q | Tokens in/out | Median wall |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const s of summary) {
    lines.push(
      `| ${s.mode} | ${s.exact}/${s.runs} (${(s.exactRate * 100).toFixed(0)}%) | ${s.v2Exact}/${s.v2Runs} | ${s.abstained} | ${s.failed} | ${s.invalidQueries} | ${s.schemaCallsPerQuestion.toFixed(2)} | ${s.toolCallsPerQuestion.toFixed(2)} | ${s.inputTokens ?? "unknown"}/${s.outputTokens ?? "unknown"} | ${(s.medianWallMs / 1000).toFixed(1)} s |`,
    );
  }
  return lines.join("\n");
}
