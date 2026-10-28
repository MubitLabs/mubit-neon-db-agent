import { createHash } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { readInvariants } from "../src/migrate.js";
import { generate } from "../src/seed.js";
import { TEMPLATES } from "../eval/references.js";
import { hasDb, LOCAL } from "./helpers.js";

describe("the seed", () => {
  it("is deterministic for a seed and differs across seeds", () => {
    const h = (seed: number) => createHash("sha256").update(JSON.stringify(generate(seed).orders.slice(0, 2_000))).digest("hex");
    expect(h(42)).toBe(h(42));
    expect(h(42)).not.toBe(h(43));
  });
  it("keeps refunds within gross and puts orders inside the 12 months", () => {
    const data = generate(42);
    for (const o of data.orders) {
      expect(o.refund).toBeGreaterThanOrEqual(0);
      expect(o.refund).toBeLessThanOrEqual(o.gross);
    }
    const times = data.orders.map((o) => o.orderedAt);
    expect(Math.min(...times)).toBeGreaterThanOrEqual(Date.UTC(2025, 9, 1));
    expect(Math.max(...times)).toBeLessThan(Date.UTC(2026, 9, 1));
  });
  it("has the boundary orders at the August/September edge", () => {
    const times = new Set(generate(42).orders.map((o) => o.orderedAt));
    expect(times.has(Date.UTC(2026, 8, 1, 0, 0, 0))).toBe(true);
  });
});

describe.skipIf(!hasDb)("v1 and v2 hold the same money", () => {
  const v1 = new pg.Client({ connectionString: LOCAL.owner });
  const v2 = new pg.Client({ connectionString: LOCAL.ownerV2 });
  afterAll(async () => {
    await v1.end().catch(() => undefined);
    await v2.end().catch(() => undefined);
  });

  it("has equal invariants on the two databases", async () => {
    await v1.connect();
    await v2.connect();
    expect(await readInvariants(v2, "v2")).toEqual(await readInvariants(v1, "v1"));
  });

  it("has orders with several succeeded refunds, and pending and failed refunds", async () => {
    const r = await v2.query(`select
        (select count(*) from (select order_id from commerce.refunds where status = 'succeeded' group by order_id having count(*) > 1) x)::int as multi,
        (select count(*) from commerce.refunds where status = 'pending')::int as pending,
        (select count(*) from commerce.refunds where status = 'failed')::int as failed,
        (select count(*) from commerce.refunds r join commerce.orders o on o.id = r.order_id where date_trunc('month', r.processed_at) <> date_trunc('month', o.ordered_at))::int as cross_month`);
    const row = r.rows[0];
    expect(row.multi).toBeGreaterThan(100);
    expect(row.pending).toBeGreaterThan(0);
    expect(row.failed).toBeGreaterThan(0);
    expect(row.cross_month).toBeGreaterThan(0);
  });

  it("makes the naive refund join wrong, so the evaluator can see fan-out", async () => {
    const t = TEMPLATES.find((x) => x.id === "net_multi_item_by_country")!;
    const ref = t.reference("v2", { month: "2026-08", prevMonth: "2026-07", limit: 3 });
    const right = await v2.query(`select sum(net_revenue_cents)::text as s from (${ref.sql}) x`, ref.params);
    const naive = await v2.query(
      `select sum(o.subtotal_cents - coalesce(r.amount_cents, 0))::text as s
       from commerce.orders o join commerce.order_items i on i.order_id = o.id
       left join commerce.refunds r on r.order_id = o.id and r.status = 'succeeded'
       where o.status = 'completed' and o.ordered_at >= $1::timestamptz and o.ordered_at < $2::timestamptz`,
      ref.params,
    );
    expect(naive.rows[0].s).not.toBe(right.rows[0].s);
  });

  it("answers every template on both versions with the same values", async () => {
    for (const t of TEMPLATES) {
      const p = { month: "2026-08", prevMonth: "2026-07", limit: 3 };
      const a = t.reference("v1", p);
      const b = t.reference("v2", p);
      const ra = await v1.query({ text: a.sql, values: a.params, rowMode: "array" });
      const rb = await v2.query({ text: b.sql, values: b.params, rowMode: "array" });
      const sort = (rows: unknown[][]) => rows.map((r) => JSON.stringify(r)).sort();
      expect(sort(rb.rows), t.id).toEqual(sort(ra.rows));
    }
  });
});
