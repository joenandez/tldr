/**
 * Halcyon Phase 1A — dispatch_due_index reconcile/repair pass.
 *
 * Walks the registered scopes' jobs.json truth, detects five drift classes,
 * and repairs the projection in-place. Designed to be called from the daemon's
 * existing maintenance cadence (retention_gc or inbox_drop_alarm tick).
 *
 * Drift classes repaired (per plan KNOWN DRIFT SOURCES):
 *
 *   missing_rows       — job exists in jobs.json but no projection row
 *                        (e.g. store initialized before saveJobs was ever called,
 *                        or migrateLegacyWorkspaceConfig cpSync bypassed saveJobs)
 *
 *   stale_rows         — projection row exists but enabled/next_run_at differs
 *                        from jobs.json truth (content comparison, not mtime)
 *
 *   removed_rows       — projection row exists for a job_id absent from jobs.json
 *                        (job deleted from jobs.json; row deleted from projection)
 *
 *   stale_active_run_id — active_run_id is non-NULL but the corresponding
 *                         logical_run is absent or in a terminal status
 *                         (reaper/reconciler terminal paths did not clear it)
 *
 *   orphaned_scope_rows — projection rows exist for a scope_id that is no
 *                         longer in the registered scopes list (defense in depth
 *                         alongside deleteDueProjectionForScope)
 *
 * Telemetry shape (appended to perf JSONL via sink):
 *   event:                  "dispatch_due_reconcile_sample"
 *   reconcile_repair_count: number — total rows repaired
 *   repair_classes: {
 *     missing_rows:          number,
 *     stale_rows:            number,
 *     removed_rows:          number,
 *     stale_active_run_id:   number,
 *     orphaned_scope_rows:   number,
 *   }
 *   scopes_checked:         number
 *   duration_ms:            number
 *   daemon_instance_id:     string | null
 *
 * deleteDueProjectionForScope — called by scopes.mjs unregisterScope (reachable
 * via workspace_service.mjs → unregisterScope) so orphan rows are removed
 * eagerly on scope removal (reconcile sweeps them as defense in depth).
 */

import { existsSync } from "node:fs";
import { appendPerfEvent } from "./resource_sampler.mjs";
import { runtimeStorePath } from "./runtime_store.mjs";
import { loadJobsReadOnly, helmHome } from "./store.mjs";
import { withRuntimeStoreTransactionRetry } from "./runtime_store_retry.mjs";
import { normalizeNextRunAtIso } from "./dispatch_due_projection.mjs";
export { deleteDueProjectionForScope } from "./dispatch_due_projection_delete.mjs";

const NOW_ISO = () => new Date().toISOString();

// Terminal statuses in logical_runs that mean the run is no longer active.
// 'claimed' and 'running' are the only non-terminal statuses.
const TERMINAL_RUN_STATUSES = [
  "succeeded",
  "failed",
  "skipped",
  "interrupted",
  "timed_out",
  "quarantined",
];
const TERMINAL_STATUS_PLACEHOLDERS = TERMINAL_RUN_STATUSES.map(() => "?").join(
  ",",
);

function emitWarn(event, context, err) {
  process.stderr.write(
    JSON.stringify({
      level: "warn",
      event,
      context,
      error: err?.message ?? String(err),
      ts: NOW_ISO(),
    }) + "\n",
  );
}

/**
 * Run a full reconcile pass over the given scopes.
 * Detects and repairs all four drift classes; emits one perf row via sink.
 *
 * Never throws. Failures for individual scopes are caught and counted.
 *
 * @param {object} opts
 * @param {Array}    opts.scopes           - scope objects (from hydrateRegisteredScopes)
 * @param {string}   [opts.home]           - HELM_HOME override (tests)
 * @param {string}   [opts.daemonInstanceId]
 * @param {Function} [opts.sink]           - perf sink (defaults to appendPerfEvent)
 * @returns {{ reconcile_repair_count, repair_classes, scopes_checked, duration_ms }}
 */
export function runDueProjectionReconcile({
  scopes = [],
  home,
  daemonInstanceId = null,
  sink,
} = {}) {
  const perfSink = sink ?? appendPerfEvent;
  const resolvedHome = home ?? helmHome();
  const storePath = runtimeStorePath(resolvedHome);

  const startMs = Date.now();
  const repairClasses = {
    missing_rows: 0,
    stale_rows: 0,
    removed_rows: 0,
    stale_active_run_id: 0,
    orphaned_scope_rows: 0,
  };
  let totalRepairs = 0;

  try {
    if (!existsSync(storePath)) {
      // Store not yet initialized; nothing to reconcile.
      return _emitAndReturn(perfSink, {
        reconcile_repair_count: 0,
        repair_classes: repairClasses,
        scopes_checked: 0,
        duration_ms: Date.now() - startMs,
        daemon_instance_id: daemonInstanceId,
      });
    }

    const registeredScopeIds = new Set(scopes.map((s) => s.scope_id));

    // Step 1: sweep orphaned scope rows (projection rows for removed scopes).
    // Read all distinct scope_ids from projection, delete any not in registeredScopeIds.
    try {
      const orphanResult = withRuntimeStoreTransactionRetry(
        { home: resolvedHome, path: storePath },
        { context: { stage: "dispatch_due_reconcile_orphans" } },
        (db) => {
          const allScopeIds = db
            .prepare("SELECT DISTINCT scope_id FROM dispatch_due_index")
            .all()
            .map((r) => r.scope_id);

          let deleted = 0;
          for (const sid of allScopeIds) {
            if (!registeredScopeIds.has(sid)) {
              deleted += db
                .prepare("DELETE FROM dispatch_due_index WHERE scope_id = ?")
                .run(sid).changes;
            }
          }
          return { deleted };
        },
      );
      if (orphanResult.ok) {
        repairClasses.orphaned_scope_rows += orphanResult.value.deleted;
        totalRepairs += orphanResult.value.deleted;
      } else {
        emitWarn(
          "dispatch_due_reconcile_orphan_sweep_failed",
          {},
          orphanResult.error,
        );
      }
    } catch (err) {
      emitWarn("dispatch_due_reconcile_orphan_sweep_failed", {}, err);
    }

    // Step 2: for each registered scope, reconcile its jobs.json truth against
    // the projection rows.
    for (const scope of scopes) {
      try {
        _reconcileScope(scope, resolvedHome, storePath, repairClasses);
      } catch (err) {
        emitWarn(
          "dispatch_due_reconcile_scope_failed",
          { scope_id: scope.scope_id },
          err,
        );
      }
    }

    totalRepairs =
      repairClasses.missing_rows +
      repairClasses.stale_rows +
      repairClasses.removed_rows +
      repairClasses.stale_active_run_id +
      repairClasses.orphaned_scope_rows;
  } catch (err) {
    emitWarn("dispatch_due_reconcile_failed", {}, err);
  }

  return _emitAndReturn(perfSink, {
    reconcile_repair_count: totalRepairs,
    repair_classes: repairClasses,
    scopes_checked: scopes.length,
    duration_ms: Date.now() - startMs,
    daemon_instance_id: daemonInstanceId,
  });
}

/**
 * Reconcile a single scope: compare jobs.json truth to projection rows,
 * repair missing/stale/stale-active-run-id rows in one transaction.
 */
function _reconcileScope(scope, home, storePath, repairClasses) {
  const scopeId = scope.scope_id;

  // Read the truth (jobs.json). No projection write should block on this.
  const jobs = loadJobsReadOnly(scope);

  const result = withRuntimeStoreTransactionRetry(
    { home, path: storePath },
    { context: { stage: "dispatch_due_reconcile_scope", scope_id: scopeId } },
    (db) => {
      const now = NOW_ISO();

      // Read current projection rows for this scope.
      const projRows = db
        .prepare(
          "SELECT job_id, enabled, next_run_at, active_run_id FROM dispatch_due_index WHERE scope_id = ?",
        )
        .all(scopeId);
      const projMap = new Map(projRows.map((r) => [r.job_id, r]));

      const incomingIds = new Set(jobs.map((j) => j.id));
      let missing = 0;
      let stale = 0;
      let staleActive = 0;

      // Repair: missing rows and stale content
      const upsert = db.prepare(`
        INSERT INTO dispatch_due_index
          (scope_id, job_id, enabled, next_run_at, source_mtime_ms, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, job_id) DO UPDATE SET
          enabled         = excluded.enabled,
          next_run_at     = excluded.next_run_at,
          source_mtime_ms = excluded.source_mtime_ms,
          updated_at      = excluded.updated_at
      `);

      for (const job of jobs) {
        const proj = projMap.get(job.id);
        const truthEnabled = job.state?.enabled ? 1 : 0;
        // Normalize to UTC Z so the TEXT comparison in the due query is
        // correct even when jobs.json carries a non-UTC offset (e.g. -07:00).
        const truthNextRunAt = normalizeNextRunAtIso(job.state?.next_run_at, {
          scope_id: scopeId,
          job_id: job.id,
        });

        if (!proj) {
          // Missing row — upsert
          upsert.run(scopeId, job.id, truthEnabled, truthNextRunAt, null, now);
          missing += 1;
        } else {
          // Content comparison: compare the projection value against the
          // normalized truth. Pre-fix rows with raw offset strings will
          // differ from the normalized truth on the first reconcile pass
          // (counted as stale_rows) and then be stable thereafter.
          const projEnabled = proj.enabled;
          const projNextRunAt = proj.next_run_at;
          const contentDiffers =
            projEnabled !== truthEnabled || projNextRunAt !== truthNextRunAt;
          if (contentDiffers) {
            upsert.run(
              scopeId,
              job.id,
              truthEnabled,
              truthNextRunAt,
              null,
              now,
            );
            stale += 1;
          }
        }
      }

      // Delete rows for jobs no longer in jobs.json (projection rows for removed jobs)
      const toDelete = [...projMap.keys()].filter((id) => !incomingIds.has(id));
      let removed = 0;
      for (const jobId of toDelete) {
        db.prepare(
          "DELETE FROM dispatch_due_index WHERE scope_id = ? AND job_id = ?",
        ).run(scopeId, jobId);
        removed += 1;
      }

      // Repair stale active_run_id: non-NULL active_run_id pointing at a
      // terminal or absent logical_run. Join against logical_runs to check.
      const staleActiveRows = db
        .prepare(
          `
          SELECT d.job_id, d.active_run_id
          FROM dispatch_due_index d
          WHERE d.scope_id = ?
            AND d.active_run_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM logical_runs lr
              WHERE lr.logical_run_key = d.active_run_id
                AND lr.status NOT IN (${TERMINAL_STATUS_PLACEHOLDERS})
            )
          `,
        )
        .all(scopeId, ...TERMINAL_RUN_STATUSES);

      if (staleActiveRows.length > 0) {
        const clearStmt = db.prepare(
          "UPDATE dispatch_due_index SET active_run_id = NULL, updated_at = ? WHERE scope_id = ? AND job_id = ?",
        );
        for (const row of staleActiveRows) {
          clearStmt.run(now, scopeId, row.job_id);
          staleActive += 1;
        }
      }

      return { missing, stale, removed, staleActive };
    },
  );

  if (result.ok) {
    repairClasses.missing_rows += result.value.missing;
    repairClasses.stale_rows += result.value.stale;
    repairClasses.removed_rows += result.value.removed;
    repairClasses.stale_active_run_id += result.value.staleActive;
  } else {
    emitWarn(
      "dispatch_due_reconcile_scope_txn_failed",
      { scope_id: scopeId },
      result.error,
    );
  }
}

function _emitAndReturn(sink, payload) {
  const record = {
    event: "dispatch_due_reconcile_sample",
    type: "dispatch_due_reconcile_sample",
    classification: "helm_control_plane",
    timestamp: NOW_ISO(),
    ...payload,
  };
  try {
    sink(record);
  } catch (err) {
    emitWarn("dispatch_due_reconcile_emit_failed", {}, err);
  }
  return {
    reconcile_repair_count: payload.reconcile_repair_count,
    repair_classes: payload.repair_classes,
    scopes_checked: payload.scopes_checked,
    duration_ms: payload.duration_ms,
  };
}
