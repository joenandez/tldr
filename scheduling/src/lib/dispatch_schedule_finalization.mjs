import { appendActivityEvent } from "./activity_stream.mjs";
import {
  PHASE_ABORTED_REASON,
  infrastructureDeferredSlot,
} from "./dispatch_infrastructure_marker.mjs";
import { persistRuntimePatch } from "./dispatch_runtime_persistence.mjs";
import { computeNextAfterRun } from "./schedule_eval.mjs";

export {
  persistRuntimePatch,
  persistRuntimePatches,
} from "./dispatch_runtime_persistence.mjs";

export const NON_LAUNCH_SCHEDULE_ADVANCES = new Set([
  "past_end_at",
  "no_slots",
  "expire_and_skip",
  "condition_miss",
]);

const TERMINAL_LOGICAL_DUPLICATE_STATUSES = new Set([
  "succeeded",
  "success",
  "failed",
  "failure",
  "interrupted",
  "lost",
  "timed_out",
  "timeout",
  "cancelled",
  "skipped",
  "quarantined",
]);

function nowIso() {
  return process.env.HELM_NOW
    ? new Date(process.env.HELM_NOW).toISOString()
    : new Date().toISOString();
}

function isTerminalLogicalLedgerSkip(handle) {
  if (!handle?.ledgerClaim) return false;
  if (handle.ledgerClaim.terminal_duplicate === true) return true;
  return [handle.ledgerClaim.status, handle.ledgerClaim.state].some((value) =>
    TERMINAL_LOGICAL_DUPLICATE_STATUSES.has(String(value || "")),
  );
}

export function applyTerminalLedgerSkip(job, handle, scheduledAt) {
  if (
    handle?.reason !== "duplicate_logical_run" &&
    handle?.reason !== "retry_exhausted"
  ) {
    return null;
  }
  const terminal =
    handle.reason === "retry_exhausted" || isTerminalLogicalLedgerSkip(handle);
  const next = computeNextAfterRun(job, scheduledAt, nowIso());
  job.state.next_run_at = next.next_run_at;
  job.state.last_status = "skipped";
  if (!next.enabled) job.state.enabled = false;
  job.meta.updated_at = nowIso();
  return { terminal };
}

export function runtimePatchFor(
  job,
  consumedInfrastructureSlot = null,
  observedSourceSlot = undefined,
) {
  const consumedSlot = consumedInfrastructureSlot || null;
  return {
    state: {
      enabled: job.state.enabled,
      last_run_at: job.state.last_run_at || null,
      next_run_at: job.state.next_run_at || null,
      last_status: job.state.last_status || "none",
      last_error: job.state.last_error ?? null,
      last_failed_step: job.state.last_failed_step ?? null,
      deferred_since: job.state.deferred_since || null,
      deferred_reason: job.state.deferred_reason || null,
      infrastructure_deferred_slot: consumedSlot
        ? null
        : infrastructureDeferredSlot(job),
      infrastructure_deferred_reason: consumedSlot
        ? null
        : infrastructureDeferredSlot(job)
          ? PHASE_ABORTED_REASON
          : null,
    },
    meta_updated_at: job.meta?.updated_at || nowIso(),
    consumed_phase_aborted_slot: consumedSlot,
    observed_source_slot: observedSourceSlot,
  };
}

function ordinaryDeferralPatchFor(job, observedSourceSlot = undefined) {
  const infrastructureSlot = infrastructureDeferredSlot(job);
  return {
    state: {
      deferred_since: job.state.deferred_since || null,
      deferred_reason: job.state.deferred_reason || null,
      infrastructure_deferred_slot: infrastructureSlot,
      infrastructure_deferred_reason: infrastructureSlot
        ? PHASE_ABORTED_REASON
        : null,
    },
    meta_updated_at: job.meta?.updated_at || nowIso(),
    consumed_phase_aborted_slot: null,
    observed_source_slot: observedSourceSlot,
  };
}

function reportPersistenceFailure({
  scope,
  decision,
  daemonInstanceId,
  error,
}) {
  const message = error?.message || String(error);
  try {
    appendActivityEvent({
      type: "job_dispatch_deferred",
      kind: "run",
      level: "error",
      daemon_instance_id: daemonInstanceId,
      scope_id: scope.scope_id,
      cwd: scope.cwd,
      job_id: decision.job_id,
      scheduled_at: decision.scheduledAt || null,
      status: "deferred",
      reason: "schedule_persist_failed",
      error: message,
      data: {
        decision_action: decision.action,
        storage_error_code: error?.code || null,
      },
    });
  } catch (eventError) {
    process.stderr.write(
      `${JSON.stringify({
        level: "error",
        event: "inproc_schedule_persist_failed",
        scope_id: scope.scope_id,
        job_id: decision.job_id,
        decision_action: decision.action,
        storage_error_code: error?.code || null,
        storage_error: message,
        event_error: eventError?.message || String(eventError),
        timestamp: nowIso(),
      })}\n`,
    );
  }
}

export async function persistInprocScheduleDecision(
  scope,
  decision,
  {
    baselineUpdatedAt = null,
    observedSourceSlot = undefined,
    handle = null,
    daemonInstanceId = null,
  } = {},
) {
  const ledgerSkip =
    decision.action === "launch"
      ? applyTerminalLedgerSkip(decision.job, handle, decision.scheduledAt)
      : null;
  const ordinaryDeferral = decision.action === "defer";
  const scheduleAdvanced =
    Boolean(ledgerSkip) || NON_LAUNCH_SCHEDULE_ADVANCES.has(decision.action);
  if (!scheduleAdvanced && !ordinaryDeferral) {
    return {
      ok: true,
      persistence_required: false,
      state_persisted: false,
      schedule_advanced: false,
      terminal_ledger_skip: false,
    };
  }

  const sourceSlot =
    observedSourceSlot !== undefined
      ? observedSourceSlot
      : decision.scheduledAt || null;
  const consumedSlot = scheduleAdvanced ? sourceSlot : null;
  try {
    const result = await persistRuntimePatch(
      scope,
      decision.job_id,
      baselineUpdatedAt,
      ordinaryDeferral
        ? ordinaryDeferralPatchFor(decision.job, sourceSlot)
        : runtimePatchFor(decision.job, consumedSlot, sourceSlot),
      { durable: true },
    );
    if (!result.ok) {
      const error = Object.assign(
        new Error(result.details?.reason || "catalog lease unavailable"),
        { code: result.details?.reason || "catalog_lease_unavailable" },
      );
      reportPersistenceFailure({ scope, decision, daemonInstanceId, error });
      return {
        ...result,
        error,
        persistence_required: true,
        state_persisted: false,
        schedule_advanced: scheduleAdvanced,
      };
    }
    const statePersisted =
      result.value?.updated === true &&
      result.value?.schedule_patch_applied !== false &&
      (!ordinaryDeferral || result.value?.conflict !== true);
    if (!statePersisted) {
      const retryableConflict =
        result.value?.source_slot_conflict === true ||
        result.value?.conflict === true;
      const error = Object.assign(
        new Error("catalog changed before runtime state could be persisted"),
        {
          code: result.value?.source_slot_conflict
            ? "source_slot_conflict"
            : "runtime_patch_conflict",
          retryable: retryableConflict,
        },
      );
      reportPersistenceFailure({ scope, decision, daemonInstanceId, error });
      return {
        ...result,
        ok: false,
        error,
        persistence_required: true,
        state_persisted: false,
        schedule_advanced: scheduleAdvanced,
        retryable_conflict: retryableConflict,
      };
    }
    return {
      ...result,
      persistence_required: true,
      state_persisted: true,
      schedule_advanced: scheduleAdvanced,
      terminal_ledger_skip: ledgerSkip?.terminal === true,
    };
  } catch (error) {
    reportPersistenceFailure({ scope, decision, daemonInstanceId, error });
    return {
      ok: false,
      error,
      persistence_required: true,
      state_persisted: false,
      schedule_advanced: scheduleAdvanced,
    };
  }
}
