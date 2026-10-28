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

    async pendingDeliveries(limit = 100): Promise<(Delivery & { attempts: number })[]> {
      const { rows } = await pool.query(
        "select id, run_id, kind, payload, idempotency_key, attempts from agentctl.learning_deliveries where status <> 'delivered' order by created_at limit $1",
        [limit],
      );
      return rows.map((r) => ({ id: r.id, runId: r.run_id, kind: r.kind, payload: r.payload, idempotencyKey: r.idempotency_key, attempts: r.attempts }));
    },

    async markDelivery(id: string, ok: boolean, error?: string) {
      await pool.query(
        ok
          ? "update agentctl.learning_deliveries set status = 'delivered', attempts = attempts + 1, delivered_at = now(), last_error = null where id = $1"
          : "update agentctl.learning_deliveries set status = 'failed', attempts = attempts + 1, last_error = $2 where id = $1",
        ok ? [id] : [id, (error ?? "").slice(0, 400)],
      );
    },

    async saveEvaluation(id: string, manifest: unknown, results: unknown) {
      await pool.query("insert into agentctl.evaluations (id, manifest, results) values ($1, $2, $3)", [id, JSON.stringify(manifest), JSON.stringify(results)]);
    },
  };
}

export type Store = ReturnType<typeof createStore>;
