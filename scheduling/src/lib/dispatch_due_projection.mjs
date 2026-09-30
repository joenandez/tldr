/**
 * Halcyon Phase 1A — dispatch_due_index projection writer.
 *
 * Centralizes all writes to the `dispatch_due_index` table so:
 *  - saveJobs (store.mjs) calls upsertDueProjectionForScope after every
 *    jobs.json write.
 *  - claimLogicalRunForJob (runtime_ledger.mjs) calls setDueProjectionActiveRun
 *    inside the same BEGIN IMMEDIATE transaction that claims the logical run.
 *  - finalizeRunAttempt (runtime_ledger.mjs) calls clearDueProjectionActiveRun
 *    inside the same transaction that finalizes the attempt.
 *
 * Design invariants (from plan §10, FA-2):
 *  - jobs.json is CANONICAL; the projection is ADVISORY.
 *  - Projection write failure MUST NOT break saveJobs's jobs.json write.
 *    All public functions in this module catch their own errors and emit a
 *    structured warn to stderr instead of throwing.
 *  - source_mtime_ms records the jobs.json mtime for drift detection.
 *  - active_run_id suppresses dispatch for a job while a run is in flight.
 *
 * The active-run path (setDueProjectionActiveRun / clearDueProjectionActiveRun)
 * is designed to be called from inside an already-open transaction in
 * runtime_ledger.mjs — it receives an open `db` handle and does NOT wrap its
 * own BEGIN IMMEDIATE so it participates in the caller's atomicity boundary.
 */

import { existsSync } from "node:fs";
import { withRuntimeStoreTransactionRetry } from "./runtime_store_retry.mjs";
import { runtimeStorePath } from "./runtime_store.mjs";
import { helmHome } from "./store.mjs";

const NOW_ISO = () => new Date().toISOString();

/**
 * Normalize a next_run_at value to a UTC Z-format ISO string so the TEXT
 * comparison in dispatch_due_index (`next_run_at <= ?`) is lexicographically
 * correct regardless of the offset that jobs.json may carry.
 *
 * Rules:
 *   null / undefined → null (not scheduled; never becomes due)
 *   valid ISO string with any offset → UTC Z string via new Date().toISOString()
 *   invalid date string  → store null AND emit a structured warn (an invalid
 *     date should never silently become due; null is the safe sentinel)
 *
 * @param {string|null|undefined} v        - raw next_run_at from jobs.json
 * @param {object}                [ctx]    - optional context for warn emission
 * @param {string}                [ctx.scope_id]
 * @param {string}                [ctx.job_id]
 * @returns {string|null}
 */
export function normalizeNextRunAtIso(v, ctx = {}) {
  if (v === null || v === undefined) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) {
    emitProjectionWarn(
      "dispatch_due_projection_invalid_next_run_at",
      { scope_id: ctx.scope_id ?? null, job_id: ctx.job_id ?? null, raw: v },
      new Error(`invalid next_run_at: ${v}`),
    );
    return null; // null is safe — an invalid date is never due
  }
  return d.toISOString();
}

/**
 * Emit a structured warn line to stderr. Matches the plan's "structured warn
 * telemetry" requirement (no new JSONL sinks).
 */
function emitProjectionWarn(event, context, err) {
  process.stderr.write(
    JSON.stringify({
      level: "warn",
      event,
      context,
      error: err?.message ?? String(err),
      code: err?.code ?? undefined,
      ts: NOW_ISO(),
    }) + "\n",
  );
}

/**
 * Upsert dispatch_due_index rows for every job in a scope, and delete rows
 * whose job_id is no longer present. Called by saveJobs in store.mjs after
 * the jobs.json write succeeds.
 *
 * @param {object} scope      - scope object with scope_id and storage_root
 * @param {Array}  jobs       - the full jobs array just written to jobs.json
 * @param {number} mtimeMs    - mtime of jobs.json at time of write (drift detect)
 * @param {object} [opts]
 * @param {string} [opts.home] - HELM_HOME override (tests)
 */
export function upsertDueProjectionForScope(scope, jobs, mtimeMs, opts = {}) {
  const home = opts.home ?? helmHome();
  const storePath = runtimeStorePath(home);

  // Guard: if the runtime store does not exist yet, skip silently.
  // This mirrors the scopes.mjs:85-92 existsSync(runtimeStorePath()) pattern
  // so callers that run before the store is initialized are not affected.
  if (!existsSync(storePath)) return;

  const result = withRuntimeStoreTransactionRetry(
    { home, path: storePath },
    {
      context: {
        stage: "dispatch_due_projection_upsert",
        scope_id: scope.scope_id,
        job_count: jobs.length,
      },
    },
    (db) => {
      const now = NOW_ISO();
      const incomingIds = new Set(jobs.map((j) => j.id));
      const scopeId = scope.scope_id;

      // Upsert every job — preserve active_run_id so an in-flight run is not
      // cleared by a saveJobs call that does not know about it.
      const upsert = db.prepare(`
        INSERT INTO dispatch_due_index
          (scope_id, job_id, enabled, next_run_at, source_mtime_ms, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, job_id) DO UPDATE SET
          enabled        = excluded.enabled,
          next_run_at    = excluded.next_run_at,
          source_mtime_ms = excluded.source_mtime_ms,
          updated_at     = excluded.updated_at
      `);

      for (const job of jobs) {
        upsert.run(
          scopeId,
          job.id,
          job.state?.enabled ? 1 : 0,
          normalizeNextRunAtIso(job.state?.next_run_at, {
            scope_id: scopeId,
            job_id: job.id,
          }),
          mtimeMs ?? null,
          now,
        );
      }

      // Delete projection rows for jobs that were removed from the scope.
      // Use a single DELETE … WHERE … NOT IN (…) query; bind the id list
      // as individual positional params.
      if (incomingIds.size === 0) {
        db.prepare("DELETE FROM dispatch_due_index WHERE scope_id = ?").run(
          scopeId,
        );
      } else {
        const placeholders = Array.from(incomingIds, () => "?").join(",");
        db.prepare(
          `DELETE FROM dispatch_due_index WHERE scope_id = ? AND job_id NOT IN (${placeholders})`,
        ).run(scopeId, ...incomingIds);
      }

      return { upserted: jobs.length };
    },
  );

  if (!result.ok) {
    emitProjectionWarn(
      "dispatch_due_projection_upsert_failed",
      { scope_id: scope.scope_id, job_count: jobs.length },
      result.error,
    );
  }
}

/**
 * Set active_run_id for a job row in dispatch_due_index.
 *
 * Called from INSIDE an open transaction in runtime_ledger.mjs's
 * claimLogicalRun. The `db` parameter is the already-open DatabaseSync
 * connection — this function does NOT begin its own transaction.
 *
 * If the row does not exist yet (job not yet projected), the call is a no-op
 * rather than an error. The reconcile pass will repair drift later.
 *
 * @param {object} db        - open DatabaseSync connection (caller's txn)
 * @param {string} scopeId
 * @param {string} jobId
 * @param {string} runId     - the logical_run_key (or attempt_id) being claimed
 * @param {string} [now]     - ISO timestamp (injectable for tests)
 */
export function setDueProjectionActiveRunInTxn(
  db,
  scopeId,
  jobId,
  runId,
  now = NOW_ISO(),
) {
  try {
    db.prepare(
      `
      UPDATE dispatch_due_index
      SET active_run_id = ?, updated_at = ?
      WHERE scope_id = ? AND job_id = ?
    `,
    ).run(runId, now, scopeId, jobId);
  } catch (err) {
    // Do not rethrow — the claim transaction continues. The reconcile pass
    // will repair the stale active_run_id if needed.
    emitProjectionWarn(
      "dispatch_due_projection_set_active_run_failed",
      { scope_id: scopeId, job_id: jobId, run_id: runId },
      err,
    );
  }
}

/**
 * Clear active_run_id for a job row in dispatch_due_index.
 *
 * Called from INSIDE an open transaction in runtime_ledger.mjs's
 * finalizeRunAttempt. The `db` parameter is the already-open DatabaseSync
 * connection — this function does NOT begin its own transaction.
 *
 * @param {object} db        - open DatabaseSync connection (caller's txn)
 * @param {string} scopeId
 * @param {string} jobId
 * @param {string} [now]     - ISO timestamp (injectable for tests)
 */
export function clearDueProjectionActiveRunInTxn(
  db,
  scopeId,
  jobId,
  now = NOW_ISO(),
) {
  try {
    db.prepare(
      `
      UPDATE dispatch_due_index
      SET active_run_id = NULL, updated_at = ?
      WHERE scope_id = ? AND job_id = ?
    `,
    ).run(now, scopeId, jobId);
  } catch (err) {
    emitProjectionWarn(
      "dispatch_due_projection_clear_active_run_failed",
      { scope_id: scopeId, job_id: jobId },
      err,
    );
  }
}
