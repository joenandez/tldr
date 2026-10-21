// provider_run_outcome — record how a handed-off agent session actually ended.
//
// A Skyhook handoff proves the launch, not the work, so history and the job's
// last_status say `started` until the session's process ends (tldr <-> Academy
// provider-run outcome contract, C2). Its exit then becomes the run's final
// history record and last_status: exit 0 -> success, non-zero -> failure with
// exit_code_<n>, killed -> failure with the signal. The dispatcher records it
// when still alive; otherwise the next daemon tick reads the session-outcome
// record the session's own boundary wrapper writes (run_session_outcome.mjs),
// or closes the run as lost once its process group is gone with no record.
// A pending marker per run is claimed by whichever observer finalizes first.
// The runtime ledger is untouched: it governs dispatch, not the work outcome.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { join } from "node:path";
import { appendActivityEvent } from "./activity_stream.mjs";
import { isSameProcessAlive } from "./process_liveness.mjs";
import { appendJobHistoryEvent } from "./read_store.mjs";
import { readRunSessionOutcomeState } from "./run_session_outcome.mjs";
import { mutateJobs } from "./scope_runtime.mjs";
import { scopeRuntimeRoot } from "./store.mjs";

const MARKER_VERSION = "1.0";
const RUN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
// A claim older than this belongs to a finalizer that died mid-way; the next
// observer takes over rather than dropping the outcome.
const STALE_CLAIM_MS = 60_000;

function nowIso() {
  return process.env.HELM_NOW
    ? new Date(process.env.HELM_NOW).toISOString()
    : new Date().toISOString();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pendingDir(scope) {
  return join(scopeRuntimeRoot(scope), "provider-runs");
}

function markerPath(scope, runId) {
  return join(pendingDir(scope), `${runId}.json`);
}

function claimPath(path) {
  return `${path}.claim`;
}

function claim(path) {
  const lock = claimPath(path);
  try {
    closeSync(openSync(lock, "wx"));
    return true;
  } catch (err) {
    if (err?.code !== "EEXIST") return false;
  }
  try {
    if (Date.now() - statSync(lock).mtimeMs < STALE_CLAIM_MS) return false;
    utimesSync(lock, new Date(), new Date());
    return true;
  } catch {
    return false;
  }
}

function releaseClaim(path) {
  try {
    rmSync(claimPath(path), { force: true });
  } catch {
    /* best effort */
  }
}

function readMarker(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return isPlainObject(parsed) && parsed.run_id && parsed.job_id
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/**
 * Record that a handed-off run's outcome is still pending. Never throws: a
 * marker that cannot be written leaves the run at `started`, which is the
 * truthful state when nothing will observe its exit.
 */
export function recordPendingProviderRun(
  scope,
  {
    jobId,
    runId,
    startedAt = null,
    scheduledAt = null,
    handedOffAt,
    pid = null,
    pidStartTime = null,
    pgid = null,
    sessionId = null,
    logPaths = null,
    outcomeCwds = [],
  },
) {
  if (!jobId || !runId || !RUN_ID_PATTERN.test(runId)) {
    return { written: false };
  }
  const path = markerPath(scope, runId);
  const marker = {
    version: MARKER_VERSION,
    job_id: jobId,
    run_id: runId,
    started_at: startedAt,
    scheduled_at: scheduledAt,
    handed_off_at: handedOffAt,
    pid: Number.isInteger(pid) ? pid : null,
    pid_start_time: pidStartTime || null,
    pgid: Number.isInteger(pgid) ? pgid : null,
    session_id: sessionId || null,
    log_paths: logPaths || null,
    outcome_cwds: [...new Set([...outcomeCwds, scope.cwd].filter(Boolean))],
  };
  try {
    mkdirSync(pendingDir(scope), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(marker), "utf8");
    renameSync(tmp, path);
    return { written: true };
  } catch (err) {
    process.stderr.write(
      `[helm provider-outcome] pending marker write failed scope=${scope.scope_id || "unknown"} job=${jobId} run=${runId} error=${err?.message || String(err)}\n`,
    );
    return { written: false };
  }
}

function signalNameForExitCode(exitCode) {
  if (!Number.isInteger(exitCode) || exitCode <= 128) return null;
  const number = exitCode - 128;
  for (const [name, value] of Object.entries(osConstants.signals)) {
    if (value === number) return name;
  }
  return null;
}

// Map an observed exit to the reported outcome. A shell reports a child killed
// by signal N as exit 128+N, so the boundary record's code is read that way.
export function providerRunTerminal(outcome) {
  if (!outcome) {
    return {
      status: "failure",
      error: "exit_status_unrecorded",
      exitCode: null,
      signal: null,
    };
  }
  const exitCode = Number.isInteger(outcome.exit_code)
    ? outcome.exit_code
    : null;
  const signal =
    (typeof outcome.signal === "string" && outcome.signal) ||
    signalNameForExitCode(exitCode);
  if (signal) {
    return { status: "failure", error: `signal_${signal}`, exitCode, signal };
  }
  if (exitCode === 0) {
    return { status: "success", error: null, exitCode, signal: null };
  }
  return {
    status: "failure",
    error: exitCode === null ? "exit_status_unknown" : `exit_code_${exitCode}`,
    exitCode,
    signal: null,
  };
}

// last_status follows this run only while it is still the job's latest run: a
// newer run (handed off or skipped since) owns the job's last_* fields.
async function applyJobOutcome(scope, marker, terminal, finishedAt) {
  return mutateJobs(scope, `provider_outcome_${marker.run_id}`, (jobs) => {
    const job = jobs.find((candidate) => candidate.id === marker.job_id);
    if (!job?.state) return { applied: false, reason: "job_missing" };
    if (
      marker.handed_off_at &&
      job.state.last_run_at &&
      job.state.last_run_at !== marker.handed_off_at
    ) {
      return { applied: false, reason: "newer_run_recorded" };
    }
    job.state.last_run_at = finishedAt;
    job.state.last_status = terminal.status;
    job.state.last_error = terminal.error;
    job.state.last_failed_step = null;
    return { applied: true };
  });
}

/**
 * Finalize one handed-off run from its observed exit.
 *
 * @param {object} params
 * @param {object} params.scope
 * @param {string} params.runId
 * @param {object|null} params.outcome {exit_code, signal, finished_at} or null when unrecorded
 * @param {string} params.observedBy "dispatcher" | "sweep"
 * @param {string|null} [params.daemonInstanceId]
 * @param {object|null} [params.metadata] job metadata for history payloads
 * @returns {Promise<{finalized: boolean, reason?: string, status?: string}>}
 */
export async function finalizeProviderRunOutcome({
  scope,
  runId,
  outcome,
  observedBy,
  daemonInstanceId = null,
  metadata = null,
}) {
  if (!runId || !RUN_ID_PATTERN.test(runId)) {
    return { finalized: false, reason: "invalid_run_id" };
  }
  const path = markerPath(scope, runId);
  if (!existsSync(path)) return { finalized: false, reason: "not_pending" };
  if (!claim(path)) return { finalized: false, reason: "already_claimed" };
  const marker = readMarker(path);
  if (!marker) {
    releaseClaim(path);
    return { finalized: false, reason: "marker_unreadable" };
  }

  const finishedAt = outcome?.finished_at || nowIso();
  const terminal = providerRunTerminal(outcome);
  let jobUpdate;
  try {
    jobUpdate = await applyJobOutcome(scope, marker, terminal, finishedAt);
  } catch (err) {
    jobUpdate = { ok: false, details: { error: err?.message || String(err) } };
  }
  if (!jobUpdate?.ok) {
    // Leave the marker for the next observer so history and last_status
    // never disagree.
    releaseClaim(path);
    process.stderr.write(
      `[helm provider-outcome] job update deferred scope=${scope.scope_id || "unknown"} job=${marker.job_id} run=${runId} observed_by=${observedBy} details=${JSON.stringify(jobUpdate?.details || null)}\n`,
    );
    return { finalized: false, reason: "job_update_deferred" };
  }

  const startedAt = marker.started_at || null;
  const durationMs =
    startedAt && Number.isFinite(Date.parse(finishedAt))
      ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt))
      : null;
  const success = terminal.status === "success";
  const payload = {
    metadata: isPlainObject(metadata) ? metadata : {},
    log_paths: marker.log_paths || null,
    exit_code: terminal.exitCode,
    signal: terminal.signal,
    session_exit: true,
    observed_by: observedBy,
    last_status_applied: jobUpdate.value?.applied === true,
  };
  appendJobHistoryEvent(scope, marker.job_id, {
    id: `run_${runId}_session_exit`,
    ts: finishedAt,
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    job_id: marker.job_id,
    run_id: runId,
    kind: "completed",
    status: terminal.status,
    reason: success ? "process_exited" : terminal.error,
    scheduled_at: marker.scheduled_at || null,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: durationMs,
    error: terminal.error,
    exit_code: terminal.exitCode,
    signal: terminal.signal,
    session_id: marker.session_id || null,
    log_paths: marker.log_paths || null,
    payload,
  });
  appendActivityEvent({
    type: "job_run_session_finished",
    kind: "run",
    level: success ? "info" : "error",
    daemon_instance_id: daemonInstanceId,
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    job_id: marker.job_id,
    run_id: runId,
    status: terminal.status,
    reason: success ? "process_exited" : terminal.error,
    scheduled_at: marker.scheduled_at || null,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: durationMs,
    pid: marker.pid,
    error: terminal.error,
    data: payload,
  });
  process.stderr.write(
    `[helm provider-outcome] finalized scope=${scope.scope_id || "unknown"} job=${marker.job_id} run=${runId} status=${terminal.status} exit_code=${terminal.exitCode ?? "none"} signal=${terminal.signal || "none"} last_status_applied=${payload.last_status_applied} observed_by=${observedBy}\n`,
  );
  try {
    rmSync(path, { force: true });
  } catch {
    /* a leftover marker is harmless: it no longer has a claimable outcome */
  }
  releaseClaim(path);
  return { finalized: true, status: terminal.status };
}

function groupAlive(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function recordedOutcome(marker) {
  for (const cwd of marker.outcome_cwds || []) {
    const state = readRunSessionOutcomeState({
      cwd,
      jobId: marker.job_id,
      runId: marker.run_id,
    });
    if (state.kind === "valid") return state.outcome;
  }
  return null;
}

/**
 * Daemon-tick pass: finalize every pending run whose session has ended.
 * Sessions still running are left alone.
 */
export async function sweepProviderRunOutcomes(
  scope,
  { daemonInstanceId = null, metadataFor = () => null } = {},
) {
  const dir = pendingDir(scope);
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return { finalized: 0 };
  }
  let finalized = 0;
  for (const name of names) {
    const marker = readMarker(join(dir, name));
    if (!marker) continue;
    let outcome = recordedOutcome(marker);
    if (!outcome) {
      const pidAlive = Number.isInteger(marker.pid)
        ? isSameProcessAlive(marker.pid, marker.pid_start_time || null)
        : false;
      if (pidAlive || groupAlive(marker.pgid)) continue;
      // Re-read: the boundary wrapper writes its record just before exiting.
      // Still nothing once the whole process group is gone: the run is lost
      // (SIGKILL, machine sleep or crash) and is closed as unrecorded.
      outcome = recordedOutcome(marker);
    }
    // eslint-disable-next-line no-await-in-loop -- one marker at a time keeps job writes ordered
    const closed = await finalizeProviderRunOutcome({
      scope,
      runId: marker.run_id,
      outcome,
      observedBy: "sweep",
      daemonInstanceId,
      metadata: metadataFor(marker.job_id),
    });
    if (closed.finalized) finalized += 1;
  }
  return { finalized };
}
