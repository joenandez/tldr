// command_exit_finalization — close a handed-off command run with the outcome
// its own process recorded.
//
// Two observers can see the exit: the dispatcher, when it outlives the command
// (in-process daemon dispatch, or a dispatcher kept alive by a timeout timer),
// and the reaper, which notices the dead wrapper PID on a later pass and reads
// the exit record the wrapper wrote. Whichever arrives first finalizes; an
// exclusive-create claim file next to the exit record makes the second a no-op
// even across processes.

import {
  closeSync,
  openSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { appendActivityEvent } from "./activity_stream.mjs";
import { appendJobHistoryEvent } from "./read_store.mjs";
import { finalizeRunAttempt } from "./runtime_ledger.mjs";
import { persistRuntimePatch } from "./dispatch_runtime_persistence.mjs";
import { clearActiveRun, loadActiveRunsReadOnly } from "./store.mjs";

function nowIso() {
  return process.env.HELM_NOW
    ? new Date(process.env.HELM_NOW).toISOString()
    : new Date().toISOString();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// A claim older than this belongs to a finalizer that died before clearing
// the active run (e.g. a dispatcher killed by its child timeout); the next
// observer takes over rather than dropping the recorded outcome.
const STALE_CLAIM_MS = 60_000;

function claimPath(exitRecordPath) {
  return `${exitRecordPath}.finalized`;
}

function claimFinalization(exitRecordPath) {
  const path = claimPath(exitRecordPath);
  try {
    closeSync(openSync(path, "wx"));
    return true;
  } catch (err) {
    if (err?.code !== "EEXIST") {
      // Unwritable log dir: fall back to the active-run check alone.
      return true;
    }
  }
  try {
    if (Date.now() - statSync(path).mtimeMs < STALE_CLAIM_MS) return false;
    utimesSync(path, new Date(), new Date());
    return true;
  } catch {
    return false;
  }
}

function releaseClaim(exitRecordPath) {
  try {
    rmSync(claimPath(exitRecordPath), { force: true });
  } catch {
    /* best effort */
  }
}

function isRuntimeStoreLocked(err) {
  return err?.code === "runtime_store_locked";
}

function terminalFor(outcome) {
  if (!outcome) {
    // The wrapper died without recording (SIGKILL, machine sleep/crash).
    return {
      historyStatus: "failure",
      ledgerStatus: "lost",
      terminalSource: "lost",
      error: "exit_status_unrecorded",
      exitCode: null,
    };
  }
  if (outcome.status === "timeout") {
    // The reaper killed it at its hard cap.
    return {
      historyStatus: "timeout",
      ledgerStatus: "timeout",
      terminalSource: "reaper",
      error: outcome.error || "hard_timeout",
      exitCode: null,
    };
  }
  const exitCode = Number.isInteger(outcome.exit_code)
    ? outcome.exit_code
    : null;
  const success = exitCode === 0 && !outcome.error;
  return {
    historyStatus: success ? "success" : "failure",
    ledgerStatus: success ? "success" : "failure",
    terminalSource: "process-exit",
    error: success
      ? null
      : outcome.error ||
        (exitCode === null ? "exit_status_unknown" : `exit_code_${exitCode}`),
    exitCode,
  };
}

/**
 * Finalize one handed-off command run.
 *
 * @param {object} params
 * @param {object} params.scope
 * @param {string} params.jobId
 * @param {object} params.entry        the run's active-runs entry
 * @param {object|null} params.outcome exit record / terminal outcome, or null when none was recorded
 * @param {object|null} [params.job]   job definition, for history metadata
 * @param {string|null} [params.daemonInstanceId]
 * @param {string} params.observedBy   "dispatcher" | "reaper"
 * @returns {Promise<{finalized: boolean, reason?: string, status?: string}>}
 */
export async function finalizeCommandExit({
  scope,
  jobId,
  entry,
  outcome,
  job = null,
  daemonInstanceId = null,
  observedBy,
}) {
  const runId = entry?.run_id || null;
  if (!runId) return { finalized: false, reason: "no_run_id" };
  const active = loadActiveRunsReadOnly(scope).runs?.[jobId];
  if (!active || active.run_id !== runId) {
    return { finalized: false, reason: "not_active" };
  }
  if (entry.exit_record_path && !claimFinalization(entry.exit_record_path)) {
    return { finalized: false, reason: "already_claimed" };
  }

  const finishedAt = outcome?.finished_at || nowIso();
  const terminal = terminalFor(outcome);
  try {
    finalizeRunAttempt({
      attemptId: runId,
      status: terminal.ledgerStatus,
      error: terminal.error || "process_exited",
      exitCode: terminal.exitCode,
      terminalSource: terminal.terminalSource,
      now: finishedAt,
    });
  } catch (err) {
    if (isRuntimeStoreLocked(err)) {
      // Leave the run active and unclaimed: the reaper retries on its next
      // pass, so the ledger and history never disagree.
      if (entry.exit_record_path) releaseClaim(entry.exit_record_path);
      process.stderr.write(
        `[helm command-exit] ledger locked; finalize deferred scope=${scope.scope_id || "unknown"} job=${jobId} run=${runId} observed_by=${observedBy}\n`,
      );
      return { finalized: false, reason: "runtime_store_locked" };
    }
    process.stderr.write(
      `[helm command-exit] ledger finalize skipped scope=${scope.scope_id || "unknown"} job=${jobId} run=${runId} error=${err?.message || String(err)}\n`,
    );
  }
  clearActiveRun(scope, jobId);

  const startedAt = entry.started_at || null;
  const durationMs =
    startedAt && Number.isFinite(Date.parse(finishedAt))
      ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt))
      : null;
  const metadata = isPlainObject(job?.metadata) ? job.metadata : {};
  const success = terminal.historyStatus === "success";
  process.stderr.write(
    `[helm command-exit] finalized scope=${scope.scope_id || "unknown"} job=${jobId} run=${runId} status=${terminal.historyStatus} exit_code=${terminal.exitCode ?? "none"} error=${terminal.error || "none"} observed_by=${observedBy}\n`,
  );
  appendActivityEvent({
    type: success
      ? "job_run_completed_success"
      : terminal.historyStatus === "timeout"
        ? "job_run_completed_timeout"
        : "job_run_completed_failure",
    kind: "run",
    level: success ? "info" : "error",
    daemon_instance_id: daemonInstanceId,
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    job_id: jobId,
    run_id: runId,
    status: terminal.historyStatus,
    reason: success ? "process_exited" : terminal.error,
    scheduled_at: entry.scheduled_at || null,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: durationMs,
    pid: entry.pid || null,
    error: terminal.error,
    data: {
      metadata,
      log_paths: entry.log_paths || null,
      exit_code: terminal.exitCode,
      handoff: true,
      observed_by: observedBy,
    },
  });
  appendJobHistoryEvent(scope, jobId, {
    id: `run_${runId}_completed`,
    ts: finishedAt,
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    job_id: jobId,
    run_id: runId,
    kind: "completed",
    status: terminal.historyStatus,
    reason: success ? "process_exited" : terminal.error,
    scheduled_at: entry.scheduled_at || null,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: durationMs,
    error: terminal.error,
    exit_code: terminal.exitCode,
    log_paths: entry.log_paths || null,
    payload: {
      metadata,
      log_paths: entry.log_paths || null,
      exit_code: terminal.exitCode,
      handoff: true,
      observed_by: observedBy,
    },
  });
  // Completion fields only: the schedule already advanced at handoff. A null
  // baseline takes the conflict path, which applies these only when this
  // finish is newer than the job's recorded last run.
  await persistRuntimePatch(scope, jobId, null, {
    state: {
      last_run_at: finishedAt,
      last_status: terminal.historyStatus,
      last_error: terminal.error,
      last_failed_step: null,
    },
  });
  return { finalized: true, status: terminal.historyStatus };
}

/**
 * `tasks cancel` on a handed-off command run: claim it so no observer later
 * reports the killed command's exit as the outcome, and close the ledger
 * attempt so the job is not held in flight. The caller records the
 * cancellation in history and clears the active run.
 */
export function closeCancelledCommandRun({ scope, jobId, entry }) {
  if (!entry?.exit_record_path || !entry.run_id) return { closed: false };
  claimFinalization(entry.exit_record_path);
  try {
    finalizeRunAttempt({
      attemptId: entry.run_id,
      status: "interrupted",
      error: "cancelled",
      terminalSource: "cancel",
      now: nowIso(),
    });
    return { closed: true };
  } catch (err) {
    process.stderr.write(
      `[helm command-exit] cancel ledger finalize skipped scope=${scope.scope_id || "unknown"} job=${jobId} run=${entry.run_id} error=${err?.message || String(err)}\n`,
    );
    return { closed: false };
  }
}
