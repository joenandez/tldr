import { appendActivityEvent } from "./tldr_agent_diagnostics.mjs";
import { isProcessAlive } from "./process_liveness.mjs";

const ALIVE_IDLE_TERMINATE_GRACE_MS = 1000;
const ALIVE_IDLE_TERMINATE_POLL_MS = 25;

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function terminateAliveIdlePid({
  scope,
  messageId,
  sessionId,
  pid,
  source,
  graceMs = ALIVE_IDLE_TERMINATE_GRACE_MS,
} = {}) {
  const numericPid = Number(pid);
  const baseData = {
    message_id: messageId,
    session_id: sessionId,
    pid: Number.isFinite(numericPid) ? numericPid : null,
    live_pid_source: source || null,
    log_prefix: "[🪳 TEMP ALIVE_IDLE_REVIVE]",
  };
  if (!Number.isFinite(numericPid) || numericPid <= 1) {
    return { ok: false, error: "invalid_pid" };
  }
  if (numericPid === process.pid) {
    return { ok: false, error: "refuse_self_terminate" };
  }

  appendActivityEvent({
    type: "alive_idle_revive_pid_terminate",
    level: "warn",
    scope_id: scope?.scope_id ?? null,
    cwd: scope?.cwd ?? null,
    data: {
      ...baseData,
      signal: "SIGTERM",
      message:
        "[🪳 TEMP ALIVE_IDLE_REVIVE] terminating idle live PID before resume",
    },
  });

  try {
    process.kill(numericPid, "SIGTERM");
  } catch (err) {
    if (err?.code === "ESRCH") {
      return { ok: true, pid: numericPid, signal: null, already_dead: true };
    }
    return {
      ok: false,
      error: "sigterm_failed",
      hint: err?.message || String(err),
    };
  }

  const deadline = Date.now() + Math.max(0, Number(graceMs) || 0);
  while (Date.now() <= deadline) {
    if (!isProcessAlive(numericPid)) {
      return { ok: true, pid: numericPid, signal: "SIGTERM" };
    }
    // eslint-disable-next-line no-await-in-loop -- bounded liveness poll after SIGTERM.
    await sleepMs(ALIVE_IDLE_TERMINATE_POLL_MS);
  }

  appendActivityEvent({
    type: "alive_idle_revive_pid_terminate",
    level: "warn",
    scope_id: scope?.scope_id ?? null,
    cwd: scope?.cwd ?? null,
    data: {
      ...baseData,
      signal: "SIGKILL",
      message:
        "[🪳 TEMP ALIVE_IDLE_REVIVE] escalating idle live PID termination before resume",
    },
  });

  try {
    process.kill(numericPid, "SIGKILL");
  } catch (err) {
    if (err?.code === "ESRCH") {
      return { ok: true, pid: numericPid, signal: "SIGTERM" };
    }
    return {
      ok: false,
      error: "sigkill_failed",
      hint: err?.message || String(err),
    };
  }
  const killDeadline = Date.now() + Math.max(100, ALIVE_IDLE_TERMINATE_POLL_MS);
  while (Date.now() <= killDeadline) {
    if (!isProcessAlive(numericPid)) {
      return { ok: true, pid: numericPid, signal: "SIGKILL" };
    }
    // eslint-disable-next-line no-await-in-loop -- bounded liveness poll after SIGKILL.
    await sleepMs(ALIVE_IDLE_TERMINATE_POLL_MS);
  }
  return { ok: false, error: "pid_still_alive_after_sigkill" };
}
