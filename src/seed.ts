import type pg from "pg";

/** Fixed reporting clock: the data covers the 12 months before it. */
export const REPORTING_CLOCK = Date.UTC(2026, 9, 1); // 2026-10-01T00:00:00Z
export const WINDOW_START = Date.UTC(2025, 9, 1); // 2025-10-01T00:00:00Z

export const SIZES = { customers: 5_000, products: 500, orders: 100_000 } as const;

const COUNTRIES: [string, number][] = [
  ["US", 26], ["GB", 12], ["DE", 11], ["FR", 9], ["CA", 7], ["NL", 6],
  ["ES", 6], ["IT", 6], ["AU", 5], ["JP", 5], ["BR", 4], ["IN", 3],
];
/** Customers of this country stop ordering before June 2026, so later months are empty for it. */
const QUIET_COUNTRY = "NZ";
const QUIET_COUNTRY_LAST_ORDER = Date.UTC(2026, 5, 1);
const CATEGORIES = ["electronics", "home", "apparel", "beauty", "sports", "books", "toys", "grocery"];

export type SeedData = {
  customers: { id: number; country: string; createdAt: number }[];
  products: { id: number; category: string; name: string; price: number }[];
  orders: { id: number; customerId: number; orderedAt: number; status: string; gross: number; refund: number }[];
  items: { orderId: number; productId: number; quantity: number; unitPrice: number }[];
};

/** A small, fast, seeded PRNG (mulberry32), so the same seed always gives the same data. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted<T>(rand: () => number, entries: [T, number][]): T {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [v, w] of entries) {
    if ((r -= w) < 0) return v;
  }
  return entries[entries.length - 1]![0];
}

function monthStart(i: number): number {
  return Date.UTC(2025, 9 + i, 1);
}

/** Each country's monthly demand factor, so month-over-month changes differ by country. */
export function countryMonthFactor(country: string, month: number): number {
  const phase = [...country].reduce((s, c) => s + c.charCodeAt(0), 0) % 7;
  return 1 + 0.28 * Math.sin(phase + month * 0.95) + (month >= 9 ? 0.06 * ((phase % 3) - 1) : 0);
}

export function generate(seed = 42): SeedData {
  const rand = rng(seed);
  const customers: SeedData["customers"] = [];
  for (let id = 1; id <= SIZES.customers; id++) {
    const country = id % 125 === 0 ? QUIET_COUNTRY : pickWeighted(rand, COUNTRIES);
    // Accounts created from 2024-01-01 to 2026-09-28.
    const createdAt = Date.UTC(2024, 0, 1) + Math.floor(rand() * (Date.UTC(2026, 8, 28) - Date.UTC(2024, 0, 1)));
    customers.push({ id, country, createdAt });
  }
  const products: SeedData["products"] = [];
  for (let id = 1; id <= SIZES.products; id++) {
    const category = CATEGORIES[(id - 1) % CATEGORIES.length]!;
    const price = 199 + Math.floor(rand() * 19_800);
    products.push({ id, category, name: `${category[0]!.toUpperCase()}${category.slice(1)} item ${String(id).padStart(3, "0")}`, price });
  }

  const byCountry = new Map<string, number[]>();
  for (const c of customers) {
    const list = byCountry.get(c.country) ?? [];
    list.push(c.id);
    byCountry.set(c.country, list);
  }
  const countryWeights: [string, number][] = [...COUNTRIES, [QUIET_COUNTRY, 0.8]];

  const orders: SeedData["orders"] = [];
  const items: SeedData["items"] = [];
  let id = 0;
  while (orders.length < SIZES.orders) {
    const month = Math.min(11, Math.floor(rand() * 12));
    const country = pickWeighted(rand, countryWeights);
    if (rand() > countryMonthFactor(country, month) / 1.4) continue; // demand varies by country and month
    const start = monthStart(month);
    const end = monthStart(month + 1);
    const orderedAt = start + Math.floor(rand() * (end - start));
    if (country === QUIET_COUNTRY && orderedAt >= QUIET_COUNTRY_LAST_ORDER) continue;
    const pool = byCountry.get(country)!;
    const customerId = pool[Math.floor(rand() * pool.length)]!;
    const customer = customers[customerId - 1]!;
    if (customer.createdAt > orderedAt) continue;

    id += 1;
    const lineCount = 1 + Math.floor(Math.pow(rand(), 1.7) * 4);
    const chosen = new Set<number>();
    let gross = 0;
    while (chosen.size < lineCount) {
      const productId = 1 + Math.floor(rand() * SIZES.products);
      if (chosen.has(productId)) continue;
      chosen.add(productId);
      const quantity = rand() < 0.7 ? 1 : rand() < 0.7 ? 2 : 3;
      const unitPrice = products[productId - 1]!.price;
      gross += quantity * unitPrice;
      items.push({ orderId: id, productId, quantity, unitPrice });
    }
    const s = rand();
    const status = s < 0.88 ? "completed" : s < 0.96 ? "canceled" : "pending";
    let refund = 0;
    const r = rand();
    if (status === "completed") {
      if (r >= 0.84 && r < 0.95) refund = Math.max(1, Math.min(gross - 1, Math.floor(gross * (0.05 + 0.85 * rand()))));
      else if (r >= 0.95) refund = gross;
    } else if (status === "canceled" && r < 0.3) {
      refund = gross; // a refunded cancellation: still no revenue
    }
    orders.push({ id, customerId, orderedAt, status, gross, refund });
  }

  // Boundary cases at the August/September edge: one completed order at the first instant of September and one in the
  // last second of August, both with partial refunds.
  const edges: [number, number][] = [
    [orders.length - 1, Date.UTC(2026, 8, 1, 0, 0, 0)],
    [orders.length - 2, Date.UTC(2026, 7, 31, 23, 59, 59)],
  ];
  for (const [index, at] of edges) {
    const o = orders[index]!;
    const customer = customers[o.customerId - 1]!;
    o.orderedAt = Math.max(at, customer.createdAt) === at ? at : o.orderedAt;
    o.status = "completed";
    o.refund = Math.floor(o.gross / 3);
  }
  return { customers, products, orders, items };
}

async function insertBatches(client: pg.ClientBase, sql: string, columns: unknown[][], batch = 10_000): Promise<void> {
  const length = columns[0]!.length;
  for (let i = 0; i < length; i += batch) {
    await client.query(sql, columns.map((c) => c.slice(i, i + batch)));
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Inserts the generated data with batched unnest inserts. Runs inside the caller's transaction. */
export async function insertSeed(client: pg.ClientBase, data: SeedData): Promise<void> {
  await insertBatches(
    client,
    "insert into commerce.customers (id, country_code, created_at) select * from unnest($1::int[], $2::text[], $3::timestamptz[])",
    [data.customers.map((c) => c.id), data.customers.map((c) => c.country), data.customers.map((c) => iso(c.createdAt))],
  );
  await insertBatches(
    client,
    "insert into commerce.products (id, category, name) select * from unnest($1::int[], $2::text[], $3::text[])",
    [data.products.map((p) => p.id), data.products.map((p) => p.category), data.products.map((p) => p.name)],
  );
  await insertBatches(
    client,
    "insert into commerce.orders (id, customer_id, ordered_at, status, gross_cents, refund_cents) select * from unnest($1::int[], $2::int[], $3::timestamptz[], $4::text[], $5::bigint[], $6::bigint[])",
    [
      data.orders.map((o) => o.id),
      data.orders.map((o) => o.customerId),
      data.orders.map((o) => iso(o.orderedAt)),
      data.orders.map((o) => o.status),
      data.orders.map((o) => String(o.gross)),
      data.orders.map((o) => String(o.refund)),
    ],
  );
  await insertBatches(
    client,
    "insert into commerce.order_items (order_id, product_id, quantity, unit_price_cents) select * from unnest($1::int[], $2::int[], $3::int[], $4::bigint[])",
    [data.items.map((i) => i.orderId), data.items.map((i) => i.productId), data.items.map((i) => i.quantity), data.items.map((i) => String(i.unitPrice))],
  );
}
