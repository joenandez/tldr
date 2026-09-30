import { clearInfrastructureMarkerForSlot } from "./dispatch_infrastructure_marker.mjs";
import { mutateJobs } from "./scope_runtime.mjs";

const COMPLETION_STATE_FIELDS = [
  "last_run_at",
  "last_status",
  "last_error",
  "last_failed_step",
];

function shouldApplyConflictCompletionState(current, patch) {
  if (patch.state.last_run_at === undefined) return false;
  const currentRunAt = current.state.last_run_at || null;
  const patchRunAt = patch.state.last_run_at || null;
  if (!currentRunAt) return true;
  if (!patchRunAt) return false;
  const currentRunMs = Date.parse(currentRunAt);
  const patchRunMs = Date.parse(patchRunAt);
  if (Number.isFinite(currentRunMs) && Number.isFinite(patchRunMs)) {
    return patchRunMs > currentRunMs;
  }
  return patchRunAt > currentRunAt;
}

function applyCompletionState(current, patch) {
  for (const field of COMPLETION_STATE_FIELDS) {
    if (patch.state[field] !== undefined) {
      current.state[field] = patch.state[field];
    }
  }
}

function applyConflictScheduleState(current, patch, consumedSlot) {
  const patchNext = patch.state.next_run_at;
  const currentNext = current.state.next_run_at;
  const advances =
    patchNext && (!currentNext || new Date(patchNext) > new Date(currentNext));
  const disables =
    patch.state.enabled === false && current.state.enabled !== false;
  const clearsOrdinaryDeferral =
    consumedSlot &&
    patch.state.deferred_since === null &&
    patch.state.deferred_reason === null;
  const currentDeferredSlot = current.state.deferred_since || null;

  if (
    (advances || disables) &&
    clearsOrdinaryDeferral &&
    currentDeferredSlot &&
    currentDeferredSlot !== consumedSlot
  ) {
    return false;
  }
  if (advances) current.state.next_run_at = patchNext;
  if (patch.state.enabled === false) current.state.enabled = false;
  if (clearsOrdinaryDeferral && currentDeferredSlot === consumedSlot) {
    current.state.deferred_since = null;
    current.state.deferred_reason = null;
  }
  return true;
}

function applyRuntimePatch(current, baselineUpdatedAt, patch) {
  const consumedSlot = patch.consumed_phase_aborted_slot || null;
  const unchanged = current.meta?.updated_at === baselineUpdatedAt;
  if (
    patch.observed_source_slot !== undefined &&
    (current.state.next_run_at || null) !== patch.observed_source_slot
  ) {
    return {
      updated: false,
      conflict: true,
      source_slot_conflict: true,
      observed_source_slot: patch.observed_source_slot,
      current_source_slot: current.state.next_run_at || null,
      schedule_patch_applied: false,
      consumed_marker_cleared: false,
    };
  }
  if (unchanged || shouldApplyConflictCompletionState(current, patch)) {
    applyCompletionState(current, patch);
  }
  let schedulePatchApplied = true;
  if (unchanged) {
    if (patch.state.next_run_at !== undefined)
      current.state.next_run_at = patch.state.next_run_at;
    if (patch.state.enabled !== undefined)
      current.state.enabled = patch.state.enabled;
    if (patch.state.deferred_since !== undefined)
      current.state.deferred_since = patch.state.deferred_since;
    if (patch.state.deferred_reason !== undefined)
      current.state.deferred_reason = patch.state.deferred_reason;
    if (
      !consumedSlot &&
      patch.state.infrastructure_deferred_slot !== undefined
    ) {
      current.state.infrastructure_deferred_slot =
        patch.state.infrastructure_deferred_slot;
    }
    if (
      !consumedSlot &&
      patch.state.infrastructure_deferred_reason !== undefined
    ) {
      current.state.infrastructure_deferred_reason =
        patch.state.infrastructure_deferred_reason;
    }
    if (patch.meta_updated_at !== undefined)
      current.meta.updated_at = patch.meta_updated_at;
  } else {
    schedulePatchApplied = applyConflictScheduleState(
      current,
      patch,
      consumedSlot,
    );
  }
  const consumedMarkerCleared = schedulePatchApplied
    ? clearInfrastructureMarkerForSlot(current, consumedSlot)
    : false;
  return {
    updated: true,
    conflict: !unchanged,
    schedule_patch_applied: schedulePatchApplied,
    consumed_marker_cleared: Boolean(consumedMarkerCleared),
  };
}

export async function persistRuntimePatches(
  scope,
  updates,
  { durable = false, mutateJobsFn = mutateJobs } = {},
) {
  if (!Array.isArray(updates) || updates.length === 0) {
    return { ok: true, value: { updated: 0, results: [] } };
  }
  return mutateJobsFn(
    scope,
    `runtime_batch_${Date.now()}`,
    async (jobs) => {
      const jobsById = new Map(jobs.map((job) => [job.id, job]));
      const results = updates.map(({ jobId, baselineUpdatedAt, patch }) => {
        const current = jobsById.get(jobId);
        return {
          job_id: jobId,
          result: current
            ? applyRuntimePatch(current, baselineUpdatedAt, patch)
            : { updated: false, missing: true },
        };
      });
      return {
        updated: results.filter(({ result }) => result.updated).length,
        results,
      };
    },
    { durable },
  );
}

export async function persistRuntimePatch(
  scope,
  jobId,
  baselineUpdatedAt,
  patch,
  { durable = false } = {},
) {
  const result = await persistRuntimePatches(
    scope,
    [{ jobId, baselineUpdatedAt, patch }],
    { durable },
  );
  if (!result.ok) return result;
  return {
    ...result,
    value: result.value.results[0]?.result || {
      updated: false,
      missing: true,
    },
  };
}
