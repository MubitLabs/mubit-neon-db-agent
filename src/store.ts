import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type pg from "pg";
import { LIMITS } from "./config.js";
import type { Answer, Mode, Verification } from "./types.js";

export type RunRow = {
  id: string;
  tenant_id: string;
  environment_id: string;
  mode: Mode;
  idempotency_key: string;
  input_hash: string;
  question: string;
  status: "running" | "answered" | "abstained" | "failed";
  scope: unknown;
  requested_route: unknown;
  served_identity: unknown;
  answer: Answer | null;
  usage: unknown;
  calibration_status: string | null;
  verification: Verification;
  evaluation: boolean;
  error: string | null;
  started_at: string;
  finished_at: string | null;
};

export type EventRow = { id: string; run_id: string; sequence: number; kind: string; payload: unknown; created_at: string };

export type Delivery = { id: string; runId: string; kind: "lesson" | "outcome"; payload: unknown; idempotencyKey: string };

/** Which unsent deliveries a sender takes. */
export type DeliverySelection = {
  /** Only this run's deliveries. */
  runId?: string;
  /**
   * The schedule trigger: only the runs of this tenant and calibration namespace, fewer than
   * LIMITS.maxDeliveryAttempts attempts, and due: a delivery that has failed n times waits until 2^n minutes after it
   * was queued.
   */
  due?: { tenantId: string; calibrationNamespace: string };
  /** Deliveries this pass already tried. */
  skip: string[];
};

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

export function inputHash(input: { environmentId: string; mode: string; question: string }): string {
  return createHash("sha256").update(JSON.stringify([input.environmentId, input.mode, input.question])).digest("hex");
}

/** Redacts anything that looks like a credential before it is stored. */
export function redact(value: unknown): unknown {
  const text = JSON.stringify(value ?? null)
    .replace(/(mbt_[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, "$1…")
    .replace(/(nt_live_)[A-Za-z0-9_-]+/g, "$1…")
    .replace(/postgres(ql)?:\/\/[^"\s]+/gi, "<connection>")
    .replace(/("authorization"\s*:\s*")[^"]*"/gi, '$1<redacted>"');
  return JSON.parse(text);
}

function capPayload(value: unknown, maxBytes = 96 * 1024): unknown {
  const v = redact(value);
  const text = JSON.stringify(v);
  if (Buffer.byteLength(text) <= maxBytes) return v;
  return { truncated: true, bytes: Buffer.byteLength(text), preview: text.slice(0, 2_000) };
}

export function createStore(pool: pg.Pool) {
  return {
    pool,

    async ensureSchema(sqlPath: string) {
      await pool.query(readFileSync(sqlPath, "utf8"));
    },

    /**
     * Claims a run for an idempotency key. A repeat with the same input returns the stored run (finished, or still
     * running); the same key with a different input is a conflict. A run left running past its deadline becomes failed.
     */
    async claim(input: { tenantId: string; environmentId: string; mode: Mode; question: string; idempotencyKey: string; evaluation: boolean }):
      Promise<{ kind: "new"; run: RunRow } | { kind: "existing"; run: RunRow } | { kind: "conflict" }> {
      const hash = inputHash(input);
      const id = newId("run");
      const inserted = await pool.query(
        `insert into agentctl.runs (id, tenant_id, environment_id, mode, idempotency_key, input_hash, question, status, evaluation)
         values ($1, $2, $3, $4, $5, $6, $7, 'running', $8)
         on conflict (tenant_id, idempotency_key) do nothing
         returning *`,
        [id, input.tenantId, input.environmentId, input.mode, input.idempotencyKey, hash, input.question, input.evaluation],
      );
      if (inserted.rows[0]) return { kind: "new", run: inserted.rows[0] as RunRow };
      const existing = (await pool.query("select * from agentctl.runs where tenant_id = $1 and idempotency_key = $2", [input.tenantId, input.idempotencyKey])).rows[0] as RunRow;
      if (existing.input_hash !== hash) return { kind: "conflict" };
      if (existing.status === "running") {
        const stale = await pool.query(
          `update agentctl.runs set status = 'failed', error = 'stale: the run passed its deadline without finishing', finished_at = now()
           where id = $1 and status = 'running' and started_at < now() - make_interval(secs => $2)
           returning *`,
          [existing.id, LIMITS.requestDeadlineMs / 1000 + 15],
        );
        if (stale.rows[0]) return { kind: "existing", run: stale.rows[0] as RunRow };
      }
      return { kind: "existing", run: existing };
    },

    async append(runId: string, sequence: number, kind: string, payload: unknown) {
      await pool.query("insert into agentctl.events (id, run_id, sequence, kind, payload) values ($1, $2, $3, $4, $5)", [
        newId("ev"),
        runId,
        sequence,
        kind,
        JSON.stringify(capPayload(payload)),
      ]);
    },

    async setScope(runId: string, scope: unknown, route: unknown, calibrationStatus: string) {
      await pool.query("update agentctl.runs set scope = $2, requested_route = $3, calibration_status = $4 where id = $1", [
        runId,
        JSON.stringify(scope),
        JSON.stringify(route),
        calibrationStatus,
      ]);
    },

    /** Writes the terminal state and any learning deliveries in one transaction. */
    async finish(runId: string, fields: { status: RunRow["status"]; answer: Answer | null; servedIdentity: unknown; usage: unknown; verification: Verification; error?: string }, deliveries: Delivery[] = []) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(
          `update agentctl.runs set status = $2, answer = $3, served_identity = $4, usage = $5, verification = $6, error = $7, finished_at = now()
           where id = $1`,
          [runId, fields.status, JSON.stringify(fields.answer), JSON.stringify(fields.servedIdentity), JSON.stringify(fields.usage), fields.verification, fields.error ?? null],
        );
        for (const d of deliveries) {
          await client.query(
            `insert into agentctl.learning_deliveries (id, run_id, kind, payload, idempotency_key, status)
             values ($1, $2, $3, $4, $5, 'pending') on conflict (idempotency_key) do nothing`,
            [d.id, d.runId, d.kind, JSON.stringify(redact(d.payload)), d.idempotencyKey],
          );
        }
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async setVerification(runId: string, verification: Verification, deliveries: Delivery[] = []) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("update agentctl.runs set verification = $2 where id = $1", [runId, verification]);
        for (const d of deliveries) {
          await client.query(
            `insert into agentctl.learning_deliveries (id, run_id, kind, payload, idempotency_key, status)
             values ($1, $2, $3, $4, $5, 'pending') on conflict (idempotency_key) do nothing`,
            [d.id, d.runId, d.kind, JSON.stringify(redact(d.payload)), d.idempotencyKey],
          );
        }
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async getRun(tenantId: string, runId: string): Promise<{ run: RunRow; events: EventRow[]; deliveries: unknown[] } | null> {
      const run = (await pool.query("select * from agentctl.runs where tenant_id = $1 and id = $2", [tenantId, runId])).rows[0] as RunRow | undefined;
      if (!run) return null;
      const events = (await pool.query("select * from agentctl.events where run_id = $1 order by sequence", [runId])).rows as EventRow[];
      const deliveries = (await pool.query("select id, kind, status, attempts, last_error, payload, created_at, delivered_at from agentctl.learning_deliveries where run_id = $1 order by created_at", [runId])).rows;
      return { run, events, deliveries };
    },

    async recentRuns(tenantId: string, limit = 20): Promise<RunRow[]> {
      return (await pool.query("select * from agentctl.runs where tenant_id = $1 order by started_at desc limit $2", [tenantId, limit])).rows as RunRow[];
    },

    /**
     * Sends the oldest unsent delivery that matches and that no other sender holds, and records the result. The row
     * stays locked (FOR UPDATE SKIP LOCKED) until the result is written, so senders that overlap (a feedback request
     * and the schedule trigger) never send the same row at once, and a sender that stops releases its row. A failed
     * send stays pending with one more attempt; at LIMITS.maxDeliveryAttempts it becomes failed. Null: nothing matched.
     */
    async sendNextDelivery(select: DeliverySelection, send: (d: Delivery) => Promise<void>): Promise<{ id: string; ok: boolean } | null> {
      const params: unknown[] = [select.skip, select.runId ?? null];
      let due = "";
      if (select.due) {
        params.push(select.due.tenantId, select.due.calibrationNamespace, LIMITS.maxDeliveryAttempts);
        due = `and r.tenant_id = $3 and r.scope ->> 'calibrationNamespace' = $4 and d.attempts < $5
               and d.created_at + interval '1 minute' * power(2, d.attempts) <= now()`;
      }
      const client = await pool.connect();
      try {
        await client.query("begin");
        const { rows } = await client.query(
          `select d.id, d.run_id, d.kind, d.payload, d.idempotency_key
           from agentctl.learning_deliveries d join agentctl.runs r on r.id = d.run_id
           where d.status <> 'delivered' and d.id <> all($1::text[]) and ($2::text is null or d.run_id = $2) ${due}
           order by d.created_at
           limit 1
           for update of d skip locked`,
          params,
        );
        const row = rows[0];
        if (!row) {
          await client.query("commit");
          return null;
        }
        let error: string | null = null;
        try {
          await send({ id: row.id, runId: row.run_id, kind: row.kind, payload: row.payload, idempotencyKey: row.idempotency_key });
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
        await client.query(
          error === null
            ? "update agentctl.learning_deliveries set status = 'delivered', attempts = attempts + 1, delivered_at = now(), last_error = null where id = $1"
            : `update agentctl.learning_deliveries
               set status = case when attempts + 1 >= $3 then 'failed' else 'pending' end, attempts = attempts + 1, last_error = $2
               where id = $1`,
          error === null ? [row.id] : [row.id, error.slice(0, 400), LIMITS.maxDeliveryAttempts],
        );
        await client.query("commit");
        return { id: row.id, ok: error === null };
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async saveEvaluation(id: string, manifest: unknown, results: unknown) {
      await pool.query("insert into agentctl.evaluations (id, manifest, results) values ($1, $2, $3)", [id, JSON.stringify(manifest), JSON.stringify(results)]);
    },
  };
}

export type Store = ReturnType<typeof createStore>;
