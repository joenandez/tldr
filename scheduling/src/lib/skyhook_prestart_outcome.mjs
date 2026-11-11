// skyhook_prestart_outcome — close a Skyhook agent run that ended before its start was confirmed.
//
// The agent exited (or failed to launch) inside the startup window, so there is no handoff and no
// pending provider-run marker: this is the run's final outcome. It is finalized like a classic
// completion: the ledger attempt, history `completed failure`, the job's last_* and next_run_at, and
// the same hold entry (holdAtExit + appendHeld) every other seam uses, so a usage limit or outage is
// held (AC-1) on the agent that finally ran (AC-15). Advancing next_run_at consumes the slot; without
// it the next tick re-claimed the slot and the ledger closed it as `skipped retry_exhausted`.

import { appendActivityEvent } from "./activity_stream.mjs";
import { appendHeld, countable, holdAtExit } from "./held_at_exit.mjs";
import { appendJobHistoryEvent, loadJobHistory } from "./read_store.mjs";
import { computeNextAfterRun } from "./schedule_eval.mjs";
import { completionPatchFor } from "./dispatch_schedule_finalization.mjs";
import { persistCompletionPatch } from "./dispatch_runtime_persistence.mjs";

function nowIso() {
  return process.env.HELM_NOW
    ? new Date(process.env.HELM_NOW).toISOString()
    : new Date().toISOString();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function log(event, fields) {
  process.stderr.write(
    `[helm skyhook] ${JSON.stringify({ event, ...fields })}\n`,
  );
}

// Same rule as classic completion (dispatch_service.mjs laterIsoOrCandidate): a held release of an
// older slot never moves next_run_at backwards.
function laterIso(existing, candidate) {
  if (!existing || !candidate) return candidate;
  const existingMs = Date.parse(existing);
  const candidateMs = Date.parse(candidate);
  if (!Number.isFinite(existingMs) || !Number.isFinite(candidateMs))
    return candidate;
  return existingMs > candidateMs ? existing : candidate;
}

/** Consecutive-failure auto-pause, as on classic completion: a held run never counts toward it. */
function autoPauseOnStreak(scope, job, { hold, runId, daemonInstanceId }) {
  const threshold = job.notify?.on_consecutive_failures;
  if (!threshold || hold?.held) return;
  const recent = countable(loadJobHistory(scope, job.id, 1000));
  // This failure is not in history yet, so the streak starts at 1.
  let consecutive = 1;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].status !== "failure" && recent[i].status !== "timeout") break;
    consecutive++;
  }
  if (consecutive < threshold) return;
  job.state.enabled = false;
  appendActivityEvent({
    type: "job_auto_paused",
    kind: "run",
    level: "error",
    daemon_instance_id: daemonInstanceId,
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    job_id: job.id,
    run_id: runId,
    status: "paused",
    data: {
      reason: "consecutive_failure_threshold",
      threshold,
      consecutive_failures: consecutive,
    },
  });
}

/** Job state for the failed run, in memory; returns the hold decision (holdAtExit). */
function applyFailureState(job, failure, ctx) {
  const { scope, runId, scheduledAt, logPaths, finishedAt, daemonInstanceId } =
    ctx;
  const detail = ctx.failureDetail(failure);
  job.state.last_run_at = finishedAt;
  job.state.last_status = "failure";
  job.state.last_error = detail.last_error;
  job.state.last_failed_step = detail.last_failed_step;
  job.state.deferred_since = null;
  job.state.deferred_reason = null;
  // result.agent_fallback.selected_agent names the agent whose output is in logPaths.stdout
  // (each launch truncates the run log), so the hold follows the final outcome.
  const hold = holdAtExit(job, failure, {
    runId,
    scheduledAt,
    logPaths,
    finishedAt,
  });
  const next = computeNextAfterRun(job, scheduledAt || finishedAt, finishedAt);
  job.state.next_run_at = laterIso(job.state.next_run_at, next.next_run_at);
  if (!next.enabled) job.state.enabled = false;
  if (
    job.schedule?.end_at &&
    new Date(finishedAt) > new Date(job.schedule.end_at)
  ) {
    job.state.enabled = false;
    job.state.next_run_at = null;
  }
  job.meta.updated_at = nowIso();
  autoPauseOnStreak(scope, job, { hold, runId, daemonInstanceId });
  return hold;
}

function activityData(job, result, ctx) {
  return {
    metadata: isPlainObject(job.metadata) ? job.metadata : {},
    log_paths: ctx.logPaths,
    wrapper: result.wrapper || null,
    memory: result.memory || result.wrapper?.memory || null,
    output: result.output || null,
    pid: result.pid || ctx.livePid || null,
    signal_source: result.signal_source || null,
    startup_window_ms: result.startup_window_ms || null,
    elapsed_ms: result.elapsed_ms ?? result.duration_ms ?? null,
    agent_session_required: result.agent_session_required === true,
    agent_fallback: result.agent_fallback || null,
    skyhook: true,
  };
}

/**
 * @param {object} ctx dispatch context (incl. scope) plus the dispatcher's own helpers: finalizeAttempt (ledger),
 *   completedEvent (historyCompleteEvent), failureDetail (deriveFailureDetail), livePid.
 * @returns {Promise<object>} the completed history event
 */
export async function finalizeSkyhookPrestartFailure(job, result, ctx) {
  const { scope } = ctx;
  const { runId, startedAt, scheduledAt, reason, daemonInstanceId, logPaths } =
    ctx;
  const finishedAt = nowIso();
  const error = result.error || "agent_start_failed";
  const failure = { ...result, status: "failure", error };
  ctx.finalizeAttempt({
    scope,
    jobId: job.id,
    runId,
    daemonInstanceId,
    metadata: job.metadata || null,
    status: "failure",
    error,
    cleanup: result.wrapper?.cleanup || null,
    exitCode: result.exit_code ?? null,
    terminalSource: "supervisor",
    signalSource: result.signal_source || null,
    startupWindowMs: result.startup_window_ms || null,
    now: finishedAt,
  });
  const hold = applyFailureState(job, failure, { ...ctx, finishedAt });
  const run = { runId, scheduledAt, finishedAt };
  const completed = {
    ...ctx.completedEvent(
      job,
      runId,
      startedAt,
      finishedAt,
      failure,
      logPaths,
      [],
    ),
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    scheduled_at: scheduledAt,
    exit_code: result.exit_code ?? null, // as the post-handoff completed event
  };
  appendJobHistoryEvent(scope, job.id, completed);
  appendHeld(scope, run, hold);
  appendActivityEvent({
    type: "job_run_completed_failure",
    kind: "run",
    level: "error",
    daemon_instance_id: daemonInstanceId,
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    job_id: job.id,
    run_id: runId,
    status: "failure",
    reason,
    scheduled_at: scheduledAt,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: result.duration_ms,
    elapsed_ms: result.elapsed_ms ?? result.duration_ms,
    pid: ctx.livePid,
    error,
    data: activityData(job, result, ctx),
  });
  const persisted = await persistCompletionPatch(
    scope,
    {
      jobId: job.id,
      baselineUpdatedAt: ctx.baselineUpdatedAt,
      patch: completionPatchFor(job, ctx.consumedPhaseAbortedSlot, {
        hold,
        scheduledAt,
      }),
      heldDeadline: ctx.heldDeadline,
    },
    reason,
  );
  log("skyhook.prestart_finalized", {
    scope: scope.scope_id || null,
    job: job.id,
    run: runId,
    error,
    signal_source: result.signal_source || null,
    agent: result.agent_fallback?.selected_agent || null,
    hold: hold?.decision ?? null,
    next_run_at: job.state.next_run_at || null,
    persisted: persisted?.ok !== false,
  });
  return completed;
}
