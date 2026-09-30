import {
  globalRuntimeRoot,
  loadScopesRegistry,
  saveScopesRegistry,
  resolveScope,
} from "./store.mjs";
import { existsSync, statSync } from "node:fs";
import { appendActivityEvent } from "./activity_stream.mjs";
import { acquireLease, releaseLease, renewLease } from "./lock.mjs";
import { runtimeStorePath } from "./runtime_store.mjs";
import { deleteDueProjectionForScope } from "./dispatch_due_projection_delete.mjs";
import {
  loadClassifiableJobs,
  recordMissingScopeDeferrals,
  withMissingScopeCatalogLease,
} from "./missing_scope_deferrals.mjs";
import {
  listScopeRegistryV2,
  removeScopeRegistryV2,
  upsertScopeRegistryV2,
} from "./scope_registry_v2.mjs";

function nowIso() {
  return process.env.HELM_NOW
    ? new Date(process.env.HELM_NOW).toISOString()
    : new Date().toISOString();
}

function toRecord(scope) {
  const now = nowIso();
  return {
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    storage_root: scope.storage_root,
    registered_at: now,
    updated_at: now,
  };
}

export function listRegisteredScopes() {
  if (existsSync(runtimeStorePath())) {
    try {
      const registry = listScopeRegistryV2();
      if (registry.entries.length > 0) {
        return registry.entries.map((entry) => {
          const scope = resolveScope({ cwd: entry.cwd });
          return {
            scope_id: entry.scope_id,
            cwd: entry.cwd,
            storage_root: scope.storage_root,
            legacy_storage_root: entry.storage_root,
            registered_at: entry.registered_at,
            updated_at: entry.updated_at,
            registry_generation: entry.generation,
            dispatch_state: entry.dispatch_state,
            quarantine_state: entry.quarantine_state,
          };
        });
      }
    } catch {
      // Compatibility reads fall back to scopes.json; dispatch paths use the
      // registry explain surface and fail closed when Registry V2 is invalid.
    }
  }
  return loadScopesRegistry().scopes;
}

export function listRegisteredScopesLegacy() {
  return loadScopesRegistry().scopes;
}

export function registerScope(scope) {
  const registry = loadScopesRegistry();
  const idx = registry.scopes.findIndex(
    (entry) => entry.scope_id === scope.scope_id,
  );
  const next =
    idx >= 0
      ? {
          ...registry.scopes[idx],
          ...toRecord(scope),
          registered_at: registry.scopes[idx].registered_at,
          updated_at: nowIso(),
        }
      : toRecord(scope);
  if (idx >= 0) {
    registry.scopes[idx] = next;
  } else {
    registry.scopes.push(next);
  }
  saveScopesRegistry(registry.scopes);
  // Mirror the registration into Registry V2, which is what the daemon
  // dispatches from. Without this, a registration that only lands in the
  // legacy scopes.json is invisible to the daemon and the scope silently never
  // dispatches. New scopes enter enabled; existing scopes keep their state.
  if (existsSync(runtimeStorePath())) {
    upsertScopeRegistryV2({
      scope,
      dispatchState: "enabled",
      actor: "cli",
      reason: "scope_register",
    });
  }
  if (idx < 0) {
    appendActivityEvent({
      event_type: "scope_registered",
      scope_id: scope.scope_id,
      cwd: scope.cwd,
      metadata: {
        storage_root: scope.storage_root,
      },
    });
  }
  return next;
}

export function unregisterScope(scope) {
  const registry = loadScopesRegistry();
  const before = registry.scopes.length;
  const scopes = registry.scopes.filter(
    (entry) => entry.scope_id !== scope.scope_id,
  );
  saveScopesRegistry(scopes);
  const removed = before - scopes.length;
  let removedV2 = 0;
  if (existsSync(runtimeStorePath())) {
    removedV2 = removeScopeRegistryV2({
      scopeId: scope.scope_id,
      actor: "cli",
      reason: "scope_unregister",
    }).removed;
    // Eagerly remove projection rows so orphans don't linger until reconcile.
    deleteDueProjectionForScope(scope.scope_id);
  }
  if (removed > 0) {
    appendActivityEvent({
      type: "workspace_down",
      scope_id: scope.scope_id,
      cwd: scope.cwd,
      source: "cli",
      data: {
        scope_id: scope.scope_id,
        cwd: scope.cwd,
        storage_root: scope.storage_root,
      },
    });
  }
  return { removed, removed_v2: removedV2 };
}

export function hydrateRegisteredScopes() {
  return listRegisteredScopes().map((entry) =>
    resolveScope({ cwd: entry.cwd }),
  );
}

export function hydrateRegisteredScopesLegacy() {
  return listRegisteredScopesLegacy()
    .filter((entry) => registeredCwdExists(entry))
    .map((entry) => resolveScope({ cwd: entry.cwd }));
}

function registeredCwdExists(entry) {
  if (!existsSync(entry.cwd)) return false;
  const registeredAt = Date.parse(
    entry.updated_at || entry.registered_at || "",
  );
  if (!Number.isFinite(registeredAt)) return true;
  try {
    const stat = statSync(entry.cwd);
    if (!stat.isDirectory()) return false;
    // A path deleted and then recreated can exist by the time the daemon
    // prunes. In that case the old registration belongs to the deleted
    // workspace and must be removed; the recreated path should opt in again.
    const birthtime = Number(stat.birthtimeMs);
    const ctime = Number(stat.ctimeMs);
    if (
      Number.isFinite(birthtime) &&
      birthtime > 0 &&
      birthtime !== ctime &&
      birthtime > registeredAt + 100
    ) {
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

function missingScopeCandidates(entries) {
  const candidates = new Map();
  for (const entry of entries) {
    const scopeId = entry.scope_id || entry.cwd;
    if (!scopeId || candidates.has(scopeId) || registeredCwdExists(entry)) {
      continue;
    }
    candidates.set(scopeId, entry);
  }
  return candidates;
}

function appendScopePruned(entry, registryV2PruneDeferred) {
  appendActivityEvent({
    event_type: "scope_pruned",
    level: "info",
    scope_id: entry.scope_id,
    cwd: entry.cwd,
    reason: "scope_cwd_missing",
    metadata: {
      storage_root: entry.storage_root,
      ...(registryV2PruneDeferred ? { registry_v2_prune_deferred: true } : {}),
    },
  });
}

const SCOPE_RECONCILE_LOCK_NAME = "scope-reconcile.lock";

function withScopeReconcileLease(fn) {
  const scope = resolveScope({ cwd: globalRuntimeRoot() });
  const owner = `scope_reconcile_${process.pid}_${Date.now()}_${Math.random()
    .toString(16)
    .slice(2, 8)}`;
  const configuredLeaseSec = Number(process.env.HELM_LEASE_SEC || 90);
  const leaseSec =
    Number.isFinite(configuredLeaseSec) && configuredLeaseSec > 0
      ? Math.max(5, Math.min(configuredLeaseSec, 300))
      : 90;
  const acquired = acquireLease(
    scope,
    owner,
    leaseSec,
    SCOPE_RECONCILE_LOCK_NAME,
  );
  if (!acquired.acquired) return { acquired: false, details: acquired };
  try {
    return {
      acquired: true,
      value: fn({
        renew: () =>
          renewLease(scope, owner, leaseSec, SCOPE_RECONCILE_LOCK_NAME),
      }),
    };
  } finally {
    releaseLease(scope, owner, SCOPE_RECONCILE_LOCK_NAME);
  }
}

function pruneMissingScopesInternal({
  includeRegistryV2,
  commitRegistryV2ForTest = null,
}) {
  const reconciliation = withScopeReconcileLease(({ renew }) => {
    const registry = loadScopesRegistry();
    let registryV2Entries = [];
    if (includeRegistryV2 && existsSync(runtimeStorePath())) {
      registryV2Entries = listScopeRegistryV2().entries;
    }
    const candidates = [
      ...missingScopeCandidates([
        ...registry.scopes,
        ...registryV2Entries,
      ]).entries(),
    ];
    let legacyScopes = registry.scopes;
    const removed = [];
    const removedV2 = [];
    const retained = [];
    const deferralScopes = [];

    for (let index = 0; index < candidates.length; index += 1) {
      const [scopeId, entry] = candidates[index];
      if (!renew()) {
        retained.push(
          ...candidates.slice(index).map(([candidateId]) => candidateId),
        );
        break;
      }
      const scope = resolveScope({ cwd: entry.cwd || scopeId });
      const decision = withMissingScopeCatalogLease(
        scope,
        ({ renew: renewCatalog }) => {
          if (!renew() || !renewCatalog()) return "retain";
          if (registeredCwdExists(entry)) return "present";
          if (!existsSync(entry.cwd)) {
            const store = loadClassifiableJobs(scope);
            if (!renew() || !renewCatalog()) return "retain";
            if (!store.trusted) return "retain";
            const enabledJobs = store.jobs.filter(
              (job) => job.state.enabled === true,
            );
            if (enabledJobs.length > 0) {
              deferralScopes.push(scope);
              return "retain";
            }
          }

          if (!renew() || !renewCatalog()) return "retain";
          const removedLegacy = legacyScopes.filter(
            (candidate) =>
              (candidate.scope_id || candidate.cwd) === scopeId &&
              !registeredCwdExists(candidate),
          );
          const previousLegacyScopes = legacyScopes;
          const nextLegacyScopes = legacyScopes.filter(
            (candidate) => !removedLegacy.includes(candidate),
          );
          let legacySaved = false;
          try {
            if (includeRegistryV2 && existsSync(runtimeStorePath())) {
              const result = removeScopeRegistryV2({
                scopeId,
                actor: "daemon",
                reason: "scope_cwd_missing",
                beforeCommit: () => {
                  if (removedLegacy.length === 0) return;
                  saveScopesRegistry(nextLegacyScopes);
                  legacySaved = true;
                },
                _commitForTest: commitRegistryV2ForTest,
              });
              if (result.removed > 0) removedV2.push(result.entry);
            } else if (removedLegacy.length > 0) {
              saveScopesRegistry(nextLegacyScopes);
              legacySaved = true;
            }
          } catch (err) {
            if (legacySaved) saveScopesRegistry(previousLegacyScopes);
            throw err;
          }
          legacyScopes = nextLegacyScopes;
          removed.push(...removedLegacy);
          return "prune";
        },
      );
      if (!decision.acquired || decision.value === "retain") {
        retained.push(scopeId);
      }
    }

    return {
      removed,
      removed_v2: removedV2,
      retained,
      kept: legacyScopes.length,
      deferral_scopes: deferralScopes,
    };
  });

  if (!reconciliation.acquired) {
    return {
      removed: [],
      removed_v2: [],
      retained: [],
      kept: loadScopesRegistry().scopes.length,
      lock: reconciliation.details,
    };
  }

  for (const entry of reconciliation.value.removed) {
    appendScopePruned(entry, !includeRegistryV2);
  }
  for (const scope of reconciliation.value.deferral_scopes) {
    withMissingScopeCatalogLease(scope, ({ renew }) => {
      if (!renew() || existsSync(scope.cwd)) return;
      const store = loadClassifiableJobs(scope);
      if (!renew() || !store.trusted) return;
      const enabledJobs = store.jobs.filter(
        (job) => job.state.enabled === true,
      );
      if (enabledJobs.length > 0) {
        recordMissingScopeDeferrals(scope, enabledJobs, { renew });
      }
    });
  }

  return {
    removed: reconciliation.value.removed,
    removed_v2: reconciliation.value.removed_v2,
    retained: reconciliation.value.retained,
    kept: reconciliation.value.kept,
  };
}

export function pruneMissingScopes({ _commitRegistryV2ForTest = null } = {}) {
  return pruneMissingScopesInternal({
    includeRegistryV2: true,
    commitRegistryV2ForTest: _commitRegistryV2ForTest,
  });
}

export function pruneMissingScopesLegacy() {
  return pruneMissingScopesInternal({ includeRegistryV2: false });
}
