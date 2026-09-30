/**
 * Halcyon Phase 1A — per-tick shadow comparison between the projection
 * (dispatch_due_index) and the airlock classify result set.
 *
 * Called from prepareAirlockDispatch in daemon_dispatch_airlock.mjs after the
 * classify finishes. Never affects dispatch behavior: read-only, wrapped in
 * try/catch, failure emits a warn row and the tick proceeds.
 *
 * Enabled by default; kill-switch: HELM_DUE_SHADOW_COMPARE=0
 *
 * Comparison level: SCOPE. The projection may have multiple (scope_id, job_id)
 * rows; the classify returns scopes. A scope is "due" in the projection if it
 * has at least one row with enabled=1 AND next_run_at<=now AND active_run_id IS
 * NULL. A scope is "due" in the classify if it appears in airlockDueSet.
 * Divergent identifiers include the (scope_id, job_id) pairs from the
 * projection-only side for diagnostics.
 *
 * Callers may pass airlockDueSet as:
 *   - Array of {scope_id, job_id} — direct (scope_id, job_id) pairs (tests)
 *   - Array of {scope_id}         — scope-only entries (daemon integration)
 * In both forms the comparison is at scope_id granularity.
 *
 * Telemetry shape (appended to perf JSONL via sink):
 *   event:                    "dispatch_due_shadow_sample"
 *   shadow_divergence_count:  number — |symmetric difference| of scope_id sets
 *   projection_due_count:     number — distinct scope_ids due per projection
 *   classify_due_count:       number — scope_ids due per airlock classify
 *   divergent_identifiers:    Array<{scope_id, job_id?, side}>
 *                              side = "projection_only" | "classify_only"
 *                              capped at MAX_DIVERGENT_IDENTIFIERS entries
 *   duration_ms:              number — wall-clock time to compute the sample
 *   daemon_instance_id:       string | null
 *   at_iso:                   string | null
 */

import { existsSync } from "node:fs";
import { appendPerfEvent } from "./resource_sampler.mjs";
import { runtimeStorePath, withRuntimeStore } from "./runtime_store.mjs";
import { helmHome } from "./store.mjs";

const NOW_ISO = () => new Date().toISOString();

export const SHADOW_COMPARE_ENABLED_DEFAULT = true;
const MAX_DIVERGENT_IDENTIFIERS = 20;

function isShadowEnabled() {
  const v = process.env.HELM_DUE_SHADOW_COMPARE;
  if (v === undefined || v === null || v === "")
    return SHADOW_COMPARE_ENABLED_DEFAULT;
  return v !== "0" && v !== "false";
}

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
 * Query the projection for due scope/job rows at the given atIso timestamp.
 * Returns an array of { scope_id, job_id } objects.
 *
 * @param {object} db     - open DatabaseSync connection (read-only use)
 * @param {string} atIso  - ISO timestamp used as the due cutoff
 */
function queryProjectionDueSet(db, atIso) {
  return db
    .prepare(
      `SELECT scope_id, job_id FROM dispatch_due_index
       WHERE enabled = 1
         AND next_run_at IS NOT NULL
         AND next_run_at <= ?
         AND active_run_id IS NULL`,
    )
    .all(atIso);
}

/**
 * Compute the shadow comparison between the projection and the airlock classify
 * result, emit a dispatch_due_shadow_sample perf row, and return the result.
 *
 * Returns null if the kill-switch is active (HELM_DUE_SHADOW_COMPARE=0).
 * Never throws.
 *
 * @param {object} opts
 * @param {string}   opts.atIso              - ISO timestamp of the dispatch tick
 * @param {Array}    opts.airlockDueSet      - [{scope_id[, job_id]}] from classify
 * @param {string}   [opts.home]             - HELM_HOME override (tests)
 * @param {string}   [opts.daemonInstanceId] - for the perf row
 * @param {Function} [opts.sink]             - perf sink (defaults to appendPerfEvent)
 */
export function computeDueShadowSample({
  atIso,
  airlockDueSet = [],
  home,
  daemonInstanceId = null,
  sink,
} = {}) {
  if (!isShadowEnabled()) return null;

  const perfSink = sink ?? appendPerfEvent;
  const resolvedHome = home ?? helmHome();
  const storePath = runtimeStorePath(resolvedHome);
  const startMs = Date.now();

  try {
    if (!existsSync(storePath)) {
      // Store not yet initialized; skip silently.
      return null;
    }

    // Query the projection for due rows. withRuntimeStore is read-only (no txn).
    let projectionRows;
    withRuntimeStore({ home: resolvedHome, path: storePath }, (db) => {
      projectionRows = queryProjectionDueSet(db, atIso);
    });

    // Build scope-level due sets from both sides.
    // Projection: group by scope_id, collect first few job_ids for diagnostics.
    const projectionByScopeId = new Map(); // scope_id → [{scope_id, job_id}]
    for (const row of projectionRows) {
      let list = projectionByScopeId.get(row.scope_id);
      if (!list) {
        list = [];
        projectionByScopeId.set(row.scope_id, list);
      }
      list.push(row);
    }

    // Classify: just scope_id keys (job_id may or may not be present).
    const classifyScopeIds = new Set(airlockDueSet.map((r) => r.scope_id));

    // Symmetric difference at scope level.
    const divergentIdentifiers = [];

    // In projection but not in classify
    for (const [scopeId, rows] of projectionByScopeId) {
      if (!classifyScopeIds.has(scopeId)) {
        for (const row of rows) {
          if (divergentIdentifiers.length >= MAX_DIVERGENT_IDENTIFIERS) break;
          divergentIdentifiers.push({
            scope_id: row.scope_id,
            job_id: row.job_id,
            side: "projection_only",
          });
        }
      }
    }

    // In classify but not in projection
    for (const scopeId of classifyScopeIds) {
      if (!projectionByScopeId.has(scopeId)) {
        if (divergentIdentifiers.length < MAX_DIVERGENT_IDENTIFIERS) {
          // No job_id available from classify at scope level
          const entry = airlockDueSet.find((r) => r.scope_id === scopeId);
          divergentIdentifiers.push({
            scope_id: scopeId,
            ...(entry?.job_id ? { job_id: entry.job_id } : {}),
            side: "classify_only",
          });
        }
      }
    }

    const divergenceCount =
      [...projectionByScopeId.keys()].filter(
        (sid) => !classifyScopeIds.has(sid),
      ).length +
      [...classifyScopeIds].filter((sid) => !projectionByScopeId.has(sid))
        .length;

    const result = {
      shadow_divergence_count: divergenceCount,
      projection_due_count: projectionByScopeId.size,
      classify_due_count: classifyScopeIds.size,
      divergent_identifiers: divergentIdentifiers,
      duration_ms: Date.now() - startMs,
    };

    const perfRecord = {
      event: "dispatch_due_shadow_sample",
      type: "dispatch_due_shadow_sample",
      classification: "helm_control_plane",
      timestamp: NOW_ISO(),
      daemon_instance_id: daemonInstanceId,
      at_iso: atIso,
      ...result,
    };

    perfSink(perfRecord);

    return result;
  } catch (err) {
    emitWarn("dispatch_due_shadow_sample_failed", { at_iso: atIso }, err);
    // Emit a warn perf row so the soak query can detect silent failures.
    try {
      perfSink({
        event: "dispatch_due_shadow_sample",
        type: "dispatch_due_shadow_sample",
        classification: "helm_control_plane",
        timestamp: NOW_ISO(),
        daemon_instance_id: daemonInstanceId,
        at_iso: atIso,
        shadow_divergence_count: null,
        projection_due_count: null,
        classify_due_count: null,
        divergent_identifiers: [],
        error: err?.message ?? String(err),
      });
    } catch {
      // last-resort: emit failed, but tick must not be affected
    }
    return null;
  }
}
