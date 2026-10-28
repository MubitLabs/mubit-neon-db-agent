import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePools, describeTable, listTables, poolFor, readSchemaSignature, runAgentQuery } from "../src/db.js";
import { initSqlPolicy } from "../src/sqlpolicy.js";
import { hasDb, LOCAL } from "./helpers.js";

/** The reader role is tested directly, not just through the parser: these statements bypass the policy on purpose. */
describe.skipIf(!hasDb)("the agent_reader role", () => {
  let client: pg.Client;
  beforeAll(async () => {
    await initSqlPolicy();
    client = new pg.Client({ connectionString: LOCAL.reader });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
    await closePools();
  });

  const refused = async (sql: string) => {
    await expect(client.query(sql)).rejects.toThrow();
    await client.query("rollback").catch(() => undefined);
  };

  it("can read commerce", async () => {
    const r = await client.query("select count(*)::int as n from commerce.orders");
    expect(r.rows[0].n).toBeGreaterThan(0);
  });
  it("cannot write commerce", () => refused("delete from commerce.orders where id = 1"));
  it("cannot update", () => refused("update commerce.orders set status = 'pending' where id = 1"));
  it("cannot create tables", () => refused("create table commerce.x (a int)"));
  it("cannot create in public", () => refused("create table public.x (a int)"));
  it("cannot create temp tables", () => refused("create temp table t (a int)"));
  it("starts read-only by default", async () => {
    const r = await client.query("show default_transaction_read_only");
    expect(r.rows[0].default_transaction_read_only).toBe("on");
  });
  it("has no role memberships", async () => {
    const r = await client.query("select count(*)::int as n from pg_auth_members m join pg_roles r on r.oid = m.member where r.rolname = 'agent_reader'");
    expect(r.rows[0].n).toBe(0);
  });
  it("cannot read the control database", async () => {
    const url = new URL(LOCAL.reader!);
    url.pathname = "/agent_control";
    const other = new pg.Client({ connectionString: url.toString() });
    const reached = await other.connect().then(() => true).catch(() => false);
    if (reached) {
      await expect(other.query("select * from agentctl.runs limit 1")).rejects.toThrow();
      await other.end();
    }
  });
});

describe.skipIf(!hasDb)("query execution", () => {
  const relations = ["customers", "products", "orders", "order_items", "agent_contract", "schema_meta"];
  afterAll(() => closePools());
  beforeAll(() => initSqlPolicy());

  it("caps rows at 200 and marks truncation", async () => {
    const q = await runAgentQuery(poolFor(LOCAL.reader!), "select id from orders order by id", [], relations);
    expect("rows" in q && q.rows.length).toBe(200);
    expect("truncated" in q && q.truncated).toBe(true);
  });
  it("keeps bigint and numeric exact, as strings", async () => {
    const q = await runAgentQuery(poolFor(LOCAL.reader!), "select sum(gross_cents) as g, avg(gross_cents) as a from orders", [], relations);
    expect("rows" in q && typeof q.rows[0]![0]).toBe("string");
    expect("rows" in q && typeof q.rows[0]![1]).toBe("string");
  });
  it("binds parameters", async () => {
    const q = await runAgentQuery(poolFor(LOCAL.reader!), "select count(*) from orders where status = $1", ["completed"], relations);
    expect("rows" in q && Number(q.rows[0]![0])).toBeGreaterThan(0);
  });
  it("refuses missing parameters before running", async () => {
    const q = await runAgentQuery(poolFor(LOCAL.reader!), "select $2::int", ["1"], relations);
    expect("error" in q && q.error.code).toBe("policy_rejected");
  });
  it("returns SQLSTATE for an undefined column, without the connection string", async () => {
    const q = await runAgentQuery(poolFor(LOCAL.reader!), "select nope from orders", [], relations);
    expect("error" in q && q.error.sqlstate).toBe("42703");
    expect(JSON.stringify(q)).not.toMatch(/postgres(ql)?:\/\//);
  });
  it("stops a long query at the statement timeout", async () => {
    const q = await runAgentQuery(poolFor(LOCAL.reader!), "select count(*) from order_items a cross join order_items b", [], relations);
    expect("error" in q && q.error.sqlstate).toBe("57014");
  });
  it("refuses an oversized result", async () => {
    const q = await runAgentQuery(poolFor(LOCAL.reader!), "select lpad('x', 1000, 'x') as filler, id from orders order by id", [], relations);
    expect("error" in q && q.error.code).toBe("output_too_large");
  });
  it("leaves no open transaction on the pooled connection", async () => {
    const pool = poolFor(LOCAL.reader!);
    await runAgentQuery(pool, "select nope from orders", [], relations);
    const r = await pool.query("select pg_current_xact_id_if_assigned() is null as idle, current_setting('transaction_read_only') as ro");
    expect(r.rows[0].idle).toBe(true);
  });
  it("lists and describes tables through fixed catalog queries", async () => {
    const tables = await listTables(poolFor(LOCAL.reader!));
    expect(tables.map((t) => t.name)).toContain("orders");
    const d = await describeTable(poolFor(LOCAL.reader!), "commerce.orders");
    expect("columns" in d && d.columns.map((c) => c.name)).toContain("gross_cents");
    const bad = await describeTable(poolFor(LOCAL.reader!), "pg_class");
    expect("error" in bad).toBe(true);
  });
  it("gives v1 and v2 different schema hashes but the same contract", async () => {
    const a = await readSchemaSignature(poolFor(LOCAL.reader!));
    const b = await readSchemaSignature(poolFor(LOCAL.readerV2!));
    expect(a.schemaVersion).toBe("v1");
    expect(b.schemaVersion).toBe("v2");
    expect(a.hash).not.toBe(b.hash);
    expect(a.semanticVersion).toBe(b.semanticVersion);
    expect(b.identifiers.has("orders.subtotal_cents")).toBe(true);
    expect(b.identifiers.has("orders.gross_cents")).toBe(false);
  });
});
