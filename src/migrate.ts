import { readFileSync } from "node:fs";
import type pg from "pg";

/** The monetary facts the v1 → v2 migration must preserve. All values are exact integers, as strings. */
export type Invariants = {
  completedOrders: string;
  completedGrossCents: string;
  completedSucceededRefundCents: string;
  netRevenueCents: string;
};

export async function readInvariants(client: pg.ClientBase, version: "v1" | "v2"): Promise<Invariants> {
  const sql =
    version === "v1"
      ? `select count(*)::text as completed_orders,
                coalesce(sum(gross_cents), 0)::text as gross,
                coalesce(sum(refund_cents), 0)::text as refunds,
                coalesce(sum(gross_cents - refund_cents), 0)::text as net
         from commerce.orders where status = 'completed'`
      : `with r as (
           select order_id, sum(amount_cents) as ok_cents
           from commerce.refunds where status = 'succeeded' group by order_id
         )
         select count(*)::text as completed_orders,
                coalesce(sum(o.subtotal_cents), 0)::text as gross,
                coalesce(sum(coalesce(r.ok_cents, 0)), 0)::text as refunds,
                coalesce(sum(o.subtotal_cents - coalesce(r.ok_cents, 0)), 0)::text as net
         from commerce.orders o left join r on r.order_id = o.id
         where o.status = 'completed'`;
  const { rows } = await client.query(sql);
  const row = rows[0] as { completed_orders: string; gross: string; refunds: string; net: string };
  return {
    completedOrders: row.completed_orders,
    completedGrossCents: row.gross,
    completedSucceededRefundCents: row.refunds,
    netRevenueCents: row.net,
  };
}

export async function schemaVersion(client: pg.ClientBase): Promise<string> {
  const { rows } = await client.query("select schema_version from commerce.schema_meta");
  return (rows[0] as { schema_version: string } | undefined)?.schema_version ?? "unknown";
}

/**
 * Applies sql/v2.sql in one transaction and commits only when every invariant is equal before and after.
 * Run it on a disposable branch; it refuses a database that is not at v1.
 */
export async function migrateToV2(client: pg.ClientBase, sqlPath: string): Promise<{ before: Invariants; after: Invariants }> {
  const migration = readFileSync(sqlPath, "utf8");
  await client.query("begin");
  try {
    const version = await schemaVersion(client);
    if (version !== "v1") throw new Error(`refusing to migrate: schema_version is ${version}, not v1`);
    const before = await readInvariants(client, "v1");
    await client.query(migration);
    const after = await readInvariants(client, "v2");
    const differing = (Object.keys(before) as (keyof Invariants)[]).filter((k) => before[k] !== after[k]);
    if (differing.length > 0) throw new Error(`invariants changed: ${differing.join(", ")}`);
    await client.query("commit");
    return { before, after };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}
