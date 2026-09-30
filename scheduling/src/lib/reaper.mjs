import { appendActivityEvent } from "./activity_stream.mjs";
import {
  isPidAlive,
  sampleHeartbeatMs,
  sampleLogActivityMs,
  sampleProcessTreeCpuMs,
} from "./process_state.mjs";
import { isSameProcessAlive } from "./process_liveness.mjs";
import {
  finalizeRunAttempt,
  readSkyhookAttempt,
  runningAttemptWithinFinalizationGrace,
} from "./runtime_ledger.mjs";
import { acquireRuntimeStoreLock } from "./runtime_store.mjs";
import {
  clearActiveRun,
  loadActiveRunsTrusted,
  loadJobs,
  loadReaperState,
  saveReaperState,
} from "./store.mjs";
import { runSatisfiedReportSidecar } from "./effective_owner_completion.mjs";
import { effectiveHardTimeoutSec } from "./run_deadline.mjs";

// Sample state is persisted per-workspace on disk because the daemon spawns
// a fresh child process per scope per tick — in-memory Maps don't survive.
// Stored keyed by run_id → { cpuMs, logMtimeMs, sampledAtMs }.
export function _resetReaperStateForTest() {
  // No-op kept for compat with existing tests; state now lives on disk per-scope.
}

function nowIso() {
  return process.env.HELM_NOW || new Date().toISOString();
}

function msFromIso(iso) {
  return new Date(iso).getTime();
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function quietTimeoutSecFor(job, entry) {
  const fromEntry = entry?.limits?.quiet_timeout_sec;
  if (typeof fromEntry === "number") return fromEntry;
  const fromJob = job?.limits?.quiet_timeout_sec;
  if (typeof fromJob === "number") return fromJob;
  return 900; // 15 min default
}

// Opportunity #9: consecutive flat sample intervals required before a run
// is declared hung. One flat interval aliases too easily with a long
// blocking call; two independent intervals is the floor.
function flatStrikes() {
  const override = Number(process.env.HELM_REAPER_FLAT_STRIKES);
  if (Number.isInteger(override) && override > 0) return override;
  return 2;
}

function sampleIntervalMs(quietSec) {
  const override = Number(process.env.HELM_REAPER_SAMPLE_INTERVAL_SEC);
  if (Number.isFinite(override) && override >= 0) return override * 1000;
  // Floor at 30s to avoid aliasing with normal I/O pauses.
  return Math.max(30, quietSec / 3) * 1000;
}

function graceMs() {
  const override = Number(process.env.HELM_KILL_GRACE_SEC);
  if (Number.isFinite(override) && override >= 0) return override * 1000;
  return 10_000;
}

function isRuntimeStoreLocked(err) {
  return err?.code === "runtime_store_locked";
}

function runtimeStoreLockDetails(err) {
  return {
    code: err?.code || "runtime_store_locked",
    message: err?.message || "runtime store lock is already held",
    lock_path: err?.details?.lock_path || null,
    holder_pid: err?.details?.holder_pid || null,
    owner: err?.details?.owner || null,
    action: "defer_nonfatal",
  };
}

function tryAcquireReaperRuntimeStoreLock() {
  try {
    return acquireRuntimeStoreLock(undefined, {
      owner: `reaper-terminal-finalization:${process.pid}`,
    });
  } catch (err) {
    if (isRuntimeStoreLocked(err)) return null;
    throw err;
  }
}

function signalRunProcess(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

function shouldDeferRuntimeLedgerOrphan(entry, at) {
  if (!entry?.run_id) return false;
  try {
    const attempt = readSkyhookAttempt({ attemptId: entry.run_id });
    return runningAttemptWithinFinalizationGrace(attempt, at);
  } catch {
    return false;
  }
}

async function waitForExitOrDeadline(pid, deadline) {
  if (Date.now() >= deadline || !isPidAlive(pid)) return;
  await sleepMs(100);
  await waitForExitOrDeadline(pid, deadline);
}

export async function reapWorkspace(scope, opts = {}) {
  if (process.env.HELM_REAPER_DISABLE === "1") return { reaped: 0 };

  const daemonInstanceId = opts.daemonInstanceId || null;
  const at = opts.now || nowIso();
  const atMs = msFromIso(at);
  // Opportunity #9: an unreadable active-runs.json must defer the whole
  // pass. Treating it as empty evicted every hang sample below, restarting
  // every hang timer on each transient locked/partial read.
  const active = loadActiveRunsTrusted(scope);
  if (!active.trusted) {
    process.stderr.write(
      `[🪳 TEMP REAPER] active-runs unreadable — deferring reap pass scope=${scope.scope_id || "unknown"} daemon=${daemonInstanceId || "none"} at=${at}\n`,
    );
    return { reaped: 0, deferred: "active_runs_unreadable" };
  }
  const runs = active.runs || {};

  const jobsById = new Map();
  try {
    for (const j of loadJobs(scope)) jobsById.set(j.id, j);
  } catch {
    // No jobs.json yet → treat as empty. Orphan reap still works.
  }

  const samples = loadReaperState(scope).samples;
  let samplesDirty = false;
  let reaped = 0;

  const processRun = async ([jobId, entry]) => {
    if (!entry || !Number.isInteger(entry.pid)) return;

    // ORPHAN: PID dead → clear entry and emit failure.
    // Opportunity #4: identity-verified — a PID that is alive but whose
    // start time mismatches the evidence captured at spawn belongs to an
    // unrelated process (PID reuse). The run is dead; never signal the
    // impostor.
    if (!isSameProcessAlive(entry.pid, entry.pid_start_time || null)) {
      if (shouldDeferRuntimeLedgerOrphan(entry, at)) {
        process.stderr.write(
          `[🪳 TEMP REAPER] active run orphan deferred for finalization grace scope=${scope.scope_id || "unknown"} job=${jobId} run=${entry.run_id || "unknown"} pid=${entry.pid} daemon=${daemonInstanceId || "none"} at=${at}\n`,
        );
        return;
      }
      // A dead wrapper is successful only when its own report sidecar proves
      // the work completed; conversation evidence remains separate.
      const orphanEvidence = effectiveOwnerCompletionForReaper(
        scope,
        jobsById.get(jobId),
        entry,
      );
      if (orphanEvidence.satisfied) {
        clearActiveRun(scope, jobId);
        if (entry.run_id && samples[entry.run_id]) {
          delete samples[entry.run_id];
          samplesDirty = true;
        }
        emitEffectiveOwnerCompletion(
          scope,
          jobId,
          entry,
          at,
          daemonInstanceId,
          orphanEvidence,
        );
        reaped += 1;
        return;
      }
      process.stderr.write(
        `[🪳 TEMP REAPER] active run orphaned scope=${scope.scope_id || "unknown"} job=${jobId} run=${entry.run_id || "unknown"} pid=${entry.pid} daemon=${daemonInstanceId || "none"} at=${at}\n`,
      );
      clearActiveRun(scope, jobId);
      if (entry.run_id && samples[entry.run_id]) {
        delete samples[entry.run_id];
        samplesDirty = true;
      }
      emitFailure(scope, jobId, entry, at, daemonInstanceId, "orphaned");
      reaped += 1;
      return;
    }

    const job = jobsById.get(jobId);
    const startedMs = entry.started_at ? msFromIso(entry.started_at) : atMs;
    const elapsedMs = atMs - startedMs;

    // HARD CAP: opt-in wall-clock kill. Cheap check first (no sampling needed).
    const hardSec = effectiveHardTimeoutSec(job, entry);
    if (hardSec && elapsedMs > hardSec * 1000) {
      await killAndReap(
        scope,
        jobId,
        entry,
        at,
        daemonInstanceId,
        "hard_timeout",
        samples,
        "job_run_completed_timeout",
      );
      samplesDirty = true;
      reaped += 1;
      return;
    }

    // HANG: live PID, all signals flat across flatStrikes() consecutive
    // sample intervals, elapsed > quiet_timeout.
    const quietSec = quietTimeoutSecFor(job, entry);
    if (quietSec <= 0) return; // primary signal disabled
    if (elapsedMs < quietSec * 1000) return; // too young

    // Opportunity #9: a fresh heartbeat is authoritative liveness. An agent
    // blocked on a long model/network call has zero CPU and no log writes —
    // touching HELM_RUN_HEARTBEAT_PATH keeps it alive.
    const hbMs = sampleHeartbeatMs(entry.heartbeat_path);
    if (hbMs && atMs - hbMs < quietSec * 1000) {
      if (entry.run_id && samples[entry.run_id]) {
        delete samples[entry.run_id];
        samplesDirty = true;
      }
      return;
    }

    const cpuMs = sampleProcessTreeCpuMs(entry.pid);
    const logMtimeMs = sampleLogActivityMs(entry.log_paths);
    const prev = entry.run_id ? samples[entry.run_id] : null;

    if (!prev) {
      if (entry.run_id) {
        samples[entry.run_id] = {
          cpuMs,
          logMtimeMs,
          hbMs,
          flatCount: 0,
          sampledAtMs: atMs,
        };
        samplesDirty = true;
      }
      return;
    }

    if (atMs - prev.sampledAtMs < sampleIntervalMs(quietSec)) return; // sample too fresh

    const moved =
      cpuMs !== prev.cpuMs ||
      logMtimeMs !== prev.logMtimeMs ||
      hbMs !== (prev.hbMs ?? 0);
    const flatCount = moved ? 0 : (prev.flatCount ?? 0) + 1;
    if (moved || flatCount < flatStrikes()) {
      samples[entry.run_id] = {
        cpuMs,
        logMtimeMs,
        hbMs,
        flatCount,
        sampledAtMs: atMs,
      };
      samplesDirty = true;
      return;
    }

    await killAndReap(
      scope,
      jobId,
      entry,
      at,
      daemonInstanceId,
      "hung",
      samples,
      "job_run_completed_failure",
    );
    samplesDirty = true;
    reaped += 1;
  };

  await Object.entries(runs).reduce(
    (previous, item) => previous.then(() => processRun(item)),
    Promise.resolve(),
  );

  // Evict stale sample rows for runs that no longer exist in active-runs.
  const activeRunIds = new Set(
    Object.values(runs)
      .map((r) => r?.run_id)
      .filter(Boolean),
  );
  for (const runId of Object.keys(samples)) {
    if (!activeRunIds.has(runId)) {
      delete samples[runId];
      samplesDirty = true;
    }
  }

  if (samplesDirty) saveReaperState(scope, samples);

  return { reaped };
}

async function killAndReap(
  scope,
  jobId,
  entry,
  finishedAt,
  daemonInstanceId,
  reason,
  samples,
  eventType,
) {
  // Opportunity #4: re-verify identity at the kill boundary — the hang/
  // timeout evidence was gathered over minutes, and a recycled PID would
  // make the group-kill below SIGKILL an unrelated process tree.
  // Opportunity #9: TERM→wait→KILL with confirmation and re-escalation —
  // declaring success on the signal call alone left survivors untracked.
  let kill = null;
  if (isSameProcessAlive(entry.pid, entry.pid_start_time || null)) {
    kill = { term_sent: true, kill_attempts: 0, confirmed: false };
    signalRunProcess(entry.pid, "SIGTERM");
    await waitForExitOrDeadline(entry.pid, Date.now() + graceMs());
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (!isSameProcessAlive(entry.pid, entry.pid_start_time || null)) break;
      signalRunProcess(entry.pid, "SIGKILL");
      kill.kill_attempts = attempt;
      // eslint-disable-next-line no-await-in-loop -- sequential escalation by design
      await waitForExitOrDeadline(entry.pid, Date.now() + 2000);
    }
    kill.confirmed = !isSameProcessAlive(
      entry.pid,
      entry.pid_start_time || null,
    );
    if (!kill.confirmed) {
      process.stderr.write(
        `[🪳 TEMP REAPER] kill NOT confirmed after escalation scope=${scope.scope_id || "unknown"} job=${jobId} pid=${entry.pid} reason=${reason}\n`,
      );
    }
  }

  clearActiveRun(scope, jobId);
  if (entry.run_id && samples && samples[entry.run_id])
    delete samples[entry.run_id];
  emitCompletion(
    scope,
    jobId,
    entry,
    finishedAt,
    daemonInstanceId,
    reason,
    eventType || "job_run_completed_failure",
    { kill },
  );
}

function emitFailure(
  scope,
  jobId,
  entry,
  finishedAt,
  daemonInstanceId,
  reason,
) {
  emitCompletion(
    scope,
    jobId,
    entry,
    finishedAt,
    daemonInstanceId,
    reason,
    "job_run_completed_failure",
  );
}

// CANARY-BUG-007: derive the inbound thread/message identity from the resume
// job metadata and ask whether the accepted reply obligation already completed
// via an effective owner. Fail-soft: any missing identity or read error returns
// unsatisfied so the existing orphan path still fires for true crashes.
function effectiveOwnerCompletionForReaper(scope, job, entry) {
  try {
    return runSatisfiedReportSidecar({
      scope,
      runId: entry?.run_id || null,
      jobId: job?.id || null,
    });
  } catch {
    return { satisfied: false };
  }
}

// Finalize a dead-PID run that completed its accepted work via an effective
// owner as a success instead of an orphaned failure.
function emitEffectiveOwnerCompletion(
  scope,
  jobId,
  entry,
  finishedAt,
  daemonInstanceId,
  evidence,
) {
  const reason = "report_sidecar_satisfied";
  if (entry.run_id) {
    const releaseRuntimeStoreLock = tryAcquireReaperRuntimeStoreLock();
    if (!releaseRuntimeStoreLock) {
      process.stderr.write(
        `[🪳 TEMP CANARY_LOST_RECONCILE] reaper effective-owner finalize skipped runtime_store_locked scope=${scope.scope_id || "unknown"} job=${jobId} run=${entry.run_id} daemon=${daemonInstanceId || "none"} at=${finishedAt}\n`,
      );
    } else {
      try {
        finalizeRunAttempt({
          attemptId: entry.run_id,
          status: "success",
          error: reason,
          terminalSource: "reaper",
          now: finishedAt,
        });
      } catch (err) {
        if (isRuntimeStoreLocked(err)) {
          appendActivityEvent({
            type: "job_terminal_finalization_deferred",
            kind: "run",
            level: "info",
            daemon_instance_id: daemonInstanceId,
            scope_id: scope.scope_id,
            cwd: scope.cwd,
            job_id: jobId,
            run_id: entry.run_id || null,
            status: "deferred",
            reason: "runtime_store_locked",
            error: null,
            data: {
              log_paths: entry.log_paths || null,
              reaper: true,
              effective_owner_satisfied: true,
              ...runtimeStoreLockDetails(err),
            },
          });
        } else {
          process.stderr.write(
            `[🪳 TEMP CANARY_LOST_RECONCILE] reaper effective-owner finalize skipped scope=${scope.scope_id || "unknown"} job=${jobId} run=${entry.run_id} error=${err?.message || String(err)} daemon=${daemonInstanceId || "none"} at=${finishedAt}\n`,
          );
        }
      } finally {
        releaseRuntimeStoreLock();
      }
    }
  }
  appendActivityEvent({
    type: "job_run_completed_success",
    kind: "run",
    level: "info",
    daemon_instance_id: daemonInstanceId,
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    job_id: jobId,
    run_id: entry.run_id || null,
    status: "success",
    reason,
    started_at: entry.started_at || null,
    finished_at: finishedAt,
    pid: entry.pid,
    error: null,
    data: {
      log_paths: entry.log_paths || null,
      reaper: true,
      effective_owner_satisfied: true,
      effective_owner_via: evidence?.via || null,
      satisfying_message_id: evidence?.satisfying_message_id || null,
    },
  });
}

function emitCompletion(
  scope,
  jobId,
  entry,
  finishedAt,
  daemonInstanceId,
  reason,
  eventType,
  extra = {},
) {
  const isTimeout = eventType === "job_run_completed_timeout";
  if (entry.run_id) {
    const releaseRuntimeStoreLock = tryAcquireReaperRuntimeStoreLock();
    if (!releaseRuntimeStoreLock) {
      process.stderr.write(
        `[🪳 TEMP CANARY_LOST_RECONCILE] reaper ledger finalize skipped runtime_store_locked scope=${scope.scope_id || "unknown"} job=${jobId} run=${entry.run_id} reason=${reason} daemon=${daemonInstanceId || "none"} at=${finishedAt}\n`,
      );
    } else {
      try {
        finalizeRunAttempt({
          attemptId: entry.run_id,
          status: isTimeout ? "timeout" : "lost",
          error: reason,
          terminalSource: isTimeout ? "reaper" : "lost",
          now: finishedAt,
        });
        process.stderr.write(
          `[🪳 TEMP CANARY_LOST_RECONCILE] reaper finalized ledger scope=${scope.scope_id || "unknown"} job=${jobId} run=${entry.run_id} reason=${reason} terminal_source=${isTimeout ? "reaper" : "lost"} daemon=${daemonInstanceId || "none"} at=${finishedAt}\n`,
        );
      } catch (err) {
        // Reaper emits best-effort evidence even if the ledger row is missing.
        if (isRuntimeStoreLocked(err)) {
          appendActivityEvent({
            type: "job_terminal_finalization_deferred",
            kind: "run",
            level: "info",
            daemon_instance_id: daemonInstanceId,
            scope_id: scope.scope_id,
            cwd: scope.cwd,
            job_id: jobId,
            run_id: entry.run_id || null,
            status: "deferred",
            reason: "runtime_store_locked",
            error: null,
            data: {
              log_paths: entry.log_paths || null,
              reaper: true,
              ...runtimeStoreLockDetails(err),
            },
          });
        } else {
          process.stderr.write(
            `[🪳 TEMP CANARY_LOST_RECONCILE] reaper ledger finalize skipped scope=${scope.scope_id || "unknown"} job=${jobId} run=${entry.run_id} reason=${reason} error=${err?.message || String(err)} daemon=${daemonInstanceId || "none"} at=${finishedAt}\n`,
          );
        }
      } finally {
        releaseRuntimeStoreLock();
      }
    }
  }
  appendActivityEvent({
    type: eventType,
    kind: "run",
    level: "error",
    daemon_instance_id: daemonInstanceId,
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    job_id: jobId,
    run_id: entry.run_id || null,
    status: isTimeout ? "timeout" : "failure",
    reason,
    started_at: entry.started_at || null,
    finished_at: finishedAt,
    pid: entry.pid,
    error: reason,
    data: {
      log_paths: entry.log_paths || null,
      reaper: true,
      kill: extra.kill ?? null,
    },
  });
}
