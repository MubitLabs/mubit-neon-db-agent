import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { loadDotEnv } from "./config.js";
import { loadKeychainSecrets } from "./secrets.js";

/**
 * The operator CLI. The model never sees these operations or their credentials.
 *   prepare --local | --neon --project-id <id> [--seed 42]   build v1, the reader role, demo-v1, demo-v2 (migrated), control
 *   migrate --dsn-env <VAR>                                     apply v2 to one database, with the invariant check
 *   check                                                       check the Mubit route, tool calls, JSON output, calibration endpoints
 *   ask "<question>" [--environment demo-v1] [--mode calibration]   one run, printed
 *   verify <runId> --correct|--incorrect [--reason ...]        a reviewer verdict; lessons go to runtime calibration
 *   learning-retry                                              resend pending lessons and outcomes
 *   eval --split final --modes baseline,calibration [--repetitions 1] [--learn] [--limit N]
 */

const ROOT = process.cwd();
const ENV_FILE = join(ROOT, ".env");
loadDotEnv(ENV_FILE);
loadKeychainSecrets();

const argv = process.argv.slice(2);
const command = argv[0] ?? "help";
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(`--${name}`);
const sql = (file: string) => readFileSync(join(ROOT, "sql", file), "utf8");

function upsertEnv(values: Record<string, string>): void {
  const existing = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8").split(/\r?\n/) : [];
  const keys = new Set(Object.keys(values));
  const kept = existing.filter((l) => {
    const m = /^([A-Z0-9_]+)=/.exec(l);
    return !(m && keys.has(m[1]!));
  });
  const lines = [...kept.filter((l, i) => l !== "" || i < kept.length - 1), ...Object.entries(values).map(([k, v]) => `${k}=${v}`)];
  writeFileSync(ENV_FILE, lines.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);
}

function withUser(url: string, user: string, password: string): string {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
}

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 20_000 });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** v1 schema, seeded data and the reader role, on a fresh database. */
async function buildSeed(ownerUrl: string, seed: number, readerPassword: string): Promise<void> {
  const { generate, insertSeed } = await import("./seed.js");
  const data = generate(seed);
  await withClient(ownerUrl, async (c) => {
    const exists = (await c.query("select to_regclass('commerce.orders') as t")).rows[0].t;
    if (exists) throw new Error("commerce.orders already exists on the seed database; use a fresh branch or database");
    await c.query("begin");
    await c.query(sql("v1.sql"));
    await insertSeed(c, data);
    await c.query("commit");
    await c.query("analyze");
  });
  await ensureReader(ownerUrl, readerPassword);
  console.log(`seeded v1: ${data.customers.length} customers, ${data.products.length} products, ${data.orders.length} orders, ${data.items.length} items (seed ${seed})`);
}

/** The read-only role and its grants (idempotent), with a password that only the local .env holds. */
async function ensureReader(ownerUrl: string, readerPassword: string): Promise<void> {
  await withClient(ownerUrl, async (c) => {
    await c.query(sql("reader.sql"));
    await c.query(`alter role agent_reader password '${readerPassword}'`);
  });
}

async function isSeeded(ownerUrl: string): Promise<boolean> {
  return withClient(ownerUrl, async (c) => Boolean((await c.query("select to_regclass('commerce.orders') as t")).rows[0].t));
}

async function schemaVersionOf(ownerUrl: string): Promise<string> {
  return withClient(ownerUrl, async (c) => (await c.query("select schema_version from commerce.schema_meta")).rows[0]?.schema_version ?? "unknown");
}

async function migrate(ownerUrl: string): Promise<void> {
  const { migrateToV2 } = await import("./migrate.js");
  await withClient(ownerUrl, async (c) => {
    const { before, after } = await migrateToV2(c, join(ROOT, "sql", "v2.sql"));
    console.log("migrated to v2; invariants equal before and after:");
    for (const k of Object.keys(before) as (keyof typeof before)[]) console.log(`  ${k}: ${before[k]} -> ${after[k]}`);
    await c.query("analyze");
  });
}

function neon(args: string[]): string {
  return execFileSync("neon", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
}

async function prepareNeon(projectId: string, seed: number): Promise<void> {
  const branches = JSON.parse(neon(["branches", "list", "--project-id", projectId, "-o", "json"])) as { name: string; id: string; default?: boolean }[];
  const parent = branches.find((b) => b.default)?.name ?? "production";
  const has = (name: string) => branches.some((b) => b.name === name);
  const create = (name: string, from: string) => {
    if (has(name)) {
      console.log(`branch ${name}: exists, reused`);
      return;
    }
    neon(["branches", "create", "--project-id", projectId, "--name", name, "--parent", from, "--no-secrets", "-o", "json"]);
    console.log(`branch ${name}: created from ${from}`);
  };
  const dsn = (branch: string, pooled: boolean) =>
    neon(["connection-string", branch, "--project-id", projectId, "--database-name", "neondb", "--role-name", "neondb_owner", ...(pooled ? ["--pooled"] : [])]).trim();

  const readerPassword = randomBytes(24).toString("hex");
  create("acme-v1", parent);
  const acme = dsn("acme-v1", false);
  if (await isSeeded(acme)) {
    console.log("acme-v1: already seeded; reader role refreshed");
    await ensureReader(acme, readerPassword);
  } else await buildSeed(acme, seed, readerPassword);
  create("demo-v1", "acme-v1");
  create("demo-v2", "acme-v1");
  // Roles are copied when a branch is made, so each demo branch gets the same password (and the grants again).
  for (const b of ["demo-v1", "demo-v2"]) await ensureReader(dsn(b, false), readerPassword);
  if ((await schemaVersionOf(dsn("demo-v2", false))) === "v1") await migrate(dsn("demo-v2", false));
  else console.log("demo-v2: already at v2");
  create("agent-control", parent);
  await withClient(dsn("agent-control", false), (c) => c.query(sql("control.sql")).then(() => undefined));
  console.log("control schema ready on agent-control");

  const values: Record<string, string> = {
    NEON_PROJECT_ID: projectId,
    EVAL_DATABASE_URL_DEMO_V1: dsn("demo-v1", true),
    EVAL_DATABASE_URL_DEMO_V2: dsn("demo-v2", true),
    OPERATOR_DATABASE_URL_DEMO_V2: dsn("demo-v2", false),
    CONTROL_DATABASE_URL: dsn("agent-control", true),
  };
  values.AGENT_DATABASE_URL_DEMO_V1 = withUser(values.EVAL_DATABASE_URL_DEMO_V1!, "agent_reader", readerPassword);
  values.AGENT_DATABASE_URL_DEMO_V2 = withUser(values.EVAL_DATABASE_URL_DEMO_V2!, "agent_reader", readerPassword);
  if (!process.env.DEMO_ACCESS_TOKEN) values.DEMO_ACCESS_TOKEN = randomBytes(24).toString("hex");
  upsertEnv(values);
  console.log(`wrote ${Object.keys(values).length} settings to .env (mode 600); no secret was printed`);
}

async function prepareLocal(adminUrl: string, seed: number): Promise<void> {
  const readerPassword = randomBytes(24).toString("hex");
  await withClient(adminUrl, async (c) => {
    for (const db of ["demo_v1", "demo_v2", "acme_v1", "agent_control"]) await c.query(`drop database if exists ${db} with (force)`);
    await c.query("create database acme_v1");
    await c.query("create database agent_control");
  });
  await buildSeed(withDatabase(adminUrl, "acme_v1"), seed, readerPassword);
  await withClient(adminUrl, async (c) => {
    await c.query("create database demo_v1 template acme_v1");
    await c.query("create database demo_v2 template acme_v1");
  });
  // Database-level grants are not copied by CREATE DATABASE ... TEMPLATE; Neon branches copy everything.
  for (const db of ["demo_v1", "demo_v2"]) await withClient(withDatabase(adminUrl, db), (c) => c.query(sql("reader.sql")).then(() => undefined));
  await migrate(withDatabase(adminUrl, "demo_v2"));
  await withClient(withDatabase(adminUrl, "agent_control"), (c) => c.query(sql("control.sql")).then(() => undefined));
  const values: Record<string, string> = {
    AGENT_DATABASE_URL_DEMO_V1: withUser(withDatabase(adminUrl, "demo_v1"), "agent_reader", readerPassword),
    AGENT_DATABASE_URL_DEMO_V2: withUser(withDatabase(adminUrl, "demo_v2"), "agent_reader", readerPassword),
    EVAL_DATABASE_URL_DEMO_V1: withDatabase(adminUrl, "demo_v1"),
    EVAL_DATABASE_URL_DEMO_V2: withDatabase(adminUrl, "demo_v2"),
    OPERATOR_DATABASE_URL_DEMO_V2: withDatabase(adminUrl, "demo_v2"),
    CONTROL_DATABASE_URL: withDatabase(adminUrl, "agent_control"),
  };
  if (!process.env.DEMO_ACCESS_TOKEN) values.DEMO_ACCESS_TOKEN = randomBytes(24).toString("hex");
  upsertEnv(values);
  console.log("local databases ready: acme_v1 (seed parent), demo_v1, demo_v2 (migrated), agent_control; .env updated");
}

async function main(): Promise<void> {
  switch (command) {
    case "prepare": {
      const seed = Number(flag("seed") ?? 42);
      if (has("local")) {
        const admin = process.env.LOCAL_PG_URL;
        if (!admin) throw new Error("set LOCAL_PG_URL to an admin connection of a local Postgres");
        await prepareLocal(admin, seed);
      } else if (has("neon")) {
        const projectId = flag("project-id") ?? process.env.NEON_PROJECT_ID;
        if (!projectId) throw new Error("pass --project-id or set NEON_PROJECT_ID");
        await prepareNeon(projectId, seed);
      } else throw new Error("prepare needs --local or --neon");
      return;
    }
    case "migrate": {
      const name = flag("dsn-env") ?? "OPERATOR_DATABASE_URL_DEMO_V2";
      const url = process.env[name];
      if (!url) throw new Error(`${name} is not set`);
      await migrate(url);
      return;
    }
    case "check": {
      const { checkSetup } = await import("./check.js");
      await checkSetup();
      return;
    }
    case "ask": {
      const question = argv[1];
      if (!question || question.startsWith("--")) throw new Error('usage: ask "<question>" [--environment demo-v1] [--mode calibration]');
      const { getApp } = await import("./app.js");
      const { runAgent } = await import("./agent.js");
      const app = await getApp();
      const env = app.environment(flag("environment") ?? "demo-v1");
      if (!env) throw new Error("unknown environment");
      const mode = (flag("mode") ?? "calibration") as "baseline" | "calibration";
      const out = await runAgent(
        { environmentId: env.id, mode, question, idempotencyKey: `cli-${randomUUID()}` },
        { config: app.config, store: app.store, mubit: app.mubit, environment: env, readerPool: app.readerPool(env) },
      );
      const found = await app.store.getRun(app.config.tenantId, out.runId);
      for (const e of found?.events ?? []) {
        const p = e.payload as Record<string, unknown>;
        if (e.kind === "tool_result") {
          const r = p.result as { queryId?: string; rowCount?: number; error?: { code: string; sqlstate?: string; message: string } };
          let detail = "";
          if (p.name === "query") detail = ` ${(JSON.parse(String(p.arguments)) as { sql: string }).sql.replace(/\s+/g, " ").slice(0, 160)}`;
          console.log(`  ${e.sequence}. ${p.name}${r.queryId ? ` ${r.queryId}` : ""}${r.error ? ` ERROR ${r.error.sqlstate ?? r.error.code}: ${r.error.message}` : r.rowCount !== undefined ? ` (${r.rowCount} rows)` : ""}${detail}`);
        } else if (e.kind === "model_reply") {
          console.log(`  ${e.sequence}. model ${p.servedModel ?? "?"} ${p.requestId ?? ""} tokens ${JSON.stringify(p.usage)}`);
        } else if (e.kind === "calibration_recall") {
          console.log(`  ${e.sequence}. calibration ${p.backend}: ${p.status}, used ${(p.used as unknown[]).length}, excluded ${((p.excluded as unknown[]) ?? []).length}`);
        } else console.log(`  ${e.sequence}. ${e.kind}`);
      }
      console.log(`\n${out.status.toUpperCase()} (${out.verification}) run ${out.runId}\n${out.answer?.text ?? out.error ?? ""}`);
      return;
    }
    case "verify": {
      const runId = argv[1];
      if (!runId || !(has("correct") || has("incorrect"))) throw new Error("usage: verify <runId> --correct|--incorrect [--reason ...]");
      const { getApp } = await import("./app.js");
      const { verifyRun, deliverPending } = await import("./learning.js");
      const app = await getApp();
      const reason = flag("reason");
      const { lessons } = await verifyRun(app.store, app.config.tenantId, runId, { verification: has("correct") ? "verified" : "rejected", source: "reviewer", ...(reason ? { reason } : {}) }, { learn: true });
      const d = await deliverPending(app.store, app.mubit, runId);
      console.log(`lessons ${lessons.length}; delivered ${d.delivered}, failed ${d.failed}`);
      for (const l of lessons) console.log(`  ${l.kind} ${l.id}: ${l.text.split("\n")[0]}`);
      return;
    }
    case "learning-retry": {
      const { getApp } = await import("./app.js");
      const { deliverPending } = await import("./learning.js");
      const app = await getApp();
      console.log(await deliverPending(app.store, app.mubit));
      return;
    }
    case "eval": {
      const { getApp } = await import("./app.js");
      const { runEvaluation, markdownTable } = await import("./evaluate.js");
      const app = await getApp();
      const split = (flag("split") ?? "final") as "learning" | "development" | "final" | "diagnostic";
      const modes = (flag("modes") ?? "baseline,calibration").split(",") as ("baseline" | "calibration")[];
      const limit = flag("limit");
      const out = await runEvaluation(app, { split, modes, repetitions: Number(flag("repetitions") ?? 1), learn: has("learn"), seed: Number(flag("seed") ?? 7), ...(limit ? { limit: Number(limit) } : {}) }, (l) => console.log(l));
      mkdirSync(join(ROOT, "eval", "out"), { recursive: true });
      writeFileSync(join(ROOT, "eval", "out", `${out.id}.json`), JSON.stringify(out, null, 2));
      const table = markdownTable(out.summary);
      writeFileSync(join(ROOT, "eval", "out", `${out.id}.md`), `# ${out.id}\n\n${JSON.stringify(out.manifest, null, 2)}\n\n${table}\n`);
      console.log(`\n${table}\n\nsaved eval/out/${out.id}.json and .md`);
      return;
    }
    default:
      console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(10, 19).join("\n"));
  }
}

main()
  .then(async () => {
    const { closePools } = await import("./db.js");
    await closePools();
  })
  .catch(async (error) => {
    console.error(`error: ${(error as Error).message}`);
    const { closePools } = await import("./db.js");
    await closePools();
    process.exitCode = 1;
  });
