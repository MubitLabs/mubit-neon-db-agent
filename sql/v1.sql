-- Acme Commerce, schema v1. Applied by the operator CLI (`npm run demo:prepare`) on the seed branch.
-- Money is integer USD cents; every timestamp is timestamptz and every reporting boundary is UTC.

create schema if not exists commerce;
comment on schema commerce is 'Acme Commerce: a fictional online store. Synthetic data, reporting clock 2026-10-01T00:00:00Z.';

create table commerce.customers (
  id integer primary key,
  country_code char(2) not null,
  created_at timestamptz not null
);
comment on table commerce.customers is 'One row per customer account.';
comment on column commerce.customers.country_code is 'ISO 3166-1 alpha-2 country of the customer.';
comment on column commerce.customers.created_at is 'When the customer account was created (UTC).';

create table commerce.products (
  id integer primary key,
  category text not null,
  name text not null
);
comment on table commerce.products is 'Catalog products.';
comment on column commerce.products.category is 'Product category, lower case.';

create table commerce.orders (
  id integer primary key,
  customer_id integer not null references commerce.customers (id),
  ordered_at timestamptz not null,
  status text not null check (status in ('completed', 'canceled', 'pending')),
  gross_cents bigint not null check (gross_cents >= 0),
  refund_cents bigint not null default 0 check (refund_cents >= 0 and refund_cents <= gross_cents)
);
create index orders_ordered_at on commerce.orders (ordered_at);
create index orders_customer on commerce.orders (customer_id);
comment on table commerce.orders is 'One row per order. An order has one or more order_items.';
comment on column commerce.orders.ordered_at is 'When the order was placed (UTC). Revenue is attributed to this date.';
comment on column commerce.orders.status is 'completed, canceled or pending. Only completed orders realize revenue.';
comment on column commerce.orders.gross_cents is 'Order subtotal in USD cents: the sum of quantity * unit_price_cents over its items.';
comment on column commerce.orders.refund_cents is 'Total successful refunds for the order in USD cents, between 0 and gross_cents.';

create table commerce.order_items (
  order_id integer not null references commerce.orders (id),
  product_id integer not null references commerce.products (id),
  quantity integer not null check (quantity > 0),
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  primary key (order_id, product_id)
);
create index order_items_product on commerce.order_items (product_id);
comment on table commerce.order_items is 'Order lines. One row per product in an order.';
comment on column commerce.order_items.unit_price_cents is 'Price of one unit in USD cents at order time.';

create table commerce.agent_contract (
  semantic_version text primary key,
  definitions jsonb not null
);
comment on table commerce.agent_contract is 'Business definitions every analysis must follow.';

create table commerce.schema_meta (
  schema_version text not null,
  migration_id text not null,
  applied_at timestamptz not null default now()
);
comment on table commerce.schema_meta is 'The physical schema version of this database.';

insert into commerce.agent_contract (semantic_version, definitions) values (
  '2026-10-acme-1',
  '{
    "reporting_clock": "2026-10-01T00:00:00Z. Treat this as now; do not use the database clock.",
    "money": "All amounts are USD integer cents. Report cents unless the question asks otherwise.",
    "time": "All reporting boundaries are UTC. A month is the half-open range [first day 00:00, first day of next month 00:00).",
    "net_revenue": "For completed orders only: the order gross amount minus its successful refunds, attributed to the month of the order''s original ordered_at, whenever the refund was processed. Canceled and pending orders contribute nothing.",
    "gross_sales": "For completed orders only: the sum of quantity * unit_price_cents of their items.",
    "repeat_customer": "A customer with at least two completed orders whose ordered_at falls in the requested period.",
    "new_customer": "A customer whose created_at falls in the requested period.",
    "month_comparison": "Compare full UTC calendar months with half-open boundaries.",
    "ranking": "When ranking, order by the measure and break ties by the stated key ascending."
  }'::jsonb
);

insert into commerce.schema_meta (schema_version, migration_id) values ('v1', '2026-10-acme-v1-initial');
