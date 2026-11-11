// Release due holds: stagger release times, then start each ready run through startHeldRun.
// Rules: specs/plan-addendum.md "Held release state model" (in-flight rule 4, end rule 5).
import { orderAndStagger } from "./held_state.mjs";
import { endHoldOnRefusal, isTerminalRefusal } from "./held_release_expire.mjs";
import {
  historyEvent,
  holdKey,
  iso,
  isDue,
  logOnce,
  memory,
  patchHolds,
  readHold,
  releaseBy,
  STAGGER_MS,
} from "./held_release_core.mjs";
import { liveRunsOf, releaseBlocker } from "./held_live_runs.mjs";
import { appendJobHistoryEvent } from "./read_store.mjs";
import { loadActiveRunsReadOnly } from "./store.mjs";

const isRunnable = (job) =>
  job.state.enabled !== false || job.schedule?.type === "once";

const liveRuns = (scope) =>
  liveRunsOf(scope, loadActiveRunsReadOnly(scope).runs);

// A blocked hold waits; say why once, not every tick. Its own run in flight is not a refusal: say nothing.
function quietBlock(scope, job, reason) {
  if (reason === "in_flight") return true;
  // A handed-off release of this process whose marker carries no slot (older marker): also its own run.
  return (
    reason === "handed_off_run" && memory.released.has(holdKey(scope, job))
  );
}

function dueRows(loaded, now, log) {
  return loaded.flatMap(({ scope, jobs, holds }) => {
    if (!holds.length) return [];
    const live = liveRuns(scope);
    return holds
      .filter(isRunnable)
      .filter((job) => isDue(job.state.held, now))
      .filter((job) => {
        const reason = releaseBlocker(live, job);
        if (reason && !quietBlock(scope, job, reason))
          logOnce(log, {
            scope,
            job,
            event: "held.release_blocked",
            status: "info",
            reason,
          });
        return !reason;
      })
      .map((job) => ({ scope, job, jobs }));
  });
}

async function staggerRows(rows, now) {
  const byJob = new Map(rows.map((r) => [r.job, r]));
  const unscheduled = rows
    .filter((r) => !r.job.state.held.release_at)
    .map((r) => r.job);
  const lastScheduled = Math.max(
    now - STAGGER_MS,
    ...rows.map((r) => r.job.state.held.release_at ?? 0),
  );
  const base = Math.max(now, lastScheduled + STAGGER_MS);
  for (const { job, release_at } of orderAndStagger(unscheduled, base)) {
    const { scope } = byJob.get(job);
    // eslint-disable-next-line no-await-in-loop -- one scope lease at a time
    await patchHolds(scope, "held_stagger", [
      {
        jobId: job.id,
        slot: job.state.held.slot,
        apply: (fresh) => {
          fresh.state.held.release_at = release_at;
        },
      },
    ]);
    job.state.held.release_at = release_at;
  }
}

function recordReleased({ scope, job }, handle, log) {
  const held = job.state.held;
  const by = releaseBy(held);
  appendJobHistoryEvent(
    scope,
    job.id,
    historyEvent(
      { scope, jobId: job.id, kind: "released", held },
      {
        status: "released",
        reason: held.reason,
        run_id: handle.runId ?? held.run_id,
        payload: {
          by,
          slot: held.slot,
          attempts: held.attempts ?? 0,
          provider: held.provider,
          reason: held.reason,
          release_at: held.release_at,
        },
      },
    ),
  );
  memory.released.add(holdKey(scope, job));
  log("held.released", "info", {
    job: job.id,
    by,
    attempts: held.attempts ?? 0,
    run: handle.runId ?? null,
  });
}

// Holds were loaded before the usage probe and stagger awaits; a run-now (or a newer failure) may have
// cleared or replaced the hold, or started a run, since. Re-read the hold under the catalog lease (same
// failure only) and the live runs. @returns {Promise<string|null>} why not to start, or null
async function recheck({ scope, job }) {
  const { slot, last_failed_at: failedAt } = job.state.held;
  const fresh = await readHold(scope, "held_release_recheck", job.id);
  if (fresh?.slot !== slot || fresh.last_failed_at !== failedAt)
    return "hold_changed";
  return releaseBlocker(liveRuns(scope), job);
}

// @returns {Promise<boolean>} true when a run was started
async function releaseOne(row, deps) {
  const { scope, job } = row;
  const held = job.state.held;
  const key = holdKey(scope, job);
  memory.inflight.add(key);
  let handle;
  try {
    handle = deps.startHeldRun(scope, job, {
      slot: iso(held.slot),
      heldAttempt: (held.attempts ?? 0) + 1,
    });
  } finally {
    if (!handle?.completion || handle.skipped) memory.inflight.delete(key);
  }
  if (!handle) return false; // concurrency cap / store lease busy: retried next tick
  // In flight until its completion settles (classic: after persist; Skyhook: after handoff, then the marker).
  // The run's own failure is a handled outcome; a throw must not become an unhandled rejection.
  handle.completion
    ?.catch((error) =>
      deps.log("held.release_failed", "error", { job: job.id }, error),
    )
    .finally(() => memory.inflight.delete(key));
  if (handle.skipped) {
    // A refusal repeats every tick until the deadline: log it once.
    logOnce(deps.log, {
      scope,
      job,
      event: "held.release_skipped",
      status: "warn",
      reason: handle.reason ?? "unspecified",
    });
    if (isTerminalRefusal(handle))
      await endHoldOnRefusal(row, handle, deps.log);
    return false;
  }
  recordReleased(row, handle, deps.log);
  return true;
}

export async function releaseDue(loaded, now, deps) {
  const rows = dueRows(loaded, now, deps.log);
  await staggerRows(rows, now);
  let released = 0;
  const ready = rows
    .filter((r) => r.job.state.held.release_at <= now)
    .sort((a, b) => a.job.state.held.release_at - b.job.state.held.release_at);
  for (const row of ready) {
    try {
      // eslint-disable-next-line no-await-in-loop -- one release at a time
      const blocked = await recheck(row);
      if (blocked) {
        if (!quietBlock(row.scope, row.job, blocked))
          deps.log("held.release_skipped", "info", {
            job: row.job.id,
            reason: blocked,
          });
      } else if (
        // Another (e.g. abandoned) phase pass owns this hold's release: never start it twice or drop its key.
        // Checked synchronously right before releaseOne adds the key (recheck's own check is an await earlier).
        !memory.inflight.has(holdKey(row.scope, row.job)) &&
        // eslint-disable-next-line no-await-in-loop -- one release at a time
        (await releaseOne(row, deps))
      )
        released += 1;
    } catch (error) {
      deps.log("held.release_failed", "error", { job: row.job.id }, error);
    }
  }
  return released;
}
