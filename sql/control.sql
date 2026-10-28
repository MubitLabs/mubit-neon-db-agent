-- The control database: runs, their ordered events, learning deliveries and evaluations.
-- It lives apart from the demo branches, so runs survive branch resets and migrations.

create schema if not exists agentctl;

create table if not exists agentctl.runs (
  id text primary key,
  tenant_id text not null,
  environment_id text not null,
  mode text not null check (mode in ('baseline', 'calibration')),
  idempotency_key text not null,
  input_hash text not null,
  question text not null,
  status text not null check (status in ('running', 'answered', 'abstained', 'failed')),
  scope jsonb,
  requested_route jsonb,
  served_identity jsonb,
  answer jsonb,
  usage jsonb,
  calibration_status text,
  verification text not null default 'unverified' check (verification in ('unverified', 'execution_only', 'verified', 'rejected')),
  evaluation boolean not null default false,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (tenant_id, idempotency_key)
);
create index if not exists runs_tenant_started on agentctl.runs (tenant_id, started_at desc);

create table if not exists agentctl.events (
  id text primary key,
  run_id text not null references agentctl.runs (id),
  sequence integer not null,
  kind text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (run_id, sequence)
);
create index if not exists events_run_sequence on agentctl.events (run_id, sequence);

create table if not exists agentctl.learning_deliveries (
  id text primary key,
  run_id text not null references agentctl.runs (id),
  kind text not null check (kind in ('lesson', 'outcome')),
  payload jsonb not null,
  idempotency_key text not null unique,
  status text not null check (status in ('pending', 'delivered', 'failed')),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);
create index if not exists deliveries_pending on agentctl.learning_deliveries (status) where status <> 'delivered';

create table if not exists agentctl.evaluations (
  id text primary key,
  manifest jsonb not null,
  results jsonb not null,
  created_at timestamptz not null default now()
);
