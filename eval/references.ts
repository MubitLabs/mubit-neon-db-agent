/**
 * Trusted reference queries. They run outside the agent, under the evaluation credential, on the same snapshot.
 * Every template has a v1 and a v2 form; the business meaning is identical, only the physical schema differs.
 */

export type SchemaVersion = "v1" | "v2";
export type Reference = { sql: string; params: string[] };
export type Shape = { columns: string[]; ordered: boolean; keyColumns: number[] };

export type Template = {
  id: string;
  intent: string;
  shape: (p: Params) => Shape;
  question: (p: Params) => string;
  reference: (version: SchemaVersion, p: Params) => Reference;
};

export type Params = { month: string; prevMonth: string; limit: number };

export function monthRange(month: string): [string, string] {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const start = new Date(Date.UTC(y, m - 1, 1)).toISOString();
  const end = new Date(Date.UTC(y, m, 1)).toISOString();
  return [start, end];
}

export function monthName(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** Net revenue per order, for each schema version: completed orders, gross minus succeeded refunds. */
const NET_ORDERS: Record<SchemaVersion, string> = {
  v1: `select o.id, o.customer_id, o.ordered_at, (o.gross_cents - o.refund_cents) as net_cents, o.gross_cents, o.refund_cents as refunded_cents
       from commerce.orders o where o.status = 'completed'`,
  v2: `select o.id, o.customer_id, o.ordered_at, (o.subtotal_cents - coalesce(r.ok, 0)) as net_cents, o.subtotal_cents as gross_cents, coalesce(r.ok, 0) as refunded_cents
       from commerce.orders o
       left join (select order_id, sum(amount_cents) as ok from commerce.refunds where status = 'succeeded' group by order_id) r on r.order_id = o.id
       where o.status = 'completed'`,
};

const inMonth = "n.ordered_at >= $1::timestamptz and n.ordered_at < $2::timestamptz";

export const TEMPLATES: Template[] = [
  {
    id: "net_by_country",
    intent: "aggregation",
    shape: () => ({ columns: ["country_code", "net_revenue_cents"], ordered: false, keyColumns: [0] }),
    question: (p) => `What was net revenue by country in ${monthName(p.month)}? Return country_code and net_revenue_cents, one row per country with at least one completed order that month.`,
    reference: (v, p) => ({
      sql: `select c.country_code, sum(n.net_cents)::bigint as net_revenue_cents
            from (${NET_ORDERS[v]}) n join commerce.customers c on c.id = n.customer_id
            where ${inMonth} group by c.country_code`,
      params: monthRange(p.month),
    }),
  },
  {
    id: "net_total",
    intent: "aggregation",
    shape: () => ({ columns: ["net_revenue_cents"], ordered: true, keyColumns: [] }),
    question: (p) => `What was total net revenue in ${monthName(p.month)}? Return one row with net_revenue_cents.`,
    reference: (v, p) => ({ sql: `select coalesce(sum(n.net_cents), 0)::bigint as net_revenue_cents from (${NET_ORDERS[v]}) n where ${inMonth}`, params: monthRange(p.month) }),
  },
  {
    id: "country_drop",
    intent: "time_comparison",
    shape: () => ({ columns: ["country_code", "first_month_cents", "second_month_cents", "drop_cents"], ordered: true, keyColumns: [0] }),
    question: (p) =>
      `Which ${p.limit} countries had the largest net revenue drop from ${monthName(p.prevMonth)} to ${monthName(p.month)}? Return country_code, first_month_cents, second_month_cents and drop_cents (first minus second), only countries whose net revenue fell, ordered by drop_cents descending then country_code ascending.`,
    reference: (v, p) => {
      const [a1, a2] = monthRange(p.prevMonth);
      const [, b2] = monthRange(p.month);
      return {
        sql: `with per as (
                select c.country_code,
                       coalesce(sum(n.net_cents) filter (where n.ordered_at >= $1::timestamptz and n.ordered_at < $2::timestamptz), 0)::bigint as a,
                       coalesce(sum(n.net_cents) filter (where n.ordered_at >= $2::timestamptz and n.ordered_at < $3::timestamptz), 0)::bigint as b
                from (${NET_ORDERS[v]}) n join commerce.customers c on c.id = n.customer_id
                where n.ordered_at >= $1::timestamptz and n.ordered_at < $3::timestamptz
                group by c.country_code)
              select country_code, a as first_month_cents, b as second_month_cents, (a - b) as drop_cents
              from per where a - b > 0 order by drop_cents desc, country_code asc limit $4::int`,
        params: [a1, a2, b2, String(p.limit)],
      };
    },
  },
  {
    id: "repeat_customers_by_country",
    intent: "repeat_customers",
    shape: () => ({ columns: ["country_code", "repeat_customers"], ordered: false, keyColumns: [0] }),
    question: (p) =>
      `How many repeat customers did each country have in ${monthName(p.month)}? Return country_code and repeat_customers, one row per country with at least one repeat customer.`,
    reference: (_v, p) => ({
      sql: `select c.country_code, count(*)::bigint as repeat_customers
            from (select o.customer_id from commerce.orders o
                  where o.status = 'completed' and o.ordered_at >= $1::timestamptz and o.ordered_at < $2::timestamptz
                  group by o.customer_id having count(*) >= 2) r
            join commerce.customers c on c.id = r.customer_id group by c.country_code`,
      params: monthRange(p.month),
    }),
  },
  {
    id: "repeat_net_by_country",
    intent: "repeat_customers",
    shape: () => ({ columns: ["country_code", "net_revenue_cents"], ordered: false, keyColumns: [0] }),
    question: (p) =>
      `Compare ${monthName(p.month)} net revenue for repeat customers by country. Return country_code and net_revenue_cents from the completed orders of customers who are repeat customers in that month.`,
    reference: (v, p) => ({
      sql: `with n as (${NET_ORDERS[v]}),
                 m as (select * from n where ${inMonth}),
                 rep as (select customer_id from m group by customer_id having count(*) >= 2)
            select c.country_code, sum(m.net_cents)::bigint as net_revenue_cents
            from m join rep on rep.customer_id = m.customer_id join commerce.customers c on c.id = m.customer_id
            group by c.country_code`,
      params: monthRange(p.month),
    }),
  },
  {
    id: "gross_sales_by_category",
    intent: "join_fanout",
    shape: () => ({ columns: ["category", "gross_sales_cents"], ordered: false, keyColumns: [0] }),
    question: (p) => `What were gross sales by product category in ${monthName(p.month)}? Return category and gross_sales_cents.`,
    reference: (_v, p) => ({
      sql: `select pr.category, sum(i.quantity * i.unit_price_cents)::bigint as gross_sales_cents
            from commerce.orders o join commerce.order_items i on i.order_id = o.id join commerce.products pr on pr.id = i.product_id
            where o.status = 'completed' and o.ordered_at >= $1::timestamptz and o.ordered_at < $2::timestamptz
            group by pr.category`,
      params: monthRange(p.month),
    }),
  },
  {
    id: "refunds_by_country",
    intent: "refund_handling",
    shape: () => ({ columns: ["country_code", "gross_cents", "refunded_cents"], ordered: false, keyColumns: [0] }),
    question: (p) =>
      `For completed orders placed in ${monthName(p.month)}, return country_code, gross_cents and refunded_cents by country, where refunded_cents counts the successful refunds of those orders.`,
    reference: (v, p) => ({
      sql: `select c.country_code, sum(n.gross_cents)::bigint as gross_cents, sum(n.refunded_cents)::bigint as refunded_cents
            from (${NET_ORDERS[v]}) n join commerce.customers c on c.id = n.customer_id where ${inMonth} group by c.country_code`,
      params: monthRange(p.month),
    }),
  },
  {
    id: "status_counts",
    intent: "aggregation",
    shape: () => ({ columns: ["status", "order_count"], ordered: false, keyColumns: [0] }),
    question: (p) => `How many orders of each status were placed in ${monthName(p.month)}? Return status and order_count.`,
    reference: (_v, p) => ({
      sql: `select o.status, count(*)::bigint as order_count from commerce.orders o
            where o.ordered_at >= $1::timestamptz and o.ordered_at < $2::timestamptz group by o.status`,
      params: monthRange(p.month),
    }),
  },
  {
    id: "avg_net_order_value",
    intent: "refund_handling",
    shape: () => ({ columns: ["avg_net_order_value_cents"], ordered: true, keyColumns: [] }),
    question: (p) =>
      `What was the average net order value of completed orders placed in ${monthName(p.month)}, rounded to whole cents? Return one row with avg_net_order_value_cents.`,
    reference: (v, p) => ({ sql: `select round(avg(n.net_cents))::bigint as avg_net_order_value_cents from (${NET_ORDERS[v]}) n where ${inMonth}`, params: monthRange(p.month) }),
  },
  {
    id: "top_products_units",
    intent: "join_fanout",
    shape: () => ({ columns: ["product_id", "name", "units"], ordered: true, keyColumns: [0] }),
    question: (p) =>
      `Which ${p.limit} products sold the most units in completed orders placed in ${monthName(p.month)}? Return product_id, name and units, ordered by units descending then product_id ascending.`,
    reference: (_v, p) => ({
      sql: `select pr.id as product_id, pr.name, sum(i.quantity)::bigint as units
            from commerce.orders o join commerce.order_items i on i.order_id = o.id join commerce.products pr on pr.id = i.product_id
            where o.status = 'completed' and o.ordered_at >= $1::timestamptz and o.ordered_at < $2::timestamptz
            group by pr.id, pr.name order by units desc, product_id asc limit $3::int`,
      params: [...monthRange(p.month), String(p.limit)],
    }),
  },
  {
    id: "new_customers_ordering",
    intent: "aggregation",
    shape: () => ({ columns: ["country_code", "customers"], ordered: false, keyColumns: [0] }),
    question: (p) =>
      `How many customers created in ${monthName(p.month)} placed a completed order in that same month, by country? Return country_code and customers, one row per country with at least one such customer.`,
    reference: (_v, p) => ({
      sql: `select c.country_code, count(distinct c.id)::bigint as customers
            from commerce.customers c join commerce.orders o on o.customer_id = c.id
            where c.created_at >= $1::timestamptz and c.created_at < $2::timestamptz
              and o.status = 'completed' and o.ordered_at >= $1::timestamptz and o.ordered_at < $2::timestamptz
            group by c.country_code`,
      params: monthRange(p.month),
    }),
  },
  {
    id: "net_multi_item_by_country",
    intent: "join_fanout",
    shape: () => ({ columns: ["country_code", "net_revenue_cents"], ordered: false, keyColumns: [0] }),
    question: (p) =>
      `What was net revenue from completed orders with more than one item, placed in ${monthName(p.month)}, by country? Return country_code and net_revenue_cents.`,
    reference: (v, p) => ({
      sql: `with multi as (select order_id from commerce.order_items group by order_id having count(*) > 1)
            select c.country_code, sum(n.net_cents)::bigint as net_revenue_cents
            from (${NET_ORDERS[v]}) n join multi on multi.order_id = n.id join commerce.customers c on c.id = n.customer_id
            where ${inMonth} group by c.country_code`,
      params: monthRange(p.month),
    }),
  },
];
