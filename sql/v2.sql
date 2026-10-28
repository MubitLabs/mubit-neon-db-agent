-- Acme Commerce, migration v1 -> v2: refunds move from orders.refund_cents to commerce.refunds.
-- The operator CLI (`npm run demo:migrate`) runs this inside one transaction on a disposable branch and checks the
-- monetary invariants before and after (src/migrate.ts); any mismatch rolls the whole migration back.
-- The business definitions do not change, so agent_contract.semantic_version stays the same.

alter table commerce.orders rename column gross_cents to subtotal_cents;
comment on column commerce.orders.subtotal_cents is 'Order subtotal in USD cents: the sum of quantity * unit_price_cents over its items.';

create table commerce.refunds (
  id bigint generated always as identity primary key,
  order_id integer not null references commerce.orders (id),
  amount_cents bigint not null check (amount_cents > 0),
  status text not null check (status in ('succeeded', 'pending', 'failed')),
  processed_at timestamptz not null
);
create index refunds_order on commerce.refunds (order_id);
comment on table commerce.refunds is 'Refund attempts. An order can have several. Only succeeded refunds return money.';
comment on column commerce.refunds.status is 'succeeded, pending or failed. Only succeeded refunds reduce revenue.';
comment on column commerce.refunds.processed_at is 'When the refund was processed (UTC). This is not the revenue date.';

-- Each positive v1 refund becomes one to three succeeded rows that sum to it exactly. Several rows per order and
-- processed_at dates in later months make the refund fan-out and the attribution date matter.
insert into commerce.refunds (order_id, amount_cents, status, processed_at)
select o.id,
       case when g.i < n.parts then o.refund_cents / n.parts
            else o.refund_cents - (o.refund_cents / n.parts) * (n.parts - 1) end,
       'succeeded',
       o.ordered_at + make_interval(days => 2 + g.i * 9 + (o.id % 13))
from commerce.orders o
cross join lateral (
  select case when o.refund_cents >= 3 and o.id % 3 = 0 then 3
              when o.refund_cents >= 2 and o.id % 3 = 1 then 2
              else 1 end as parts
) n
cross join lateral generate_series(1, n.parts) as g(i)
where o.refund_cents > 0;

-- Pending and failed attempts that must not change net revenue.
insert into commerce.refunds (order_id, amount_cents, status, processed_at)
select o.id, least(o.subtotal_cents, 500 + (o.id % 7) * 100), 'pending', o.ordered_at + interval '20 days'
from commerce.orders o
where o.status = 'completed' and o.subtotal_cents > 0 and o.id % 17 = 0;

insert into commerce.refunds (order_id, amount_cents, status, processed_at)
select o.id, greatest(1, o.subtotal_cents / 2), 'failed', o.ordered_at + interval '6 days'
from commerce.orders o
where o.status = 'completed' and o.subtotal_cents > 0 and o.id % 23 = 0;

-- The conversion must be exact before the old column goes.
do $$
declare bad integer;
begin
  select count(*) into bad
  from commerce.orders o
  left join (
    select order_id, sum(amount_cents) as ok_cents
    from commerce.refunds where status = 'succeeded' group by order_id
  ) r on r.order_id = o.id
  where o.refund_cents <> coalesce(r.ok_cents, 0);
  if bad <> 0 then
    raise exception 'refund conversion mismatch on % orders', bad;
  end if;
end $$;

alter table commerce.orders drop column refund_cents;

update commerce.schema_meta set schema_version = 'v2', migration_id = '2026-10-acme-v2-refunds-table', applied_at = now();
