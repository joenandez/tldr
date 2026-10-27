import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveNodeExecutable } from "./node_exec.mjs";
import { DEFAULT_TLDR_AGENT_CHILD_GRACE_MS } from "./tldr_agent_daemon_phase_timeouts.mjs";
import { appendActivityEvent } from "./tldr_agent_diagnostics.mjs";
import { createTightbeamSlackChannel } from "./tightbeam_slack_channel.mjs";
import {
  createTightbeamSlackAdapter,
  stderrLogger,
} from "./tightbeam_slack_adapter.mjs";
import { createSlackInboundLane } from "./slack_inbound.mjs";

const SLACK_LISTENER_PATH = fileURLToPath(
  new URL("./slack_socket_listener.mjs", import.meta.url),
);

function logListenerEvent(home, entry) {
  appendActivityEvent(
    {
      event_type: `daemon_${entry.event}`,
      metadata: { status: entry.status, ...entry.result },
    },
    { home },
  );
}

// SIGTERM now, SIGKILL after the grace unless the exit clears the timer first.
// Not unref'd: daemon shutdown waits for the exit or the SIGKILL, never an orphan.
function terminate(current, graceMs, log) {
  current.kill("SIGTERM");
  log({ event: "slack_listener_stopped", status: "info" });
  return setTimeout(() => {
    current.kill("SIGKILL");
    log({ event: "slack_listener_killed", status: "warn" });
  }, graceMs);
}

// A listener that stayed up for a full backoff window starts the ladder over.
function nextFailureCount(failures, upMs, maxBackoffMs) {
  return (upMs > maxBackoffMs ? 0 : failures) + 1;
}

// Keeps at most one slack_socket_listener child alive; sync() is called once per daemon tick.
// A stopped child stays tracked until its exit, so no replacement overlaps it (AC-18).
export function createSlackListenerSupervisor({
  home,
  spawnChild = spawn,
  listenerPath = SLACK_LISTENER_PATH,
  now = Date.now,
  baseBackoffMs = 1000,
  maxBackoffMs = 60000,
  killGraceMs = DEFAULT_TLDR_AGENT_CHILD_GRACE_MS,
  log = (entry) => logListenerEvent(home, entry),
} = {}) {
  let child = null;
  let stopping = false;
  let killTimer = null;
  let failures = 0;
  let nextStartAt = 0;
  let startedAt = 0;

  const scheduleRestart = (result) => {
    failures = nextFailureCount(failures, now() - startedAt, maxBackoffMs);
    const delayMs = Math.min(baseBackoffMs * 2 ** (failures - 1), maxBackoffMs);
    nextStartAt = now() + delayMs;
    log({
      event: "slack_listener_exited",
      status: "warn",
      result: { ...result, restart_in_ms: delayMs },
    });
  };

  const onGone = (current, result) => {
    if (child !== current) return;
    child = null;
    clearTimeout(killTimer);
    if (stopping) stopping = false;
    else scheduleRestart(result);
  };

  const stop = () => {
    failures = 0;
    nextStartAt = 0;
    if (child && !stopping) {
      stopping = true;
      killTimer = terminate(child, killGraceMs, log);
    }
  };

  const start = () => {
    const current = spawnChild(resolveNodeExecutable(), [listenerPath], {
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, TLDR_AGENT_HOME: home },
    });
    child = current;
    startedAt = now();
    current.on("error", (error) => onGone(current, { error: error?.message }));
    current.on("exit", (code, signal) => onGone(current, { code, signal }));
    log({
      event: "slack_listener_started",
      status: "info",
      result: { pid: current.pid ?? null },
    });
  };

  function sync(credentialsPresent) {
    let state = "started";
    if (!credentialsPresent) {
      stop();
      state = "idle";
    } else if (stopping) {
      state = "stopping";
    } else if (child) {
      state = "running";
    } else if (now() < nextStartAt) {
      state = "backoff";
    } else {
      start();
    }
    return state;
  }

  return { sync, stop };
}

function slackCredentialsExist(home) {
  return existsSync(join(home, "credentials", "slack.json"));
}

// A completed-failed or released delivery must never read as ok in diagnostics.
function resultStatus(result) {
  // An idle tick (nothing to claim) is a success, not a retry.
  if (result?.ok !== false || result.code === "claim_unavailable") {
    return "success";
  }
  if (result.released || result.retryable) return "released";
  // backoff, abort or inbound not ready: try again next tick.
  return result.error ? "failed" : "retry";
}

export function recordLaneResult({
  home,
  lane,
  daemonInstanceId,
  error,
  result,
}) {
  if (error) {
    process.stderr.write(
      `tldr daemon ${lane} failed: ${error?.message || error}\n`,
    );
  }
  appendActivityEvent(
    {
      event_type: `daemon_${lane}_tick${error ? "_failed" : ""}`,
      daemon_instance_id: daemonInstanceId,
      status: error ? "error" : resultStatus(result),
      result: { slack_error: result?.error, http_status: result?.http_status },
      metadata: error
        ? { error: error?.message || String(error) }
        : { code: result?.code ?? null },
    },
    { home },
  );
}

// signal is the daemon phase's abort signal; Slack calls stop when it fires.
export async function runSlackLanesOnce({ home, daemonInstanceId, signal }) {
  const channel = createTightbeamSlackChannel({ home });
  const steps = {
    slack_outbound: () =>
      createTightbeamSlackAdapter({ channel, home, signal }).deliverOnce(),
    slack_inbound: () =>
      createSlackInboundLane({
        channel,
        home,
        signal,
        logger: stderrLogger,
      }).drainOnce(),
  };
  // Independent failures: one slack lane never blocks the other, nor email.
  for (const [lane, run] of Object.entries(steps)) {
    try {
      // eslint-disable-next-line no-await-in-loop -- outbound then inbound, one ordered slack tick.
      const result = await run();
      recordLaneResult({ home, lane, daemonInstanceId, result });
    } catch (error) {
      recordLaneResult({ home, lane, daemonInstanceId, error });
    }
  }
}

async function slackTickOnce({
  home,
  once,
  daemonInstanceId,
  slackListener,
  runSlackTick,
  runPhase,
  phaseTimeoutMs,
}) {
  const present = slackCredentialsExist(home);
  try {
    // A --once run is short-lived and must not leave a socket child behind.
    if (!once) slackListener.sync(present);
    if (present) {
      const phase = await runPhase(
        "slack_tick",
        ({ signal }) => runSlackTick({ home, daemonInstanceId, signal }),
        phaseTimeoutMs,
      );
      if (!phase.ok)
        process.stderr.write(`tldr daemon slack tick: ${phase.error}\n`);
    }
  } catch (error) {
    process.stderr.write(
      `tldr daemon slack lane failed: ${error?.message || error}\n`,
    );
  }
}

// Returns the daemon's third lane; the loop supplies its own cadence and stop state.
export function createSlackLane({
  once,
  isStopped,
  homeExists,
  home,
  sleepInterval,
  ...tick
}) {
  return async () => {
    do {
      // Yield a macrotask so an instant waitFn can never starve the other lanes.
      // eslint-disable-next-line no-await-in-loop -- once per slack tick.
      await new Promise((resolveYield) => setImmediate(resolveYield));
      // eslint-disable-next-line no-await-in-loop -- one slack tick per cadence.
      await slackTickOnce({ home, once, ...tick });
      if (!once && !isStopped()) {
        // eslint-disable-next-line no-await-in-loop -- the next tick starts only after the configured cadence.
        await sleepInterval();
      }
    } while (!once && !isStopped() && homeExists(home));
  };
}
