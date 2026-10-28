import { createHash } from "node:crypto";
import { LIMITS } from "./config.js";
import type { MubitClient } from "./mubit.js";
import { newId, type Delivery, type EventRow, type RunRow, type Store } from "./store.js";
import type { Lesson, Outcome, Scope, Verification } from "./types.js";

type StoredScope = Scope & { identifiers?: string[]; excludedLessonIds?: string[] };
type QueryEvent = { name: string; arguments: string; result: { queryId?: string; columns?: string[]; error?: unknown } };

const stableId = (prefix: string, ...parts: string[]) => `${prefix}_${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16)}`;

function resultQuery(run: RunRow, events: EventRow[]): { sql: string; params: string[]; columns: string[] } | null {
  const id = run.answer?.resultQueryId;
  if (!id) return null;
  for (const e of events) {
    if (e.kind !== "tool_result") continue;
    const p = e.payload as QueryEvent;
    if (p.name === "query" && p.result?.queryId === id && !p.result.error) {
      try {
        const args = JSON.parse(p.arguments) as { sql: string; params?: string[] };
        return { sql: args.sql, params: args.params ?? [], columns: p.result.columns ?? [] };
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Relations and table.column names the SQL mentions, resolved against the schema the run saw. */
export function identifiersIn(sql: string, schemaIdentifiers: string[]): string[] {
  const lower = sql.toLowerCase();
  const tables = schemaIdentifiers.filter((i) => !i.includes(".") && new RegExp(`\\b${i}\\b`).test(lower));
  const columns = schemaIdentifiers.filter((i) => {
    if (!i.includes(".")) return false;
    const [table, column] = i.split(".") as [string, string];
    return tables.includes(table) && new RegExp(`\\b${column}\\b`).test(lower);
  });
  return [...tables, ...columns].sort();
}

/**
 * At most three short lessons from a verified run, from templates over its evidence. No model writes them, so a
 * lesson never claims more than the run showed.
 */
export function deriveLessons(run: RunRow, events: EventRow[], verification: Verification): Lesson[] {
  if (verification !== "verified" || run.status !== "answered") return [];
  const q = resultQuery(run, events);
  const scope = run.scope as StoredScope | null;
  if (!q || !scope) return [];
  const { identifiers: schemaIdentifiers = [], excludedLessonIds = [], ...bare } = scope;
  const ids = identifiersIn(q.sql, schemaIdentifiers);
  const evidence = run.answer?.evidenceQueryIds ?? [];
  const tables = ids.filter((i) => !i.includes("."));
  const describe = tables.map((t) => `commerce.${t}(${ids.filter((i) => i.startsWith(`${t}.`)).map((i) => i.split(".")[1]).join(", ")})`).join("; ");
  const lessons: Lesson[] = [];
  lessons.push({
    id: stableId("les", run.id, "schema"),
    kind: "schema",
    text: `On schema ${bare.schemaVersion} (hash ${bare.schemaHash}), the verified answer to "${run.question.slice(0, 160)}" used ${describe}.`,
    scope: bare,
    evidenceIds: evidence,
    verification: "verified",
    identifiers: ids,
    source: "mubit",
    ...(excludedLessonIds[0] ? { supersedesId: excludedLessonIds[0] } : {}),
  });
  lessons.push({
    id: stableId("les", run.id, "procedure"),
    kind: "procedure",
    text: `A verified query for a question like "${run.question.slice(0, 160)}" (returns ${q.columns.join(", ")}; params ${JSON.stringify(q.params)}):\n${q.sql.trim().slice(0, 1_200)}`,
    scope: bare,
    evidenceIds: evidence,
    verification: "verified",
    identifiers: ids,
    source: "mubit",
  });
  if (/\brefunds\b/i.test(q.sql) && /group\s+by[^;]*\border_id\b/i.test(q.sql)) {
    lessons.push({
      id: stableId("les", bare.databaseId, bare.calibrationNamespace, bare.schemaHash, "refund-preaggregation"),
      kind: "procedure",
      text: "Sum commerce.refunds.amount_cents where status = 'succeeded' per order_id in a CTE before joining it to orders. Joining refunds and order_items to orders together multiplies both amounts. Net revenue counts refunds against the order's own ordered_at month.",
      scope: bare,
      evidenceIds: evidence,
      verification: "verified",
      identifiers: ["refunds", "refunds.amount_cents", "refunds.order_id", "refunds.status"],
      source: "mubit",
    });
  }
  return lessons.slice(0, LIMITS.maxLessonsPerRun);
}

/**
 * Records a verdict (from the trusted evaluator or a reviewer), and queues the lessons and the outcome for Mubit in
 * the same transaction. Evaluation runs never produce lessons: their results must not reach later runs.
 */
export async function verifyRun(
  store: Store,
  tenantId: string,
  runId: string,
  verdict: { verification: Verification; source: Outcome["source"]; reason?: string },
  options: { learn: boolean },
): Promise<{ deliveries: Delivery[]; lessons: Lesson[] }> {
  const found = await store.getRun(tenantId, runId);
  if (!found) throw new Error("run not found");
  const { run, events } = found;
  const lessons = options.learn && !run.evaluation ? deriveLessons(run, events, verdict.verification) : [];
  const outcome: Outcome = {
    runId,
    verification: verdict.verification,
    source: verdict.source,
    evidenceIds: run.answer?.evidenceQueryIds ?? [],
    ...(verdict.reason ? { reason: verdict.reason } : {}),
  };
  const deliveries: Delivery[] = [
    ...lessons.map((lesson) => ({ id: newId("dl"), runId, kind: "lesson" as const, payload: { lesson }, idempotencyKey: `lesson:${lesson.id}` })),
    ...(run.evaluation ? [] : [{ id: newId("dl"), runId, kind: "outcome" as const, payload: { outcome }, idempotencyKey: `outcome:${runId}:${verdict.verification}` }]),
  ];
  await store.setVerification(runId, verdict.verification, deliveries);
  return { deliveries, lessons };
}

/** Sends pending lessons and outcomes. A failure stays pending for `npm run learning:retry`; keys keep it idempotent. */
export async function deliverPending(store: Store, mubit: MubitClient, onlyRunId?: string): Promise<{ delivered: number; failed: number }> {
  let delivered = 0;
  let failed = 0;
  for (const d of await store.pendingDeliveries()) {
    if (onlyRunId && d.runId !== onlyRunId) continue;
    try {
      if (d.kind === "lesson") await mubit.remember((d.payload as { lesson: Lesson }).lesson, d.idempotencyKey);
      else await mubit.report((d.payload as { outcome: Outcome }).outcome, d.idempotencyKey);
      await store.markDelivery(d.id, true);
      delivered += 1;
    } catch (error) {
      await store.markDelivery(d.id, false, (error as Error).message);
      failed += 1;
    }
  }
  return { delivered, failed };
}
