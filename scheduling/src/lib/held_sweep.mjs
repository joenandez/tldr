// Start sweep (AC-12): hold runs that failed before held-runs shipped (or while the daemon was down).
import {
  heldHistoryPayload,
  holdOnFailure,
  providerOf,
} from "./held_at_exit.mjs";
import { computeHeldDeadline } from "./held_state.mjs";
import { isHeldJobPaused } from "./job_reregistration.mjs";
import { appendJobHistoryEvent, loadJobHistory } from "./read_store.mjs";
import { computeNextAfterRun } from "./schedule_eval.mjs";
import { mutateJobs } from "./scope_runtime.mjs";
import { loadJobsReadOnly } from "./store.mjs";

// The last run is a failed `completed` with a stdout log and nothing recorded after it.
function lastFailedRun(scope, job) {
  const events = loadJobHistory(scope, job.id, 20);
  const idx = events.findLastIndex((e) => e.kind === "completed");
  const event = events[idx];
  if (!event || event.status !== "failure" || idx !== events.length - 1)
    return null;
  if (!event.log_paths?.stdout || !event.scheduled_at) return null;
  return event;
}

function nextSlotMs(job, slot) {
  try {
    const next = computeNextAfterRun(job, new Date(slot).toISOString());
    return next.next_run_at ? Date.parse(next.next_run_at) : null;
  } catch {
    return null;
  }
}

// The run's final agent (AC-15): same precedence as holdAtExit, then the job's provider.
// The completed event records the deciding agent (held_at_exit decidingAgent / the handed-off marker's agent).
const finalAgent = (job, event) => event.payload?.agent || providerOf(job);

async function tryHold(scope, { job, event, nextSlot }, now) {
  const outcome = await mutateJobs(scope, "held_sweep", (jobs) => {
    const fresh = jobs.find((j) => j.id === job.id);
    if (!fresh?.state || fresh.state.held) return null;
    return holdOnFailure(fresh, {
      runId: event.run_id,
      provider: finalAgent(fresh, event),
      slot: Date.parse(event.scheduled_at),
      stdoutPath: event.log_paths.stdout,
      nextSlot,
      now,
      failedAt: Date.parse(event.finished_at ?? event.ts) || now,
      quietDecline: true, // re-classifying an old failure at every start must not re-log it
    });
  });
  const res = outcome?.ok ? outcome.value : null;
  return res?.decision === "held" ? res : null;
}

async function holdIfFailed(scope, job, now) {
  const event = lastFailedRun(scope, job);
  const slot = Date.parse(event?.scheduled_at);
  const nextSlot = nextSlotMs(job, slot);
  // Past its deadline: skip before reading the log, so old failures are not re-classified every start.
  const inWindow = event && computeHeldDeadline(job, slot, nextSlot) > now;
  const res = inWindow
    ? await tryHold(scope, { job, event, nextSlot }, now)
    : null;
  if (res)
    appendJobHistoryEvent(scope, job.id, {
      id: `run_${event.run_id}_held`,
      ts: new Date(now).toISOString(),
      scope_id: scope.scope_id,
      cwd: scope.cwd,
      job_id: job.id,
      run_id: event.run_id,
      kind: "held",
      status: "held",
      reason: res.held.reason,
      scheduled_at: event.scheduled_at,
      payload: heldHistoryPayload(job, res, { runId: event.run_id }),
    });
  return Boolean(res);
}

async function sweepScope(scope, now) {
  const tally = { held: 0, declined: 0 };
  const candidates = loadJobsReadOnly(scope).filter(
    (job) =>
      job.state?.last_status === "failure" &&
      !job.state.held &&
      !isHeldJobPaused(job),
  );
  // one catalog lease at a time
  for (const job of candidates) {
    // eslint-disable-next-line no-await-in-loop
    if (await holdIfFailed(scope, job, now)) tally.held += 1;
    else tally.declined += 1;
  }
  return tally;
}

// Last logged tally per scope set: a repeat sweep with the same declined-only result stays quiet.
const lastLogged = new Map();

/** @returns {Promise<number>} jobs held */
export async function sweepFailedRuns(scopes, { now, log }) {
  const total = { held: 0, declined: 0 };
  for (const scope of scopes) {
    try {
      // eslint-disable-next-line no-await-in-loop -- one scope at a time
      const tally = await sweepScope(scope, now);
      total.held += tally.held;
      total.declined += tally.declined;
    } catch (error) {
      log("held_sweep.error", "error", { scope_id: scope.scope_id }, error);
    }
  }
  // One line per start, also when every failure was declined (those are not logged one by one).
  const key = scopes.map((s) => s.scope_id).join();
  const tally = `${total.held}/${total.declined}`;
  const changed = lastLogged.get(key) !== tally;
  lastLogged.set(key, tally);
  if (total.held || (total.declined && changed))
    log("held_sweep.done", "info", { scopes: scopes.length, ...total });
  return total.held;
}
