import { join } from "node:path";
import pg from "pg";
import { loadDotEnv } from "../src/config.js";
import { exactTypes } from "../src/db.js";
import { answerAgrees, compareResult } from "../eval/compare.js";
import { TEMPLATES, type SchemaVersion } from "../eval/references.js";

/**
 * Checks one stored run against a trusted reference, for demos and spot checks:
 *   npx tsx scripts/check-run.ts <runId> <templateId> <YYYY-MM> [limit]
 * Prints the runtime calibration the run used and excluded, and whether its result table matches the reference exactly.
 */
loadDotEnv(join(process.cwd(), ".env"));
const [runId, templateId, month, limit] = process.argv.slice(2);
if (!runId || !templateId || !month) throw new Error("usage: check-run.ts <runId> <templateId> <YYYY-MM> [limit]");
const control = new pg.Client({ connectionString: process.env.CONTROL_DATABASE_URL, types: exactTypes });
await control.connect();
const run = (await control.query("select * from agentctl.runs where id = $1", [runId])).rows[0];
if (!run) throw new Error("run not found");
const events = (await control.query("select kind, payload from agentctl.events where run_id = $1 order by sequence", [runId])).rows;
const recall = events.find((e) => e.kind === "calibration_recall")?.payload;
if (recall) {
  console.log(`calibration ${recall.backend}: ${recall.status}, received ${recall.received}, used ${recall.used.length}`);
  for (const u of recall.used) console.log(`  used     ${u.kind} ${u.id} (schema ${u.schemaVersion})`);
  for (const x of recall.excluded ?? []) console.log(`  excluded ${x.kind} ${x.id}: ${x.reason}`);
}
const result = events.filter((e) => e.kind === "tool_result").map((e) => e.payload.result).find((r) => r?.queryId === run.answer?.resultQueryId);
const template = TEMPLATES.find((t) => t.id === templateId);
if (!template) throw new Error("unknown template");
const version = (run.scope?.schemaVersion ?? "v1") as SchemaVersion;
const [y, m] = month.split("-").map(Number) as [number, number];
const prev = new Date(Date.UTC(y, m - 2, 1));
const params = { month, prevMonth: `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}`, limit: Number(limit ?? 3) };
const ref = template.reference(version, params);
const envVar = run.environment_id === "demo-v2" ? "EVAL_DATABASE_URL_DEMO_V2" : "EVAL_DATABASE_URL_DEMO_V1";
const evalDb = new pg.Client({ connectionString: process.env[envVar], types: exactTypes });
await evalDb.connect();
const expected = await evalDb.query({ text: ref.sql, values: ref.params, rowMode: "array" });
const exp = { columns: expected.fields.map((f) => f.name), rows: expected.rows as unknown[][] };
if (!result) console.log("the run has no result table");
else {
  const cmp = compareResult(template.shape(params), exp, { columns: result.columns, rows: result.rows, truncated: result.truncated });
  console.log(`${run.environment_id} (${version}) ${run.mode}: ${cmp.exact ? "EXACT MATCH" : `MISMATCH: ${cmp.reason}`} (agent ${cmp.actualRows} rows, reference ${cmp.expectedRows})`);
  const agrees = answerAgrees(run.answer?.text ?? "", exp);
  if (agrees !== null) console.log(`answer text states the value: ${agrees}`);
}
await control.end();
await evalDb.end();
