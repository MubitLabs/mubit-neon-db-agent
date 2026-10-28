import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { loadDotEnv } from "../src/config.js";

/**
 * Runs the demonstration against a deployed Function through its HTTP API:
 *   npx tsx scripts/walkthrough.ts <function url>
 * 1. a v1 question in calibration mode; 2. the reviewer marks it correct (lessons go to Mubit);
 * 3. a related v1 question that recalls them; 4. a v2 question after the migration (old mappings become obsolete).
 * The bearer token comes from .env and is never printed.
 */
loadDotEnv(join(process.cwd(), ".env"));
const base = (process.argv[2] ?? "").replace(/\/+$/, "");
const token = process.env.DEMO_ACCESS_TOKEN;
if (!base || !token) throw new Error("usage: walkthrough.ts <function url> (DEMO_ACCESS_TOKEN in .env)");

async function call(path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${base}${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(120_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

async function ask(environmentId: string, question: string) {
  const t0 = Date.now();
  const out = await call("/runs", { environmentId, mode: "calibration", question, idempotencyKey: `walk-${randomUUID()}` });
  const { run, events } = await call(`/runs/${out.runId}`);
  const recall = events.find((e: any) => e.kind === "calibration_recall")?.payload;
  const tools = events.filter((e: any) => e.kind === "tool_result");
  console.log(`  run ${out.runId} on ${environmentId}: ${out.status} (${out.verification}) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log(`  served by ${(run.served_identity?.servedModels ?? []).join(", ")}; Mubit requests ${(run.served_identity?.requestIds ?? []).length}; tools ${tools.length} (schema ${tools.filter((e: any) => e.payload.name !== "query").length})`);
  if (recall) {
    console.log(`  runtime calibration: ${recall.status}, used ${recall.used.length}, excluded ${(recall.excluded ?? []).length}`);
    for (const x of recall.excluded ?? []) console.log(`    obsolete ${x.kind} ${x.id}: ${x.reason}`);
  }
  console.log(`  answer: ${(out.answer?.text ?? out.error ?? "").replace(/\s+/g, " ").slice(0, 220)}`);
  return out.runId as string;
}

const env = await call("/environments");
console.log(`Function ${base}\n  model ${env.model} via ${env.route}; calibration ${env.calibrationBackend} (${env.capabilities?.notes?.[0] ?? ""})`);
console.log(`  environments: ${env.environments.map((e: any) => `${e.id} [${e.modes.map((m: any) => m.mode).join(", ")}]`).join("; ")}`);

console.log("\n1. A v1 question");
const first = await ask("demo-v1", "What was net revenue by country in August 2026? Return country_code and net_revenue_cents, one row per country with at least one completed order that month.");
console.log("\n2. The reviewer marks it correct");
const fb = await call(`/runs/${first}/feedback`, { verdict: "correct", reason: "walkthrough: reviewed" });
console.log(`  ${fb.verification}; lessons ${fb.lessons.length}; delivered to Mubit ${fb.delivery.delivered}, failed ${fb.delivery.failed}`);
await new Promise((r) => setTimeout(r, 12_000)); // Mubit ingests asynchronously
console.log("\n3. A related v1 question");
const second = await ask("demo-v1", "Which 3 countries had the largest net revenue drop from August 2026 to September 2026? Return country_code, first_month_cents, second_month_cents and drop_cents (first minus second), only countries whose net revenue fell, ordered by drop_cents descending then country_code ascending.");
console.log("\n4. After the migration: a v2 question");
const third = await ask("demo-v2", "Compare September 2026 net revenue for repeat customers by country. Return country_code and net_revenue_cents from the completed orders of customers who are repeat customers in that month.");
console.log(`\nruns: ${first} ${second} ${third}`);
