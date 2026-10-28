import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { LIMITS } from "./config.js";
import { checkSelect } from "./sqlpolicy.js";
import type { ColumnInfo, QueryFailure, QueryResult } from "./types.js";

/** int2/int4 and floats become numbers, booleans stay booleans; everything else (int8, numeric, dates) stays a string. */
const TYPE_NUMBER = new Set([21, 23, 700, 701]);
const TYPE_BOOL = 16;
export const exactTypes = {
  getTypeParser(oid: number, format?: string) {
    if (format === "binary") return (v: unknown) => v;
    if (TYPE_NUMBER.has(oid)) return (v: string) => Number(v);
    if (oid === TYPE_BOOL) return (v: string) => v === "t";
    if (oid === 114 || oid === 3802) return (v: string) => JSON.parse(v); // json, jsonb (control records)
    return (v: string) => v;
  },
} as pg.CustomTypesConfig;

/** Pools are created once per process and reused (Neon Functions keep the isolate between requests). */
const pools = new Map<string, pg.Pool>();
export function poolFor(url: string, max = 3): pg.Pool {
  let pool = pools.get(url);
  if (!pool) {
    pool = new pg.Pool({ connectionString: url, max, types: exactTypes, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
    pool.on("error", () => undefined); // idle disconnects are expected on serverless Postgres
    pools.set(url, pool);
  }
  return pool;
}

export async function closePools(): Promise<void> {
  await Promise.all([...pools.values()].map((p) => p.end().catch(() => undefined)));
  pools.clear();
}

/** Runs fn inside a read-only transaction with the agent's limits, and always rolls back. */
async function readOnly<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("begin transaction read only");
    await client.query("set local search_path = pg_catalog, commerce");
    await client.query(`set local statement_timeout = '${LIMITS.statementTimeoutMs}ms'`);
    await client.query(`set local lock_timeout = '${LIMITS.lockTimeoutMs}ms'`);
    await client.query(`set local idle_in_transaction_session_timeout = '${LIMITS.idleInTransactionMs}ms'`);
    return await fn(client);
  } catch (error) {
    broken = isConnectionError(error);
    throw error;
  } finally {
    try {
      await client.query("rollback");
    } catch {
      broken = true;
    }
    client.release(broken);
  }
}

function isConnectionError(error: unknown): boolean {
  const code = (error as { code?: string }).code ?? "";
  return code.startsWith("08") || code === "57P01" || /Connection terminated|ECONNRESET|EPIPE/.test(String(error));
}

export type TableSummary = { name: string; comment: string | null };
export type TableDescription = {
  name: string;
  comment: string | null;
  columns: { name: string; type: string; nullable: boolean; comment: string | null }[];
  constraints: { name: string; kind: string; definition: string }[];
};

const LIST_TABLES = `
  select c.relname as name, obj_description(c.oid, 'pg_class') as comment
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'commerce' and c.relkind in ('r', 'p', 'v', 'm') and has_table_privilege(c.oid, 'select')
  order by 1`;

export async function listTables(pool: pg.Pool): Promise<TableSummary[]> {
  return readOnly(pool, async (c) => (await c.query(LIST_TABLES)).rows as TableSummary[]);
}

/** Describes one relation. The name is checked against the discovered list and only ever passed as a parameter. */
export async function describeTable(pool: pg.Pool, rawName: string): Promise<TableDescription | { error: string }> {
  const name = rawName.replace(/^commerce\./i, "").trim().toLowerCase();
  return readOnly(pool, async (c) => {
    const tables = (await c.query(LIST_TABLES)).rows as TableSummary[];
    const table = tables.find((t) => t.name === name);
    if (!table) return { error: `unknown table ${JSON.stringify(rawName)}; call list_tables for the allowed names` };
    const cols = await c.query(
      `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, not a.attnotnull as nullable,
              col_description(a.attrelid, a.attnum) as comment
       from pg_attribute a join pg_class cl on cl.oid = a.attrelid join pg_namespace n on n.oid = cl.relnamespace
       where n.nspname = 'commerce' and cl.relname = $1 and a.attnum > 0 and not a.attisdropped
       order by a.attnum`,
      [name],
    );
    const cons = await c.query(
      `select con.conname as name,
              case con.contype when 'p' then 'primary key' when 'f' then 'foreign key' when 'u' then 'unique' when 'c' then 'check' else con.contype::text end as kind,
              pg_get_constraintdef(con.oid) as definition
       from pg_constraint con join pg_class cl on cl.oid = con.conrelid join pg_namespace n on n.oid = cl.relnamespace
       where n.nspname = 'commerce' and cl.relname = $1
       order by 2, 1`,
      [name],
    );
    return { name, comment: table.comment, columns: cols.rows as TableDescription["columns"], constraints: cons.rows as TableDescription["constraints"] };
  });
}

export type SchemaSignature = {
  hash: string;
  relations: string[];
  identifiers: Set<string>; // "table" and "table.column"
  schemaVersion: string;
  migrationId: string;
  semanticVersion: string;
  contract: Record<string, string>;
};

/** One read per run: the semantic contract, the schema marker, and a hash of every relation, column, type and key. */
export async function readSchemaSignature(pool: pg.Pool): Promise<SchemaSignature> {
  return readOnly(pool, async (c) => {
    const cols = (
      await c.query(
        `select cl.relname as rel, a.attname as col, format_type(a.atttypid, a.atttypmod) as type
         from pg_attribute a join pg_class cl on cl.oid = a.attrelid join pg_namespace n on n.oid = cl.relnamespace
         where n.nspname = 'commerce' and cl.relkind in ('r', 'p', 'v', 'm') and a.attnum > 0 and not a.attisdropped
           and has_table_privilege(cl.oid, 'select')
         order by 1, a.attnum`,
      )
    ).rows as { rel: string; col: string; type: string }[];
    const keys = (
      await c.query(
        `select cl.relname as rel, con.contype::text as kind, pg_get_constraintdef(con.oid) as def
         from pg_constraint con join pg_class cl on cl.oid = con.conrelid join pg_namespace n on n.oid = cl.relnamespace
         where n.nspname = 'commerce' and con.contype in ('p', 'f', 'u')
         order by 1, 2, 3`,
      )
    ).rows as { rel: string; kind: string; def: string }[];
    const meta = (await c.query("select schema_version, migration_id from commerce.schema_meta")).rows[0] as
      | { schema_version: string; migration_id: string }
      | undefined;
    const contractRow = (await c.query("select semantic_version, definitions from commerce.agent_contract order by semantic_version desc limit 1")).rows[0] as
      | { semantic_version: string; definitions: string }
      | undefined;
    const relations = [...new Set(cols.map((r) => r.rel))].sort();
    const identifiers = new Set<string>(relations);
    for (const r of cols) identifiers.add(`${r.rel}.${r.col}`);
    const hash = createHash("sha256").update(JSON.stringify({ cols, keys })).digest("hex").slice(0, 16);
    const raw = contractRow?.definitions as unknown;
    const definitions = (typeof raw === "string" ? JSON.parse(raw) : (raw ?? {})) as Record<string, string>;
    return {
      hash,
      relations,
      identifiers,
      schemaVersion: meta?.schema_version ?? "unknown",
      migrationId: meta?.migration_id ?? "unknown",
      semanticVersion: contractRow?.semantic_version ?? "unknown",
      contract: definitions,
    };
  });
}

export type ExecutedQuery = (QueryResult | QueryFailure) & { sql: string; params: unknown[]; relations?: string[]; columnsUsed?: string[] };

/**
 * Runs one model query: policy check, read-only transaction, the agent's limits, at most LIMITS.maxRows rows and
 * LIMITS.maxToolOutputBytes of output. Errors come back as SQLSTATE plus a short message, never a stack or a URL.
 */
export async function runAgentQuery(pool: pg.Pool, sql: string, params: unknown[], allowedRelations: string[]): Promise<ExecutedQuery> {
  const queryId = `q_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const check = checkSelect(sql, allowedRelations, LIMITS.maxRows);
  if (!check.ok) return { queryId, sql, params, error: { code: check.code, message: check.message } };
  if (params.length < check.paramCount) {
    return { queryId, sql, params, error: { code: "policy_rejected", message: `the query uses $${check.paramCount} but only ${params.length} params were given` } };
  }
  const started = performance.now();
  try {
    const res = await readOnly(pool, (c) => c.query({ text: check.wrapped, values: params, rowMode: "array" }));
    const truncated = res.rows.length > LIMITS.maxRows;
    const rows = (res.rows as unknown[][]).slice(0, LIMITS.maxRows);
    const columns: ColumnInfo[] = res.fields.map((f) => ({ name: f.name, dataTypeId: f.dataTypeID }));
    const result: QueryResult = { queryId, columns, rows, truncated, durationMs: Math.round(performance.now() - started) };
    if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.maxToolOutputBytes) {
      return { queryId, sql, params, error: { code: "output_too_large", message: `the result is over ${LIMITS.maxToolOutputBytes} bytes; aggregate further or select fewer columns` } };
    }
    return { ...result, sql, params, relations: check.relations, columnsUsed: check.columns };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { queryId, sql, params, error: { code: "sql_error", sqlstate: e.code, message: sanitize(e.message ?? "query failed") } };
  }
}

export function sanitize(message: string): string {
  return message
    .replace(/postgres(ql)?:\/\/[^\s'"]+/gi, "<connection>")
    .replace(/password[^\s]*/gi, "<redacted>")
    .slice(0, 400);
}

export function isFailure(q: QueryResult | QueryFailure): q is QueryFailure {
  return "error" in q;
}
