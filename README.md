# Acme Data Analyst: a Mubit + Neon template

A database exploration agent that answers business questions over Neon Postgres, runs on Neon Functions, and sends
every model call through Mubit to the Neon AI Gateway. Use it as a template for an agent that improves with use.

Mubit improves the agent in two ways:

- **Runtime calibration.**
  - When a run is verified, by a trusted reference or a reviewer, it yields up to three short lessons. Mubit stores them.
  - Later runs recall the lessons that fit their database, business contract and schema.
  - After a schema change, mappings that no longer apply are set aside, and the agent inspects the new schema itself.
- **Open-weight models.**
  - Every call carries the same instructions, tools, response format and model, so Mubit groups the agent's calls into one task and records them.
  - Over time, Mubit prepares an open-weight model for that task from the recorded calls and the verdicts the agent reports.
  - Evaluation calls send `x-middleware-record: metadata`, so they never become training data.

## Architecture

```
client ── Bearer DEMO_ACCESS_TOKEN ──▶ Neon Function dbagent (HTTP API, branch agent-control)
schedule trigger, every 15 minutes ──▶    │  POST /triggers/deliveries: send the deliveries still pending
                                          │  runs, events, deliveries ──▶ control database (agent-control)
                                          │  list_tables / describe_table / query ──▶ demo branch, as agent_reader
                                          │  model calls ──▶ api.mubit.ai/openai/v1 ──▶ Neon AI Gateway ──▶ model
                                          └  runtime calibration ──▶ api.mubit.ai/v2/control/ingest, /v2/core/search,
                                                                     /v2/control/outcome
```

The Mubit project the agent uses holds a Neon AI Gateway key and no other provider key, so its calls on
`/openai/v1` go to the Neon AI Gateway. Mubit uses a project's own provider key before its Neon key.

| File | What it does |
|---|---|
| `neon.ts` | The Function, its settings and its schedule trigger, applied by `npm run deploy` |
| `src/function.ts` | Neon Function entry point: `export default { fetch }` |
| `src/http.ts` | Bearer auth, the trigger route, request validation, the endpoints |
| `src/agent.ts` | The bounded agent loop |
| `src/prompt.ts` | Fixed instructions and tools: the stable task Mubit learns from |
| `src/db.ts`, `src/sqlpolicy.ts` | Catalog tools, query execution, the SQL policy |
| `src/mubit.ts` | Model transport, runtime calibration (recall, remember, report) and lesson scoping |
| `src/learning.ts` | Lessons from verified runs and their delivery to Mubit |
| `src/store.ts`, `sql/control.sql` | Runs, ordered events, learning deliveries, evaluations |
| `src/cli.ts` | Operator CLI: prepare, migrate, check, ask, verify, retry, eval |
| `sql/v1.sql`, `sql/v2.sql`, `src/seed.ts`, `src/migrate.ts` | The Acme Commerce schema, seed data and v1 → v2 migration |
| `sql/reader.sql` | The agent's read-only database role |
| `eval/` | 60 questions, trusted reference SQL, the comparison |

## The agent

Each question starts a fresh conversation. The loop has these limits:
- at most 8 model turns, 12 tool calls and 2 failed queries;
- 1 schema refresh after an undefined table or column;
- a 45 s deadline.

On the last allowed turn the model must answer from the evidence it has.

The final message must be the answer JSON. Its `resultQueryId` must name a successful query of the same run, and one
format correction is allowed.

The model has three tools: `list_tables`, `describe_table` and `query`. It never gets the whole schema up front.

The SQL policy (`src/sqlpolicy.ts`) parses every query with the PostgreSQL parser (libpg-query) and accepts exactly one
plain SELECT, using only:
- `commerce` relations and the query's own CTEs;
- a function allowlist and safe casts.

It refuses:
- catalog reads, locks and `SELECT INTO`;
- writable or recursive CTEs;
- clock functions.

Accepted queries run in a read-only transaction:
- `statement_timeout` 3 s, `lock_timeout` 500 ms, `idle_in_transaction_session_timeout` 5 s;
- at most 200 rows and 64 KiB of output;
- `bigint` and `numeric` results stay exact strings.

The role `agent_reader` has SELECT on `commerce` and nothing else: no memberships, no CREATE and no TEMP. Writes
fail even inside a read-write transaction.

## Runtime calibration in detail

A lesson has three parts: a kind, a text, and a header. The header names its database, namespace, business contract,
schema hash, and the tables and columns it uses.

| Kind | Applies when |
|---|---|
| semantic | same database and business contract |
| schema | the exact same schema hash |
| procedure | every table and column it names still exists |

A run becomes verified only through the evaluator's reference check or a reviewer's verdict
(`POST /runs/{id}/feedback`, or `npm run verify`). The lessons are written from templates over the run's evidence:
- a schema mapping;
- the verified SQL;
- a refund pre-aggregation rule, when it applies.

No model writes them. Lessons and verdicts are queued in the same transaction as the verdict, and the verdict request
sends them to Mubit, each with an idempotency key. A failed delivery stays pending.

A schedule trigger runs every 15 minutes and sends any delivery still pending. It is a Neon Function Trigger, declared
in `neon.ts`. Its rules:
- a delivery that has failed n times waits until 2^n minutes after it was queued;
- after 10 failed attempts it is marked `failed`, and only `npm run learning:retry` sends it;
- it sends only the deliveries of this deployment's runs: its tenant and calibration namespace.

A delivery is locked while it is sent, so the trigger and a verdict request never send the same one at once. The
idempotency keys keep a retry from duplicating anything.

## Data

Acme Commerce is a synthetic store, generated from seed 42, with a reporting clock of 2026-10-01T00:00Z:
- 5,000 customers, 500 products, 100,000 orders and about 205,000 order items over the previous 12 months;
- integer USD cents and UTC boundaries.

`commerce.agent_contract` holds the business definitions, and every mode gets them.

The v2 migration (`sql/v2.sql`):
- renames `orders.gross_cents` to `subtotal_cents`;
- moves refunds into `commerce.refunds`: several succeeded rows per refunded order, processed in later months, plus pending and failed rows;
- drops `refund_cents`.

`npm run demo:migrate` applies it in one transaction and commits only if completed orders, gross, succeeded refunds and
net revenue are equal before and after.

## Setup

Requires Node 24+, the Neon CLI signed in, a Neon project in a Functions region, and a Mubit project whose only provider
key is a Neon AI Gateway key.

```bash
npm ci
security add-generic-password -a "$USER" -s mubit-neon-demo-key -w      # the Mubit key, stored in the macOS keychain
npm run demo:prepare -- --neon --project-id <neon project id> --seed 42  # branches, seed, reader role, migration, control
npm run check                                                            # model route, tools + JSON output, calibration
npm run deploy                                                           # build dist/fn, apply neon.ts: Function + trigger
```

`npm run deploy -- --plan` shows what the deploy would change, and changes nothing.

`demo:prepare` creates four branches:
- `acme-v1`: the seeded parent;
- `demo-v1`;
- `demo-v2`: migrated to v2;
- `agent-control`: the control database.

It writes their connection strings and a `DEMO_ACCESS_TOKEN` to `.env` (mode 600). Your default branch is not changed.

For a local database:

```bash
docker run -d --name mubit-neon-demo-pg -e POSTGRES_PASSWORD=<pw> -p 127.0.0.1:55432:5432 postgres:18
LOCAL_PG_URL=postgres://postgres:<pw>@127.0.0.1:55432/postgres npm run demo:prepare -- --local
cp .env .env.test   # the database tests read .env.test
npm test
npm run dev         # the same HTTP API on http://localhost:8787
```

## HTTP API

Every endpoint except `/health` and `/triggers/deliveries` needs `Authorization: Bearer <DEMO_ACCESS_TOKEN>`.

`POST /triggers/deliveries` accepts only the schedule trigger's deliveries, which Neon sends without the bearer token.
`parseTriggerDelivery` (`@neon/functions/triggers`) requires the `x-neon-trigger-invocation-id` header and the same
`invocation_id` in the body. Neon's proxy removes `x-neon-*` headers from client requests, so a client cannot send
one to the deployed Function. Locally, `npm run dev` accepts a tick with that header.

| Endpoint | Does |
|---|---|
| `GET /health` | Service status |
| `POST /triggers/deliveries` | The schedule trigger: sends the pending deliveries → `{delivered, failed}` |
| `GET /environments` | The databases, their modes, the model and the Mubit route |
| `POST /runs` | `{environmentId, mode, question, idempotencyKey}` → run id and answer. `mode` is `baseline` or `calibration`. |
| `GET /runs/{id}` | The run, its ordered events (model replies with Mubit request IDs, tool calls, results) and its deliveries |
| `POST /runs/{id}/feedback` | `{verdict: "correct" or "incorrect", reason?}` → the verdict, lessons, delivery to Mubit |
| `GET /runs` | Recent runs |

Repeating a request with the same `idempotencyKey` returns the stored run. The same key with a different question
answers 409.

## Demo flow

```bash
npm run ask -- "What was net revenue by country in August 2026?" --environment demo-v1 --mode calibration
npm run verify -- <runId> --correct
npm run ask -- "Which countries had the largest net revenue drop from August to September 2026?" --mode calibration
npm run ask -- "Compare September 2026 net revenue for repeat customers by country." --environment demo-v2 --mode calibration
npm run walkthrough -- <function url>     # the same steps through the deployed Function's HTTP API
npm run check-run -- <runId> <template> <YYYY-MM>   # compare a run's answer table with the trusted reference
```

1. The first answer shows schema discovery, the SQL, the result and the Mubit request IDs.
2. The verdict sends lessons to Mubit.
3. The next related question recalls them.
4. On `demo-v2`, the v1 mappings are set aside and the agent works out the new refunds table.

## Evaluation

`eval/cases.ts` renders 12 question templates for 5 months each, giving 60 questions:
- 30 learning, 10 development and 20 final (10 on v1, 10 on v2);
- plus 10 paired diagnostic questions on both schema versions.

`eval/references.ts` holds trusted v1 and v2 SQL for every template.

The evaluator:
- runs the reference on the same branch under its own credential;
- compares the declared result table exactly, sorting unordered answers by their key and keeping rankings with their tie rule;
- checks that a one-value answer states the value.

Failed runs and abstentions count against the mode.

```bash
npm run eval -- --split learning --modes calibration --learn       # verified lessons go to Mubit
npm run eval -- --split final --modes baseline,calibration --repetitions 3
```

Results are written to `eval/out/<id>.json` and `.md`, and to `agentctl.evaluations`.

## Configuration

| Variable | Purpose |
|---|---|
| `AGENT_DATABASE_URL_DEMO_V1`, `_V2` | The agent's read-only role on each demo branch |
| `EVAL_DATABASE_URL_DEMO_V1`, `_V2` | The evaluator's credential (never given to the model) |
| `OPERATOR_DATABASE_URL_DEMO_V2` | Direct owner connection for `demo:migrate` |
| `CONTROL_DATABASE_URL` | Runs, events, deliveries; on the Function, the branch's `DATABASE_URL` |
| `MUBIT_API_KEY` | The Mubit project key (locally, read from the keychain item `mubit-neon-demo-key`) |
| `MUBIT_CONNECT_URL` | `https://api.mubit.ai/openai/v1` |
| `BASE_MODEL` | A model the Neon AI Gateway serves, e.g. `gemini-3-8-flash` |
| `RESPONSE_FORMAT` | `json_schema` (default), `json_object` or `none` |
| `MUBIT_SESSION_METADATA` | `off` for the Neon AI Gateway, whose upstream models refuse OpenAI's `metadata` field |
| `CALIBRATION_BACKEND` | `mubit` or `off` |
| `CALIBRATION_NAMESPACE` | The calibration cohort, e.g. one per experiment arm |
| `DEMO_ACCESS_TOKEN` | The bearer token for the HTTP API |
| `NEON_PROJECT_ID` | Used by `demo:prepare` and `deploy` |
