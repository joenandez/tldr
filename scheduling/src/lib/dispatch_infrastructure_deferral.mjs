import { dueScheduleSlots } from "./dispatch_evaluator.mjs";
import {
  PHASE_ABORTED_REASON,
  infrastructureDeferredSlot,
  migrateLegacyInfrastructureMarker,
  setInfrastructureMarker,
} from "./dispatch_infrastructure_marker.mjs";
import { mutateJobs } from "./scope_runtime.mjs";

const PROTECTED_REASONS = new Set([PHASE_ABORTED_REASON]);
const pendingDeferrals = new Map();

function scopeKey(scope) {
  return scope?.scope_id || scope?.cwd || null;
}

function reportPersistenceFailure(result, at) {
  try {
    process.stderr.write(
      `${JSON.stringify({
        level: "error",
        event: "scope_dispatch_deferral_persist_failed",
        reason: result.reason,
        code: result.code,
        error: result.error,
        timestamp: at,
      })}\n`,
    );
  } catch {
    // The aggregate daemon event still reports the persistence failure.
  }
}

function hasProtectedMarker(job) {
  return infrastructureDeferredSlot(job) === job?.state?.next_run_at;
}

function isNormallyEligible(job, at) {
  if (job?.state?.enabled !== true || !job.state.next_run_at) return false;
  const unmarkedJob = {
    ...job,
    state: {
      ...job.state,
      deferred_since: null,
      deferred_reason: null,
      infrastructure_deferred_slot: null,
      infrastructure_deferred_reason: null,
    },
  };
  try {
    const decision = dueScheduleSlots(unmarkedJob, at, 1);
    return (
      decision.due === true && decision.slots.includes(job.state.next_run_at)
    );
  } catch {
    return false;
  }
}

export async function recordInfrastructureDispatchDeferral({
  scope,
  reason,
  at = new Date().toISOString(),
  mutateJobsFn = mutateJobs,
} = {}) {
  if (!scope || !PROTECTED_REASONS.has(reason)) {
    return {
      ok: true,
      ignored: true,
      reason,
      protected_job_count: 0,
      changed_job_count: 0,
    };
  }

  try {
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs)) throw new Error(`invalid deferral time: ${at}`);
    const mutation = await mutateJobsFn(
      scope,
      `infrastructure_deferral_${process.pid}_${atMs}`,
      (jobs) => {
        let protectedJobCount = 0;
        let changedJobCount = 0;
        for (const job of jobs) {
          if (hasProtectedMarker(job)) {
            const legacyMarker =
              job.state?.deferred_reason === PHASE_ABORTED_REASON;
            migrateLegacyInfrastructureMarker(job);
            protectedJobCount += 1;
            if (legacyMarker) changedJobCount += 1;
            continue;
          }
          if (infrastructureDeferredSlot(job) || !isNormallyEligible(job, at)) {
            continue;
          }
          protectedJobCount += 1;
          setInfrastructureMarker(job, reason, job.state.next_run_at);
          job.meta = { ...(job.meta || {}), updated_at: at };
          changedJobCount += 1;
        }
        return {
          protected_job_count: protectedJobCount,
          changed_job_count: changedJobCount,
        };
      },
      { durable: true },
    );
    if (!mutation.ok) {
      return {
        ok: false,
        ignored: false,
        reason,
        protected_job_count: 0,
        changed_job_count: 0,
        error:
          mutation.details?.message ||
          mutation.details?.reason ||
          "catalog lease unavailable",
        code: mutation.details?.code || mutation.details?.reason || null,
      };
    }
    return {
      ok: true,
      ignored: false,
      reason,
      protected_job_count: mutation.value.protected_job_count,
      changed_job_count: mutation.value.changed_job_count,
    };
  } catch (err) {
    return {
      ok: false,
      ignored: false,
      reason,
      protected_job_count: 0,
      changed_job_count: 0,
      error: err?.message || String(err),
      code: err?.code || null,
    };
  }
}

export async function recordInfrastructureDispatchDeferrals(
  deferred,
  {
    at = new Date().toISOString(),
    record = recordInfrastructureDispatchDeferral,
    reportFailure = reportPersistenceFailure,
  } = {},
) {
  const entries = (deferred || []).filter((entry) =>
    PROTECTED_REASONS.has(entry?.reason),
  );
  const results = await Promise.all(
    entries.map(async (entry) => ({
      entry,
      result: await record({ scope: entry.scope, reason: entry.reason, at }),
    })),
  );
  for (const { entry, result } of results) {
    const key = scopeKey(entry.scope);
    if (result.ok) {
      if (key) pendingDeferrals.delete(key);
      continue;
    }
    reportFailure(result, at);
    if (key && !pendingDeferrals.has(key)) {
      pendingDeferrals.set(key, {
        scope: entry.scope,
        reason: entry.reason,
        at,
        attempts: 1,
        last_error: result.error,
        last_code: result.code,
      });
    }
  }
  const failures = results.filter(({ result }) => !result.ok);
  return {
    attempted_scope_count: results.length,
    protected_job_count: results.reduce(
      (sum, { result }) => sum + result.protected_job_count,
      0,
    ),
    failure_count: failures.length,
    pending_protection_scope_count: pendingDeferrals.size,
    protection_guaranteed: pendingDeferrals.size === 0,
    failure_reason:
      pendingDeferrals.size > 0 ? "infrastructure_protection_pending" : null,
  };
}

export async function retryPendingInfrastructureDispatchDeferrals({
  record = recordInfrastructureDispatchDeferral,
  reportFailure = reportPersistenceFailure,
} = {}) {
  const entries = [...pendingDeferrals.entries()];
  const results = await Promise.all(
    entries.map(async ([key, pending]) => ({
      key,
      pending,
      result: await record({
        scope: pending.scope,
        reason: pending.reason,
        at: pending.at,
      }),
    })),
  );
  let resolvedScopeCount = 0;
  for (const { key, pending, result } of results) {
    if (result.ok) {
      pendingDeferrals.delete(key);
      resolvedScopeCount += 1;
      continue;
    }
    reportFailure(result, pending.at);
    pendingDeferrals.set(key, {
      ...pending,
      attempts: pending.attempts + 1,
      last_error: result.error,
      last_code: result.code,
    });
  }
  return {
    attempted_scope_count: results.length,
    resolved_scope_count: resolvedScopeCount,
    failure_count: results.length - resolvedScopeCount,
    pending_protection_scope_count: pendingDeferrals.size,
    unresolved_scope_ids: [...pendingDeferrals.values()].map(({ scope }) =>
      scopeKey(scope),
    ),
    protection_guaranteed: pendingDeferrals.size === 0,
    failure_reason:
      pendingDeferrals.size > 0 ? "infrastructure_protection_pending" : null,
  };
}

export async function prepareInfrastructureProtectedDispatch({
  scopes = [],
  appendActivityEvent = null,
  daemonInstanceId = null,
  retry = retryPendingInfrastructureDispatchDeferrals,
} = {}) {
  const retryResult = await retry();
  if (retryResult.failure_count > 0 && appendActivityEvent) {
    appendActivityEvent({
      event_type: "scope_dispatch_deferred",
      level: "error",
      status: "deferred",
      reason: "infrastructure_protection_pending",
      daemon_instance_id: daemonInstanceId,
      metadata: {
        deferred_scope_count: retryResult.pending_protection_scope_count,
        launched_scope_count: 0,
        aborted: false,
        reasons: {
          infrastructure_protection_pending:
            retryResult.pending_protection_scope_count,
        },
        scope_ids: retryResult.unresolved_scope_ids.slice(0, 20),
        durable_deferral_retry: retryResult,
      },
    });
  }
  const unresolved = new Set(retryResult.unresolved_scope_ids);
  return {
    retry: retryResult,
    dispatchScopes: scopes.filter((scope) => !unresolved.has(scope.scope_id)),
    deferredResults: scopes
      .filter((scope) => unresolved.has(scope.scope_id))
      .map((scope) => ({
        scope,
        ok: true,
        skipped: true,
        reason: "infrastructure_protection_pending",
      })),
  };
}

export function pendingInfrastructureDispatchDeferrals() {
  return [...pendingDeferrals.values()].map((entry) => ({ ...entry }));
}

export function resetPendingInfrastructureDispatchDeferralsForTests() {
  pendingDeferrals.clear();
}
