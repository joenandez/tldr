/**
 * Halcyon Phase-2 task 3.1 — Global due-query + N+1 registry read fix.
 *
 * FLAG: default-on due admission; HELM_DISPATCH_DUE_QUERY_KILL_SWITCH=1 forces
 * the classify-per-scope admission path for the tick.
 *
 * Three public exports used by daemon_dispatch_airlock.mjs:
 *
 *   queryGlobalDueSet(db, atIso)
 *     — ONE indexed SQL query replacing N per-scope jobs/active-runs reads.
 *       Returns [{scope_id, job_id, active_run_id, next_run_at}] for every row where:
 *         enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=atIso
 *         AND active_run_id IS NULL
 *       Reuses the exact query from dispatch_due_shadow.mjs (queryProjectionDueSet)
 *       so the semantics are identical to the soak-verified shadow compare.
 *
 *   registryDispatchPlanFast({ listFn?, cwdExistsFn? })
 *     — ONE listScopeRegistryV2 call, then classifyRegistryEntry on each row
 *       inline (no per-entry re-list). Fixes the N+1 in daemon.mjs:330-378.
 *       listFn and cwdExistsFn are injectable for tests.
 *
 *   isGlobalDueAdmissionEnabled()
 *     — returns true unless HELM_DISPATCH_DUE_QUERY_KILL_SWITCH=1.
 */

import { existsSync } from "node:fs";
import { runtimeStorePath, withRuntimeStore } from "./runtime_store.mjs";
import { helmHome, resolveScope } from "./store.mjs";
import { hydrateRegisteredScopes } from "./scopes.mjs";
import { listScopeRegistryV2 } from "./scope_registry_v2.mjs";

// ---------------------------------------------------------------------------
// Flag levers
// ---------------------------------------------------------------------------

/**
 * Returns true when the global due-query admission path is active.
 * Default-on; HELM_DISPATCH_DUE_QUERY_KILL_SWITCH=1 is the operator panic lever.
 * In-process dispatch remains controlled separately by HELM_DISPATCH_INPROC.
 */
export function isGlobalDueAdmissionEnabled() {
  return process.env.HELM_DISPATCH_DUE_QUERY_KILL_SWITCH !== "1";
}

export function isGlobalDueQueryEnabled() {
  return isGlobalDueAdmissionEnabled();
}

// ---------------------------------------------------------------------------
// Global due-query (replaces per-scope classify iteration when flag is ON)
// ---------------------------------------------------------------------------

/**
 * ONE indexed query over dispatch_due_index for all scopes.
 * Returns [{scope_id, job_id, active_run_id, next_run_at}] — semantically identical to the soak-proven
 * queryProjectionDueSet in dispatch_due_shadow.mjs (kept in sync intentionally).
 *
 * @param {object} db     - open DatabaseSync connection (caller manages lifetime)
 * @param {string} atIso  - ISO timestamp used as the due cutoff
 * @returns {Array<{scope_id: string, job_id: string, active_run_id: string|null, next_run_at: string|null}>}
 */
export function queryGlobalDueSet(db, atIso) {
  return db
    .prepare(
      `SELECT scope_id, job_id, active_run_id, next_run_at FROM dispatch_due_index
       WHERE enabled = 1
         AND next_run_at IS NOT NULL
         AND next_run_at <= ?
         AND active_run_id IS NULL`,
    )
    .all(atIso);
}

export function queryGlobalSuppressedDueSet(db, atIso) {
  return db
    .prepare(
      `SELECT scope_id, job_id, active_run_id, next_run_at FROM dispatch_due_index
       WHERE enabled = 1
         AND next_run_at IS NOT NULL
         AND next_run_at <= ?
         AND active_run_id IS NOT NULL`,
    )
    .all(atIso);
}

function normalizeDueRow(row) {
  const scope = resolveScope({ cwd: row.scope_id });
  return {
    scope_id: scope.scope_id,
    job_id: row.job_id,
    active_run_id: row.active_run_id ?? null,
    next_run_at: row.next_run_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// Registry dispatch plan — N+1 fix
// ---------------------------------------------------------------------------

/**
 * Classify a single registry entry without re-reading the registry.
 * Replicates the dispatchability rules from explainScopeRegistryV2, but
 * uses the already-fetched entry object rather than re-calling listScopeRegistryV2.
 *
 * @param {object} entry          - row from scope_registry table
 * @param {number} generation     - registry.metadata.generation (for result shape)
 * @param {Function} cwdExistsFn  - injectable for tests (defaults to existsSync)
 * @returns {{ dispatchable: boolean, reason: string }}
 */
function classifyRegistryEntry(entry, generation, cwdExistsFn = existsSync) {
  let reason = "dispatch_enabled";
  let dispatchable = true;
  if (entry.quarantine_state === "quarantined") {
    reason = "quarantined";
    dispatchable = false;
  } else if (entry.dispatch_state !== "enabled") {
    reason = "dispatch_disabled";
    dispatchable = false;
  } else if (!cwdExistsFn(entry.cwd)) {
    reason = "scope_cwd_missing";
    dispatchable = false;
  }
  return { dispatchable, reason, generation };
}

/**
 * ONE listScopeRegistryV2 call + inline per-entry classification.
 * Fixes the N+1: old registryDispatchPlan called listScopeRegistryV2 inside
 * explainScopeRegistryV2 for every entry (N+1 reads total).
 *
 * Returns the same shape as daemon.mjs registryDispatchPlan:
 *   { authoritative, generation, dispatchable: [scope], skipped: [...] }
 *
 * @param {object} [opts]
 * @param {Function} [opts.listFn]      - injectable for tests (defaults to listScopeRegistryV2)
 * @param {Function} [opts.cwdExistsFn] - injectable for tests (defaults to existsSync)
 */
export function registryDispatchPlanFast({
  listFn = listScopeRegistryV2,
  cwdExistsFn = existsSync,
} = {}) {
  let registry;
  try {
    registry = listFn(); // EXACTLY ONE list read
  } catch (err) {
    return {
      authoritative: true,
      generation: null,
      dispatchable: [],
      skipped: [
        {
          scope_id: null,
          cwd: null,
          reason: err?.code || "scope_registry_invalid",
          error: err?.message || String(err),
        },
      ],
    };
  }

  if (registry.entries.length === 0) {
    return {
      authoritative: false,
      generation: registry.metadata.generation,
      dispatchable: hydrateRegisteredScopes(),
      skipped: [],
    };
  }

  const dispatchable = [];
  const skipped = [];
  for (const entry of registry.entries) {
    // ONE inline classify call per entry — no re-list
    const { dispatchable: isDispatchable, reason } = classifyRegistryEntry(
      entry,
      registry.metadata.generation,
      cwdExistsFn,
    );
    if (isDispatchable) {
      dispatchable.push(resolveScope({ cwd: entry.cwd }));
    } else {
      skipped.push({
        scope_id: entry.scope_id,
        cwd: entry.cwd,
        reason,
        generation: entry.generation,
      });
    }
  }

  return {
    authoritative: true,
    generation: registry.metadata.generation,
    dispatchable,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// Global due-query dispatch plan (used when flag is ON)
// ---------------------------------------------------------------------------

/**
 * Query row-level due admission data. Empty row sets mean "available and no due
 * work"; store/open/query failures return available=false so callers can fail
 * open to the legacy classify path.
 *
 * @param {object} opts
 * @param {string} opts.atIso  - ISO timestamp (dispatch tick time)
 * @param {string} [opts.home] - HELM_HOME override (tests)
 * @returns {{available: true, dueRows: Array, suppressedRows: Array} | {available: false, reason: string, error?: string}}
 */
export function queryDueScopesFast({ atIso, home } = {}) {
  const resolvedHome = home ?? helmHome();
  const storePath = runtimeStorePath(resolvedHome);

  if (!existsSync(storePath)) {
    return { available: false, reason: "runtime_store_missing" };
  }

  try {
    let dueRows = [];
    let suppressedRows = [];
    withRuntimeStore({ home: resolvedHome, path: storePath }, (db) => {
      dueRows = queryGlobalDueSet(db, atIso).map(normalizeDueRow);
      suppressedRows = queryGlobalSuppressedDueSet(db, atIso).map(
        normalizeDueRow,
      );
    });
    return {
      available: true,
      dueRows,
      suppressedRows,
    };
  } catch (err) {
    return {
      available: false,
      reason: err?.code || "runtime_store_query_failed",
      error: err?.message || String(err),
    };
  }
}
