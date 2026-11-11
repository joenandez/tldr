import { clearInfrastructureMarkerForSlot } from "./dispatch_infrastructure_marker.mjs";
import { mutateJobs } from "./scope_runtime.mjs";
import { heldNow } from "./held_release_core.mjs";
import { settleFiredOnceRun, staleOncePatch } from "./job_reregistration.mjs";

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

// A changed baseline may mean the held_release phase or `tasks release-held` wrote the hold meanwhile.
// The run's own slot (clear on success, re-hold on failure) still lands; a hold for another slot,
// or one this run did not touch (held undefined), is never overwritten or resurrected. The one
// exception is a success that finished after the hold was set: it ends the hold whatever its slot
// (clearHeldOnSuccess), else a run-now in flight during `release-held` leaves a hold that releases
// a second run after it.
const successAfterHold = (held, patch) =>
  patch.state.held === null &&
  patch.state.last_status === "success" &&
  Date.parse(patch.state.last_run_at) >= held.last_failed_at;

function shouldApplyHeld(current, patch, unchanged) {
  if (patch.state.held === undefined) return false;
  const held = current.state.held;
  return (
    unchanged ||
    !held ||
    held.slot === patch.held_slot ||
    successAfterHold(held, patch)
  );
}

// Fired wins for a once-run (settleFiredOnceRun); a stale idle once-patch writes nothing; else fix-10.
function applyScheduleFields(current, patch, advances) {
  if (
    settleFiredOnceRun(current, patch, "runtime_patch") ||
    staleOncePatch(current, patch)
  )
    return;
  const patchNext = patch.state.next_run_at;
  if (advances) current.state.next_run_at = patchNext;
  if (patch.state.enabled === false) current.state.enabled = false;
  // A fired one-off reads exhausted (next null), not paused, even after an edit during its run.
  if (
    patch.state.enabled === false &&
    patchNext === null &&
    current.schedule?.type === "once"
  )
    current.state.next_run_at = null;
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
  applyScheduleFields(current, patch, advances);
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
  if (shouldApplyHeld(current, patch, unchanged)) {
    current.state.held = patch.state.held;
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const heldLog = (line) =>
  process.stderr.write(`[helm held] ${JSON.stringify(line)}\n`);
const landed = (result) =>
  result?.ok === true || result?.details?.reason === "scope_cwd_missing";

async function tryPersist(once) {
  try {
    return { result: await once() };
  } catch (error) {
    return { result: null, error };
  }
}

// A persist that keeps failing is an environmental fault (ENOSPC, EACCES, a corrupt catalog), not contention.
const PERSIST_GIVE_UP_MS = 10 * 60_000;
const PERSIST_FLOOR_MS = 30_000;

/** How long a held completion persist may retry: until the hold's deadline, at least 30 s (a past deadline
 * still rides out lease contention), at most 10 min. The deadline is on the held clock (heldNow, which honors
 * HELM_NOW), so the time left is measured there; the wait itself is real time (fgp.52). */
export const persistBoundMs = (deadline, now = heldNow()) =>
  Math.min(
    PERSIST_GIVE_UP_MS,
    Math.max(
      PERSIST_FLOOR_MS,
      Number.isFinite(deadline) ? deadline - now : Infinity,
    ),
  );

function recovered(jobId, failures, { result }) {
  if (failures)
    heldLog({
      event: "held.persist_recovered",
      status: "info",
      job: jobId,
      failures,
    });
  return result;
}

function abandon(jobId, failures, { result, error }) {
  heldLog({
    event: "held.persist_abandoned",
    status: "error",
    job: jobId,
    failures,
    reason: result?.details?.reason ?? null,
    error: error ? { message: error.message, stack: error.stack } : null,
  });
  return result ?? { ok: false, details: { reason: "persist_abandoned" } };
}

function logFirstFailure(jobId, { result, error }) {
  heldLog({
    event: "held.persist_retry",
    status: "warn",
    job: jobId,
    reason: result?.details?.reason ?? null,
    error: error ? { message: error.message, stack: error.stack } : null,
  });
}

/**
 * A completion's persist. A held release is in flight until its outcome is on the hold (plan-addendum
 * "Held release state model", rule 4): a lost persist would end the hold "already ran" beside its own record,
 * or drop a re-hold. So for reason "held_release" it retries (lease contention or a throw) until applied, the
 * scope is gone, or the bound passes (persistBoundMs: the hold's deadline `update.heldDeadline`, floored at 30 s,
 * capped at 10 min). Then it logs held.persist_abandoned and returns, so the release settles; the next tick
 * puts the release's real outcome on the hold from its ledger and history records (held_reconcile.mjs,
 * fgp.52). Every other run persists once, as before.
 * @param {{jobId: string, baselineUpdatedAt: string|null, patch: object, heldDeadline?: number|null}} update
 */
export async function persistCompletionPatch(scope, update, reason = null) {
  const { jobId, baselineUpdatedAt, patch, heldDeadline = null } = update;
  const once = () =>
    persistRuntimePatch(scope, jobId, baselineUpdatedAt, patch);
  if (reason !== "held_release") return once();
  const giveUpAt = Date.now() + persistBoundMs(heldDeadline);
  for (let failures = 0, delay = 250; ; failures += 1) {
    // eslint-disable-next-line no-await-in-loop -- retried in order until applied
    const attempt = await tryPersist(once);
    if (landed(attempt.result)) return recovered(jobId, failures, attempt);
    if (!failures) logFirstFailure(jobId, attempt);
    const left = giveUpAt - Date.now();
    if (left <= 0) return abandon(jobId, failures + 1, attempt);
    // eslint-disable-next-line no-await-in-loop -- backoff before the next try
    await sleep(Math.min(delay, left));
    delay = Math.min(delay * 2, 30_000);
  }
}
