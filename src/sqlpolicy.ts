import { loadModule, parseSync } from "libpg-query";

/**
 * The model's SQL must be exactly one plain SELECT over commerce relations and its own CTEs, using only the node types,
 * functions and casts listed here. Anything the walker does not know is refused, not rewritten. This is one layer: the
 * database role (SELECT only), the read-only transaction and the time limits are the others.
 */

let ready: Promise<void> | null = null;
export function initSqlPolicy(): Promise<void> {
  ready ??= loadModule();
  return ready;
}

const ALLOWED_NODES = new Set([
  "SelectStmt", "ResTarget", "ColumnRef", "A_Const", "A_Expr", "BoolExpr", "FuncCall", "TypeCast", "RangeVar",
  "JoinExpr", "RangeSubselect", "SubLink", "CommonTableExpr", "WithClause", "SortBy", "WindowDef", "CaseExpr",
  "CaseWhen", "NullTest", "BooleanTest", "CoalesceExpr", "MinMaxExpr", "ParamRef", "A_Star", "String", "Integer",
  "Float", "Boolean", "List", "RowExpr", "A_ArrayExpr", "A_Indirection", "A_Indices", "NamedArgExpr", "GroupingSet",
  "RangeFunction", "TypeName", "Alias",
]);

export const ALLOWED_FUNCTIONS = new Set([
  // aggregates
  "count", "sum", "avg", "min", "max", "bool_and", "bool_or", "every", "string_agg", "array_agg", "percentile_cont",
  "percentile_disc", "stddev", "stddev_pop", "stddev_samp", "variance", "var_pop", "var_samp", "mode",
  // window functions
  "row_number", "rank", "dense_rank", "percent_rank", "cume_dist", "ntile", "lag", "lead", "first_value",
  "last_value", "nth_value",
  // numbers
  "abs", "round", "ceil", "ceiling", "floor", "trunc", "sign", "mod", "div", "power", "sqrt", "ln", "exp", "log",
  // dates and times (no clock functions: the reporting clock is fixed)
  "date_trunc", "date_part", "extract", "make_date", "make_timestamp", "make_timestamptz", "make_interval", "to_char",
  "to_date", "to_timestamp", "age", "justify_interval", "justify_days", "date_bin", "timezone", "isfinite",
  // text
  "lower", "upper", "length", "char_length", "substring", "substr", "btrim", "ltrim", "rtrim", "trim", "concat",
  "concat_ws", "left", "right", "replace", "split_part", "position", "strpos", "starts_with", "initcap", "lpad", "rpad",
  // json, for reading agent_contract
  "jsonb_extract_path_text", "jsonb_typeof", "jsonb_object_keys", "jsonb_each_text", "jsonb_array_elements_text",
  // set-returning functions allowed in FROM
  "generate_series", "unnest",
]);

const FROM_FUNCTIONS = new Set(["generate_series", "unnest", "jsonb_object_keys", "jsonb_each_text", "jsonb_array_elements_text"]);

export const ALLOWED_TYPES = new Set([
  "int2", "int4", "int8", "smallint", "integer", "int", "bigint", "numeric", "decimal", "float4", "float8", "real",
  "double precision", "text", "varchar", "bpchar", "char", "bool", "boolean", "date", "timestamp", "timestamptz",
  "interval", "jsonb", "json",
]);

export type PolicyResult =
  | { ok: true; wrapped: string; relations: string[]; columns: string[]; paramCount: number }
  | { ok: false; code: "parse_error" | "policy_rejected"; message: string };

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

class Rejection extends Error {}

function reject(message: string): never {
  throw new Rejection(message);
}

function names(list: Json | undefined): string[] {
  if (!Array.isArray(list)) return [];
  return list.map((n) => {
    const s = (n as { String?: { sval?: string } }).String;
    return typeof s?.sval === "string" ? s.sval.toLowerCase() : "";
  });
}

/** Removes position fields, so two parses of the same statement compare equal. */
function stripLocations(node: Json): Json {
  if (Array.isArray(node)) return node.map(stripLocations);
  if (node && typeof node === "object") {
    const out: { [k: string]: Json } = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "location" || k === "stmt_location" || k === "stmt_len") continue;
      out[k] = stripLocations(v);
    }
    return out;
  }
  return node;
}

function collectCteNames(node: Json, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const n of node) collectCteNames(n, into);
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "CommonTableExpr" && v && typeof v === "object" && !Array.isArray(v)) {
        const name = (v as { ctename?: string }).ctename;
        if (name) into.add(name.toLowerCase());
      }
      collectCteNames(v, into);
    }
  }
}

type WalkState = { allowedRelations: Set<string>; cteNames: Set<string>; relations: Set<string>; columns: Set<string>; maxParam: number };

function walk(value: Json, state: WalkState): void {
  if (Array.isArray(value)) {
    for (const v of value) walk(v, state);
    return;
  }
  if (!value || typeof value !== "object") return;
  const keys = Object.keys(value);
  const isNode = keys.length === 1 && /^[A-Z]/.test(keys[0]!);
  if (!isNode) {
    for (const v of Object.values(value)) walk(v, state);
    return;
  }
  const type = keys[0]!;
  const body = (value as { [k: string]: Json })[type] as { [k: string]: Json };
  if (!ALLOWED_NODES.has(type)) reject(`${type} is not allowed in an agent query`);
  switch (type) {
    case "SelectStmt": {
      if (body.intoClause) reject("SELECT INTO is not allowed");
      if (Array.isArray(body.lockingClause) && body.lockingClause.length > 0) reject("locking clauses (FOR UPDATE/SHARE) are not allowed");
      // The parser keeps WITH as a plain struct on the SELECT, so its flags are checked here.
      const withClause = body.withClause as { recursive?: boolean } | undefined;
      if (withClause?.recursive) reject("WITH RECURSIVE is not allowed");
      break;
    }
    case "WithClause": {
      if (body.recursive) reject("WITH RECURSIVE is not allowed");
      break;
    }
    case "CommonTableExpr": {
      const q = body.ctequery as { [k: string]: Json } | undefined;
      if (!q || Object.keys(q)[0] !== "SelectStmt") reject("a CTE must be a plain SELECT");
      break;
    }
    case "RangeVar": {
      const schema = typeof body.schemaname === "string" ? body.schemaname.toLowerCase() : undefined;
      const rel = String(body.relname ?? "").toLowerCase();
      if (body.catalogname) reject("database-qualified names are not allowed");
      if (schema === undefined && state.cteNames.has(rel)) break;
      if (schema !== undefined && schema !== "commerce") reject(`relation ${schema}.${rel} is outside the commerce schema`);
      if (!state.allowedRelations.has(rel)) reject(`relation ${rel} is not an allowed commerce relation`);
      state.relations.add(rel);
      break;
    }
    case "ColumnRef": {
      const fields = names(body.fields).filter(Boolean);
      if (fields.length > 0) state.columns.add(fields[fields.length - 1]!);
      break;
    }
    case "FuncCall": {
      const fn = names(body.funcname);
      const fname = fn[fn.length - 1]!;
      if (fn.length > 2 || (fn.length === 2 && fn[0] !== "pg_catalog")) reject(`function ${fn.join(".")} is not allowed`);
      if (!ALLOWED_FUNCTIONS.has(fname)) reject(`function ${fname} is not allowed`);
      break;
    }
    case "RangeFunction": {
      if (body.is_rowsfrom) reject("ROWS FROM is not allowed");
      const fns = JSON.stringify(body.functions ?? []);
      const called = [...fns.matchAll(/"funcname":\[\{"String":\{"sval":"([^"]+)"\}\}(?:,\{"String":\{"sval":"([^"]+)"\}\})?\]/g)].map((m) => (m[2] ?? m[1])!.toLowerCase());
      if (called.length === 0 || called.some((f) => !FROM_FUNCTIONS.has(f))) reject("only generate_series, unnest and the jsonb readers may appear in FROM");
      break;
    }
    case "TypeCast": {
      const tn = (body.typeName ?? {}) as { names?: Json; arrayBounds?: Json };
      const t = names(tn.names);
      const tname = t[t.length - 1]!;
      if (t.length > 2 || (t.length === 2 && t[0] !== "pg_catalog")) reject(`type ${t.join(".")} is not allowed`);
      if (!ALLOWED_TYPES.has(tname)) reject(`cast to ${tname} is not allowed`);
      break;
    }
    case "A_Expr": {
      const op = names(body.name);
      if (op.length > 1 && op[0] !== "pg_catalog") reject("schema-qualified operators are not allowed");
      break;
    }
    case "ParamRef": {
      const n = Number(body.number ?? 0);
      if (n > state.maxParam) state.maxParam = n;
      break;
    }
  }
  for (const v of Object.values(body)) walk(v, state);
}

/**
 * Checks one statement and returns it wrapped in a row cap. The wrapped text is parsed again and must hold exactly the
 * checked statement as its only subquery, so nothing in the model's text can change the wrapper.
 */
export function checkSelect(sql: string, allowedRelations: Iterable<string>, maxRows = 200): PolicyResult {
  let parsed: { stmts?: { stmt: Json }[] };
  try {
    parsed = parseSync(sql) as typeof parsed;
  } catch (error) {
    return { ok: false, code: "parse_error", message: (error as Error).message.slice(0, 300) };
  }
  const stmts = parsed.stmts ?? [];
  if (stmts.length !== 1) return { ok: false, code: "policy_rejected", message: "exactly one statement is allowed" };
  const stmt = stmts[0]!.stmt as { [k: string]: Json };
  if (Object.keys(stmt)[0] !== "SelectStmt") return { ok: false, code: "policy_rejected", message: "only SELECT statements are allowed" };
  const cteNames = new Set<string>();
  collectCteNames(stmt, cteNames);
  const state: WalkState = {
    allowedRelations: new Set([...allowedRelations].map((r) => r.toLowerCase())),
    cteNames,
    relations: new Set(),
    columns: new Set(),
    maxParam: 0,
  };
  try {
    walk(stmt, state);
  } catch (error) {
    if (error instanceof Rejection) return { ok: false, code: "policy_rejected", message: error.message };
    throw error;
  }
  const body = sql.trim().replace(/;\s*$/, "");
  const wrapped = `select * from (\n${body}\n) as agent_result limit ${maxRows + 1}`;
  try {
    const again = parseSync(wrapped) as { stmts?: { stmt: Json }[] };
    const outer = again.stmts?.[0]?.stmt as { SelectStmt?: { fromClause?: Json[] } } | undefined;
    const sub = (outer?.SelectStmt?.fromClause?.[0] as { RangeSubselect?: { subquery?: Json } } | undefined)?.RangeSubselect?.subquery;
    if (again.stmts?.length !== 1 || !sub || JSON.stringify(stripLocations(sub)) !== JSON.stringify(stripLocations(stmt))) {
      return { ok: false, code: "policy_rejected", message: "the query could not be wrapped safely" };
    }
  } catch {
    return { ok: false, code: "policy_rejected", message: "the query could not be wrapped safely" };
  }
  return { ok: true, wrapped, relations: [...state.relations].sort(), columns: [...state.columns].sort(), paramCount: state.maxParam };
}
