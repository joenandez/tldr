import { appendActivityEvent } from "./activity_stream.mjs";
import { helmHome } from "./store.mjs";
import {
  initializeRuntimeStore,
  withRuntimeStoreTransaction,
} from "./runtime_store.mjs";

const TERMINAL_STATES = new Set([
  "succeeded",
  "failed",
  "timed_out",
  "lost",
  "cancelled",
]);

const TRANSITIONS = Object.freeze({
  due: new Set(["claimed", "cancelled", "lost"]),
  claimed: new Set(["launching", "running", "cancelled", "lost"]),
  launching: new Set(["running", "failed", "timed_out", "lost", "cancelled"]),
  running: new Set(["succeeded", "failed", "timed_out", "lost", "cancelled"]),
  succeeded: new Set(),
  failed: new Set(),
  timed_out: new Set(),
  lost: new Set(),
  cancelled: new Set(),
});

function required(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function nowIso() {
  return new Date().toISOString();
}

function withStore(home, fn) {
  const store = initializeRuntimeStore({ home });
  try {
    return fn(store.db);
  } finally {
    store.close();
  }
}

function normalizeState(state, name = "state") {
  const normalized = required(state, name);
  if (!Object.hasOwn(TRANSITIONS, normalized)) {
    throw new TypeError(`unsupported Skyhook state: ${normalized}`);
  }
  return normalized;
}

function assertTransition(fromState, toState) {
  const from = normalizeState(fromState, "fromState");
  const to = normalizeState(toState, "toState");
  if (!TRANSITIONS[from].has(to)) {
    throw new Error(`illegal_skyhook_transition:${from}->${to}`);
  }
}

function legacyStatus(state) {
  if (state === "due") return "pending";
  if (state === "launching") return "claimed";
  if (state === "lost" || state === "cancelled") return "failed";
  return state;
}

function legacyAttemptStatus(state) {
  if (state === "due" || state === "launching") return "claimed";
  if (state === "lost" || state === "cancelled") return "failed";
  return state;
}

function publicStatus(state) {
  if (state === "succeeded") return "success";
  if (state === "timed_out") return "timeout";
  if (state === "cancelled") return "cancelled";
  if (state === "lost" || state === "failed") return "failure";
  return state;
}

function durationMs(startIso, endIso) {
  const start = Date.parse(startIso || "");
  const end = Date.parse(endIso || "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

export function listSkyhookTerminalHistoryEvents({
  home = helmHome(),
  scopeId,
  jobId,
  limit = 20,
} = {}) {
  const normalizedLimit = Math.max(1, Number(limit) || 20);
  return withStore(home, (db) =>
    db
      .prepare(
        `SELECT a.attempt_id, COALESCE(a.state, a.status) AS state, a.started_at AS attempt_started_at, a.finished_at AS attempt_finished_at, a.exited_at, a.exit_code, a.terminal_reason, a.terminal_source, a.identity_key, a.signal_source, a.startup_window_ms, l.scope_id, l.source_scope_id, l.source_cwd, l.job_id, l.scheduled_at, l.started_at AS logical_started_at, l.finished_at AS logical_finished_at, l.exited_at AS logical_exited_at FROM run_attempts a JOIN logical_runs l ON l.logical_run_key = a.logical_run_key WHERE l.scope_id = ? AND l.job_id = ? AND COALESCE(a.state, a.status) IN ('succeeded', 'failed', 'timed_out', 'lost', 'cancelled') ORDER BY COALESCE(a.exited_at, a.finished_at, l.exited_at, l.finished_at, a.started_at) DESC LIMIT ?`,
      )
      .all(
        required(scopeId, "scopeId"),
        required(jobId, "jobId"),
        normalizedLimit,
      )
      .reverse()
      .map((row) => {
        const finishedAt =
          row.exited_at ||
          row.attempt_finished_at ||
          row.logical_exited_at ||
          row.logical_finished_at ||
          row.attempt_started_at ||
          null;
        const startedAt =
          row.attempt_started_at || row.logical_started_at || null;
        return {
          id: `run_${row.attempt_id}_ledger_terminal`,
          ts: finishedAt,
          scope_id: row.scope_id,
          source_scope_id: row.source_scope_id,
          source_cwd: row.source_cwd,
          cwd: null,
          job_id: row.job_id,
          run_id: row.attempt_id,
          kind: "completed",
          status: publicStatus(row.state),
          reason: row.terminal_reason || row.state,
          scheduled_at: row.scheduled_at,
          started_at: startedAt,
          finished_at: finishedAt,
          duration_ms: durationMs(startedAt, finishedAt),
          error:
            row.state === "succeeded"
              ? null
              : row.terminal_reason || row.state || "skyhook_terminal",
          log_paths: null,
          payload: {
            ledger: true,
            identity_key: row.identity_key || null,
            exit_code: row.exit_code ?? null,
            terminal_reason: row.terminal_reason || row.state,
            terminal_source: row.terminal_source || null,
            signal_source: row.signal_source || null,
            startup_window_ms: row.startup_window_ms ?? null,
          },
        };
      }),
  );
}

function appendLifecycleEvent({
  attempt,
  targetState,
  timestamp,
  terminalReason,
  terminalSource,
  signalSource,
  startupWindowMs,
  pid,
  pgid,
}) {
  const base = {
    timestamp,
    kind: "run",
    scope_id: attempt.scope_id || null,
    job_id: attempt.job_id || null,
    run_id: attempt.attempt_id,
    scheduled_at: attempt.scheduled_at || null,
    started_at: targetState === "launching" ? null : timestamp,
    pid: pid ?? attempt.pid ?? attempt.job_pid ?? null,
    source: terminalSource || "runtime_ledger",
    data: {
      identity_key: attempt.identity_key || null,
      job_kind: attempt.job_kind || null,
      pgid: pgid ?? attempt.pgid ?? attempt.process_group_id ?? null,
      signal_source: signalSource || null,
      startup_window_ms: startupWindowMs ?? null,
      skyhook: true,
    },
  };
  if (targetState === "launching" || targetState === "running") {
    appendActivityEvent({
      ...base,
      type:
        targetState === "launching" ? "job_run_launching" : "job_run_started",
      level: "info",
      status: targetState,
      reason: targetState === "launching" ? "launching" : "started",
    });
    if (targetState === "running") {
      appendActivityEvent({
        ...base,
        type: "job_run_identity_registered",
        level: "info",
        status: "running",
        reason: "identity_registered",
      });
    }
    return;
  }
  if (!TERMINAL_STATES.has(targetState)) return;
  appendActivityEvent({
    ...base,
    type: "job_run_terminal",
    level: targetState === "succeeded" ? "info" : "error",
    status: targetState,
    reason: terminalReason || targetState,
    finished_at: timestamp,
    error: targetState === "succeeded" ? null : terminalReason || targetState,
    data: {
      ...base.data,
      terminal_reason: terminalReason || targetState,
      terminal_source: terminalSource || "runtime_ledger",
    },
  });
}

export function transitionSkyhookAttempt({
  home = helmHome(),
  attemptId,
  toState,
  pid = undefined,
  pgid = undefined,
  startedAt = undefined,
  lastHeartbeatAt = undefined,
  deadlineAt = undefined,
  exitedAt = undefined,
  exitCode = undefined,
  terminalReason = undefined,
  terminalSource = undefined,
  signalSource = undefined,
  startupWindowMs = undefined,
  now = nowIso(),
} = {}) {
  const normalizedAttemptId = required(attemptId, "attemptId");
  const targetState = normalizeState(toState, "toState");
  const timestamp = required(now, "now");
  return withRuntimeStoreTransaction({ home }, (db) => {
    const attempt = db
      .prepare(
        "SELECT a.*, l.scope_id, l.job_id, l.scheduled_at FROM run_attempts a JOIN logical_runs l ON l.logical_run_key = a.logical_run_key WHERE a.attempt_id = ?",
      )
      .get(normalizedAttemptId);
    if (!attempt)
      throw new Error(`run attempt not found: ${normalizedAttemptId}`);
    const currentState = attempt.state || attempt.status;
    assertTransition(currentState, targetState);
    const terminal = TERMINAL_STATES.has(targetState);
    const effectiveStartedAt =
      startedAt !== undefined
        ? startedAt
        : targetState === "running"
          ? timestamp
          : undefined;
    const effectiveLastHeartbeatAt =
      lastHeartbeatAt !== undefined
        ? lastHeartbeatAt
        : targetState === "running"
          ? timestamp
          : undefined;
    const effectiveExitedAt =
      exitedAt !== undefined ? exitedAt : terminal ? timestamp : undefined;
    db.prepare(
      `UPDATE run_attempts SET state = ?, status = ?, wrapper_state = CASE WHEN ? THEN 'finalized' WHEN ? = 'launching' THEN 'spawned' WHEN ? = 'running' THEN 'post_exec' ELSE wrapper_state END, pid = COALESCE(?, pid), pgid = COALESCE(?, pgid), job_pid = COALESCE(?, job_pid), process_group_id = COALESCE(?, process_group_id), started_at = COALESCE(?, started_at), last_heartbeat_at = COALESCE(?, last_heartbeat_at), deadline_at = COALESCE(?, deadline_at), finished_at = COALESCE(?, finished_at), exited_at = COALESCE(?, exited_at), exit_code = COALESCE(?, exit_code), terminal_reason = COALESCE(?, terminal_reason), terminal_source = COALESCE(?, terminal_source), signal_source = COALESCE(?, signal_source), startup_window_ms = COALESCE(?, startup_window_ms) WHERE attempt_id = ?`,
    ).run(
      targetState,
      legacyAttemptStatus(targetState),
      terminal ? 1 : 0,
      targetState,
      targetState,
      pid === undefined ? null : pid,
      pgid === undefined ? null : pgid,
      pid === undefined ? null : pid,
      pgid === undefined ? null : pgid,
      effectiveStartedAt === undefined ? null : effectiveStartedAt,
      effectiveLastHeartbeatAt === undefined ? null : effectiveLastHeartbeatAt,
      deadlineAt === undefined ? null : deadlineAt,
      effectiveExitedAt === undefined ? null : effectiveExitedAt,
      effectiveExitedAt === undefined ? null : effectiveExitedAt,
      exitCode === undefined ? null : exitCode,
      terminalReason === undefined ? null : terminalReason,
      terminalSource === undefined ? null : terminalSource,
      signalSource === undefined ? null : signalSource,
      startupWindowMs === undefined ? null : startupWindowMs,
      normalizedAttemptId,
    );
    db.prepare(
      `UPDATE logical_runs SET state = ?, status = ?, updated_at = ?, started_at = COALESCE(?, started_at), last_heartbeat_at = COALESCE(?, last_heartbeat_at), deadline_at = COALESCE(?, deadline_at), finished_at = COALESCE(?, finished_at), exited_at = COALESCE(?, exited_at), exit_code = COALESCE(?, exit_code), terminal_reason = COALESCE(?, terminal_reason), terminal_source = COALESCE(?, terminal_source), status_reason = COALESCE(?, status_reason) WHERE logical_run_key = ?`,
    ).run(
      targetState,
      legacyStatus(targetState),
      timestamp,
      effectiveStartedAt === undefined ? null : effectiveStartedAt,
      effectiveLastHeartbeatAt === undefined ? null : effectiveLastHeartbeatAt,
      deadlineAt === undefined ? null : deadlineAt,
      effectiveExitedAt === undefined ? null : effectiveExitedAt,
      effectiveExitedAt === undefined ? null : effectiveExitedAt,
      exitCode === undefined ? null : exitCode,
      terminalReason === undefined ? null : terminalReason,
      terminalSource === undefined ? null : terminalSource,
      terminalReason === undefined ? null : terminalReason,
      attempt.logical_run_key,
    );
    appendLifecycleEvent({
      attempt,
      targetState,
      timestamp,
      terminalReason,
      terminalSource,
      signalSource,
      startupWindowMs,
      pid,
      pgid,
    });
    return {
      transitioned: true,
      attempt_id: normalizedAttemptId,
      from_state: currentState,
      state: targetState,
    };
  });
}

export function releaseSkyhookIdentity({
  home = helmHome(),
  attemptId,
  state = "succeeded",
  reason = "released",
  now = nowIso(),
} = {}) {
  return transitionSkyhookAttempt({
    home,
    attemptId,
    toState: state,
    terminalReason: reason,
    terminalSource: "supervisor",
    now,
  });
}
