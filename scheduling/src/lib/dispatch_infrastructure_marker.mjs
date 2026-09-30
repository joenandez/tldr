export const PHASE_ABORTED_REASON = "phase_aborted";

function legacyMarker(job) {
  return job?.state?.deferred_reason === PHASE_ABORTED_REASON
    ? job.state.deferred_since || null
    : null;
}

export function infrastructureDeferredSlot(job) {
  const state = job?.state;
  if (
    state?.infrastructure_deferred_reason === PHASE_ABORTED_REASON &&
    state.infrastructure_deferred_slot
  ) {
    return state.infrastructure_deferred_slot;
  }
  return legacyMarker(job);
}

export function infrastructureMarkerThroughSlot(job, scheduledAt) {
  const marker = infrastructureDeferredSlot(job);
  return marker && scheduledAt && marker === scheduledAt ? marker : null;
}

export function migrateLegacyInfrastructureMarker(job) {
  const slot = legacyMarker(job);
  if (!slot) return infrastructureDeferredSlot(job);
  job.state.infrastructure_deferred_slot ||= slot;
  job.state.infrastructure_deferred_reason ||= PHASE_ABORTED_REASON;
  job.state.deferred_since = null;
  job.state.deferred_reason = null;
  return job.state.infrastructure_deferred_slot;
}

export function setInfrastructureMarker(job, reason, slot) {
  job.state.infrastructure_deferred_slot = slot;
  job.state.infrastructure_deferred_reason = reason;
}

export function clearInfrastructureMarkerForSlot(job, slot) {
  if (!slot || !job?.state) return false;
  let cleared = false;
  if (
    job.state.infrastructure_deferred_reason === PHASE_ABORTED_REASON &&
    job.state.infrastructure_deferred_slot === slot
  ) {
    job.state.infrastructure_deferred_slot = null;
    job.state.infrastructure_deferred_reason = null;
    cleared = true;
  }
  if (
    job.state.deferred_reason === PHASE_ABORTED_REASON &&
    job.state.deferred_since === slot
  ) {
    job.state.deferred_since = null;
    job.state.deferred_reason = null;
    cleared = true;
  }
  return cleared;
}
