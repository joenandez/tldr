import { existsSync } from "node:fs";
import { acquireLease, releaseLease, renewLease } from "./lock.mjs";
import { listScopeRegistryV2 } from "./scope_registry_v2.mjs";
import { runtimeStorePath } from "./runtime_store.mjs";
import { loadJobs, loadScopesRegistry, saveJobs } from "./store.mjs";

const MISSING_SCOPE_MUTATION = Symbol("missing_scope_mutation");

function missingScopeIsRegistered(scope) {
  const legacyRegistered = loadScopesRegistry().scopes.some(
    (entry) => (entry.scope_id || entry.cwd) === scope.scope_id,
  );
  if (!legacyRegistered) return false;
  if (!existsSync(runtimeStorePath())) return true;
  try {
    return listScopeRegistryV2().entries.some(
      (entry) => entry.scope_id === scope.scope_id,
    );
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withNamedScopeLease(scope, owner, lockName, fn) {
  const leaseSec = Number(process.env.HELM_LEASE_SEC || 90);
  const acquired = acquireLease(scope, owner, leaseSec, lockName);
  if (!acquired.acquired) {
    return { ok: false, details: acquired };
  }
  const renewTimer = setInterval(
    () => {
      renewLease(scope, owner, leaseSec, lockName);
    },
    Math.max(5000, Math.floor((leaseSec * 1000) / 3)),
  );
  try {
    return { ok: true, value: await fn() };
  } finally {
    clearInterval(renewTimer);
    releaseLease(scope, owner, lockName);
  }
}

export async function withExecutionLease(scope, owner, fn) {
  return withNamedScopeLease(scope, owner, "execution.lock", fn);
}

export async function withCatalogLease(scope, owner, fn) {
  return withNamedScopeLease(scope, owner, "catalog.lock", fn);
}

export async function withScopeLease(scope, owner, fn) {
  return withExecutionLease(scope, owner, fn);
}

// User-initiated mutations retry briefly to ride out transient lease
// contention from the daemon's per-tick dispatch lease (held for ms).
// Long-held intentional locks (e.g., test_helm_service.mjs's synthetic
// lock with a far-future lease_until) outlast the retry window and
// still surface as scope_busy.
export async function mutateJobs(
  scope,
  owner,
  fn,
  { durable = false, beforeSave = null, onSaveFailure = null } = {},
) {
  const retryMs = Number(process.env.HELM_LEASE_RETRY_MS ?? 2000);
  const intervalMs = 150;
  const deadline = Date.now() + retryMs;
  let result;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- Catalog lease retries are intentionally sequential.
    result = await withCatalogLease(scope, owner, async () => {
      if (!existsSync(scope.cwd) && !missingScopeIsRegistered(scope)) {
        return MISSING_SCOPE_MUTATION;
      }
      const jobs = loadJobs(scope);
      const enabledJobIds = new Set(
        jobs.filter((job) => job?.state?.enabled === true).map((job) => job.id),
      );
      try {
        const value = await fn(jobs);
        if (
          !existsSync(scope.cwd) &&
          jobs.some(
            (job) => job?.state?.enabled === true && !enabledJobIds.has(job.id),
          )
        ) {
          if (onSaveFailure) await onSaveFailure();
          return MISSING_SCOPE_MUTATION;
        }
        if (beforeSave) await beforeSave();
        saveJobs(scope, jobs, { durable });
        return value;
      } catch (err) {
        if (onSaveFailure) await onSaveFailure(err);
        throw err;
      }
    });
    if (result.ok && result.value === MISSING_SCOPE_MUTATION) {
      return {
        ok: false,
        details: {
          reason: "scope_cwd_missing",
          scope_id: scope.scope_id,
          cwd: scope.cwd,
        },
      };
    }
    if (result.ok || Date.now() >= deadline) return result;
    // eslint-disable-next-line no-await-in-loop -- Backoff must complete before the next lease attempt.
    await sleep(intervalMs);
  }
}
