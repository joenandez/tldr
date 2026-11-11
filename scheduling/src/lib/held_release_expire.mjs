// Expire holds whose deadline passed or whose next cron slot is already due; end a hold on a terminal refusal.
// Rules: specs/plan-addendum.md "Held release state model" (rule 5).
import { gaveUpMessage } from "./held_state.mjs";
import {
  defaultLog,
  historyEvent,
  isExpired,
  logOnce,
  patchHolds,
} from "./held_release_core.mjs";
import { liveRunsOf, ownRunInFlight, slotTerminal } from "./held_live_runs.mjs";
import { loadActiveRunsReadOnly } from "./store.mjs";
import { isHeldJobPaused } from "./job_reregistration.mjs";
import { appendJobHistoryEvent } from "./read_store.mjs";

const clearHold = (fresh) => {
  const held = fresh.state.held;
  fresh.state.held = null;
  return held;
};

export function recordExpired(
  { scope, jobId, held, refusal, terminal = null },
  log,
) {
  appendJobHistoryEvent(
    scope,
    jobId,
    historyEvent(
      { scope, jobId, kind: "skipped", held },
      {
        status: "skipped",
        reason: "held_expired",
        error: gaveUpMessage(held, refusal, terminal),
        payload: {
          reason: held.reason,
          provider: held.provider,
          refusal,
          ...(terminal?.terminal_reason && {
            terminal_reason: terminal.terminal_reason,
          }),
        },
      },
    ),
  );
  log("held.expired", "info", {
    job: jobId,
    reason: held.reason,
    slot: held.slot,
    refusal,
  });
}

// Paused while held (pre-existing state; pausing now clears at the root): drop the hold, no gave-up history.
async function clearPausedHolds(entry, log) {
  const paused = entry.holds.filter(isHeldJobPaused);
  if (!paused.length) return;
  const changes = paused.map((job) => ({
    jobId: job.id,
    slot: job.state.held.slot,
    apply: clearHold,
  }));
  const applied = await patchHolds(entry.scope, "held_clear_paused", changes);
  for (const { jobId, value } of applied)
    log("held.cleared", "info", {
      job: jobId,
      reason: "paused",
      slot: value.slot,
    });
  entry.holds = entry.holds.filter((j) => !paused.includes(j));
}

// The hold's own release (or its completion) is still in flight: that run ends the hold (success clears, a
// failure past the deadline is deadline_passed), so a gave-up record now would be a second, false one.
function deferInFlight(entry, stale, log) {
  if (!stale.length) return stale;
  const live = liveRunsOf(
    entry.scope,
    loadActiveRunsReadOnly(entry.scope).runs,
  );
  return stale.filter((job) => {
    if (!ownRunInFlight(live, job)) return true;
    logOnce(log, {
      scope: entry.scope,
      job,
      event: "held.expire_deferred",
      status: "info",
      reason: "own_run_in_flight",
    });
    return false;
  });
}

export async function expireHolds(loaded, now, log) {
  let expired = 0;
  for (const entry of loaded) {
    // eslint-disable-next-line no-await-in-loop -- one scope lease at a time
    await clearPausedHolds(entry, log);
    const stale = deferInFlight(
      entry,
      entry.holds.filter((j) => isExpired(j, now)),
      log,
    );
    if (!stale.length) continue;
    const changes = stale.map((job) => ({
      jobId: job.id,
      slot: job.state.held.slot,
      apply: clearHold,
    }));
    // eslint-disable-next-line no-await-in-loop -- one scope lease at a time
    const applied = await patchHolds(entry.scope, "held_expire", changes);
    for (const { jobId, value } of applied) {
      expired += 1;
      const job = stale.find((j) => j.id === jobId);
      const terminal = slotTerminal(entry.scope, job, value.slot);
      recordExpired({ scope: entry.scope, jobId, held: value, terminal }, log);
    }
    entry.holds = entry.holds.filter((j) => !stale.includes(j));
  }
  return expired;
}

/** Terminal: the ledger will never take this slot again (retries spent, or its logical run is terminal).
 * An in-flight duplicate (terminal_duplicate false), identity_in_flight or a busy lease (null) is transient. */
export const isTerminalRefusal = (handle) =>
  handle.reason === "retry_exhausted" ||
  handle.ledgerClaim?.terminal_duplicate === true;

/** A terminal refusal ends the hold once, only if it is still the same failure (slot and last_failed_at
 * under the catalog lease): one `held_expired` record, "already ran" or, after a lost release, "interrupted". */
export async function endHoldOnRefusal({ scope, job }, handle, log) {
  const { slot, last_failed_at: failedAt } = job.state.held;
  const sameFailure = (fresh) => fresh.state.held.last_failed_at === failedAt;
  const applied = await patchHolds(scope, "held_refused", [
    {
      jobId: job.id,
      slot,
      apply: (fresh) => (sameFailure(fresh) ? clearHold(fresh) : null),
    },
  ]);
  for (const { jobId, value } of applied.filter((a) => a.value))
    recordExpired(
      {
        scope,
        jobId,
        held: value,
        refusal: handle.reason,
        terminal: slotTerminal(scope, job, slot),
      },
      log,
    );
}

/** `tasks pause` / bulk pause: a paused job drops its hold at the root. Call inside the mutateJobs callback. */
export function clearHeldWhenPaused(job, log = defaultLog) {
  if (!isHeldJobPaused(job) || !job.state.held) return;
  log("held.cleared", "info", {
    job: job.id,
    reason: "paused",
    slot: job.state.held.slot,
  });
  job.state.held = null;
}
