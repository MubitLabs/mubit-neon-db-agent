import { beforeAll, describe, expect, it } from "vitest";
import { checkSelect, initSqlPolicy } from "../src/sqlpolicy.js";

const RELATIONS = ["customers", "products", "orders", "order_items", "refunds", "agent_contract", "schema_meta"];
const ok = (sql: string) => checkSelect(sql, RELATIONS);

beforeAll(async () => {
  await initSqlPolicy();
});

describe("the SQL policy accepts the analysis subset", () => {
  it.each([
    "select count(*) from orders",
    "select c.country_code, sum(o.gross_cents - o.refund_cents)::bigint as net from commerce.orders o join commerce.customers c on c.id = o.customer_id where o.status = $1 and o.ordered_at >= $2::timestamptz and o.ordered_at < $3::timestamptz group by 1 order by 2 desc",
    "with r as (select order_id, sum(amount_cents) as s from refunds where status = 'succeeded' group by order_id) select o.id, o.subtotal_cents - coalesce(r.s, 0) from orders o left join r on r.order_id = o.id",
    "select country_code, rank() over (order by count(*) desc) from customers group by 1",
    "select date_trunc('month', ordered_at) m, count(*) filter (where status = 'completed') from orders group by 1",
    "select * from orders where id in (select order_id from order_items where quantity > 2)",
    "select extract(month from ordered_at), case when status = 'completed' then 1 else 0 end from orders limit 5",
    "select g.d from generate_series($1::timestamptz, $2::timestamptz, interval '1 month') as g(d)",
    "select definitions->>'net_revenue' from agent_contract",
    "select 1 -- trailing comment",
    "select 1;",
  ])("accepts %s", (sql) => {
    const r = ok(sql);
    expect(r.ok, r.ok ? "" : r.message).toBe(true);
  });

  it("wraps the statement with a row cap", () => {
    const r = ok("select id from orders order by id");
    expect(r.ok && r.wrapped).toMatch(/^select \* from \(\nselect id from orders order by id\n\) as agent_result limit 201$/);
  });

  it("reports the relations and the highest parameter", () => {
    const r = ok("select o.id from orders o join customers c on c.id = o.customer_id where o.id = $2");
    expect(r.ok && r.relations).toEqual(["customers", "orders"]);
    expect(r.ok && r.paramCount).toBe(2);
  });
});

describe("the SQL policy refuses everything else", () => {
  it.each([
    ["a write", "delete from orders"],
    ["an update", "update orders set status = 'x'"],
    ["two statements", "select 1; delete from orders"],
    ["a writable CTE", "with d as (delete from orders returning id) select * from d"],
    ["SELECT INTO", "select * into stolen from orders"],
    ["a lock", "select * from orders for update"],
    ["a share lock", "select * from orders for share"],
    ["a catalog read", "select * from pg_catalog.pg_class"],
    ["an unqualified catalog read", "select * from pg_roles"],
    ["information_schema", "select * from information_schema.tables"],
    ["another schema", "select * from agentctl.runs"],
    ["an unknown function", "select pg_sleep(10)"],
    ["a file read", "select pg_read_file('/etc/passwd')"],
    ["set_config", "select set_config('statement_timeout', '0', false)"],
    ["a clock function", "select now()"],
    ["current_date", "select current_date"],
    ["a reg cast", "select 'pg_class'::regclass"],
    ["a recursive CTE", "with recursive t(n) as (select 1 union all select n + 1 from t) select * from t"],
    ["a schema-qualified function", "select public.sum(1)"],
    ["dblink", "select * from dblink('x', 'select 1') as t(a int)"],
    ["COPY", "copy orders to stdout"],
    ["CALL", "call do_things()"],
    ["DO", "do $$ begin perform 1; end $$"],
    ["EXPLAIN", "explain select 1"],
    ["DDL", "create table x (a int)"],
    ["a set-returning function outside the list", "select * from pg_ls_dir('.')"],
    ["a syntax error", "selec 1"],
    ["a wrapper escape", "select 1) as x; drop table orders; select * from (select 1"],
    ["a database-qualified name", "select * from neondb.commerce.orders"],
  ])("refuses %s", (_label, sql) => {
    expect(ok(sql).ok).toBe(false);
  });
});
