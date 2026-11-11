import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { resolveNodeExecutable } from "./node_exec.mjs";
import {
  DEFAULT_TLDR_AGENT_CHILD_GRACE_MS,
  tldrAgentSlackClaimLease,
  tldrAgentSlackPostTimeout,
} from "./tldr_agent_daemon_phase_timeouts.mjs";
import { appendActivityEvent } from "./tldr_agent_diagnostics.mjs";
import { createTightbeamSlackChannel } from "./tightbeam_slack_channel.mjs";
import {
  createTightbeamSlackAdapter,
  stderrLogger,
} from "./tightbeam_slack_adapter.mjs";
import { slackCredentialsPath } from "./slack_credentials.mjs";
import { outboundLogger } from "./slack_outbound_diagnostics.mjs";
import { createSlackInboundLane } from "./slack_inbound.mjs";
import { sweepWorking } from "./slack_working_sweep.mjs";

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
  return setTimeout(() => {
    current.kill("SIGKILL");
    log({ event: "slack_listener_killed", status: "warn" });
  }, graceMs);
}

// A listener that stayed up for a full backoff window starts the ladder over.
function nextFailureCount(failures, upMs, maxBackoffMs) {
  return (upMs > maxBackoffMs ? 0 : failures) + 1;
}

// running is the live child's credentials identity, or null.
function listenerState({ identity, stopping, running, waiting }) {
  if (!identity) return "idle";
  let state = waiting ? "backoff" : "started";
  if (running) state = identity === running ? "running" : "replace";
  if (stopping) state = "stopping";
  return state;
}

// Keeps at most one slack_socket_listener child alive; sync() is called once per daemon tick
// with the credentials file identity (null when absent). The listener reads credentials only
// at start, so a changed identity stops it and the next tick after its exit starts a new one.
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
  let childIdentity = null;

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

  const stop = (reason = "shutdown") => {
    failures = 0;
    nextStartAt = 0;
    if (child && !stopping) {
      stopping = true;
      log({
        event: "slack_listener_stopped",
        status: "info",
        result: { cause: reason },
      });
      killTimer = terminate(child, killGraceMs, log);
    }
  };

  const start = (identity) => {
    const current = spawnChild(resolveNodeExecutable(), [listenerPath], {
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, TLDR_AGENT_HOME: home },
    });
    child = current;
    childIdentity = identity;
    startedAt = now();
    current.on("error", (error) => onGone(current, { error: error?.message }));
    current.on("exit", (code, signal) => onGone(current, { code, signal }));
    log({
      event: "slack_listener_started",
      status: "info",
      result: { pid: current.pid ?? null },
    });
  };

  function sync(identity) {
    const state = listenerState({
      identity,
      stopping,
      running: child && childIdentity,
      // New credentials skip a crash backoff earned by the old ones.
      waiting: now() < nextStartAt && identity === childIdentity,
    });
    const actions = {
      idle: () => stop("removed"),
      replace: () => stop("credentials_changed"),
      started: () => start(identity),
    };
    actions[state]?.();
    return state === "replace" ? "stopping" : state;
  }

  return { sync, stop: () => stop() };
}

// null when absent. Setup writes temp+rename, so each write gets a new inode;
// health notes live in home/slack/health and never touch this file.
export function slackCredentialsIdentity(home) {
  try {
    const { ino, size, mtimeMs } = statSync(slackCredentialsPath({ home }));
    return `${ino}:${size}:${mtimeMs}`;
  } catch {
    return null;
  }
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
        ? { error: error?.message || String(error), ...error?.timings }
        : {
            code: result?.code ?? null,
            cause:
              result?.abort_cause ?? (result?.cache_reset && "cache_reset"),
            ...result?.timings,
          },
    },
    { home },
  );
}

// One outbound channel per daemon process and credentials file, so the owner and route it
// resolved are reused by later ticks (ac-jfv.97). New credentials (a Slack re-setup) get a new one.
let outboundChannel = null;
export function slackOutboundChannel(home) {
  const key = `${home}\0${slackCredentialsIdentity(home)}`;
  if (outboundChannel?.key !== key)
    outboundChannel = { key, channel: createTightbeamSlackChannel({ home }) };
  return outboundChannel.channel;
}

// One ordered pass of the named steps; independent failures: one slack lane never
// blocks another, nor email.
async function runSteps({ home, daemonInstanceId, steps }) {
  for (const [lane, run] of Object.entries(steps)) {
    try {
      // eslint-disable-next-line no-await-in-loop -- the steps of one slack phase run in order.
      const result = await run();
      recordLaneResult({ home, lane, daemonInstanceId, result });
    } catch (error) {
      recordLaneResult({ home, lane, daemonInstanceId, error });
    }
  }
}

// The tick has its own deadline (postTimeoutMs, started once the claim is in hand), not the
// daemon phase's signal: that signal is the shared 35 s limit, and it cut off posts Slack
// already held (ac-jfv.59). The phase budgets claim + deadline + look + settle; an overrun only
// frees the lane, and the tick runs on under its own deadline inside its lease.
export function runSlackOutboundOnce({
  home,
  daemonInstanceId,
  postTimeoutMs,
  channel = slackOutboundChannel(home),
  fetchImpl,
}) {
  const timeoutMs = tldrAgentSlackPostTimeout({ postTimeoutMs });
  return runSteps({
    home,
    daemonInstanceId,
    steps: {
      slack_outbound: () =>
        createTightbeamSlackAdapter({
          channel,
          home,
          fetchImpl,
          logger: outboundLogger(home),
          postTimeoutMs: timeoutMs,
          leaseMs: tldrAgentSlackClaimLease(timeoutMs),
        }).deliverOnce(),
    },
  });
}

// Inbound on its own lane and phase: a slow or aborted outbound send cannot use up
// its budget and retry the waiting inbox lines (ac-jfv.74).
export function runSlackInboundOnce({ home, daemonInstanceId, signal }) {
  const channel = createTightbeamSlackChannel({ home });
  return runSteps({
    home,
    daemonInstanceId,
    steps: {
      slack_inbound: () =>
        createSlackInboundLane({
          channel,
          home,
          signal,
          logger: stderrLogger,
        }).drainOnce(),
    },
  });
}

// The working sweep, on its own lane and phase: slow outbound or inbound work cannot
// use up its budget, and a slow sweep cannot use up theirs.
export function runSlackWorkingOnce({ home, daemonInstanceId, signal }) {
  const channel = createTightbeamSlackChannel({ home });
  return runSteps({
    home,
    daemonInstanceId,
    steps: {
      slack_working: () =>
        sweepWorking({ channel, home, signal, logger: stderrLogger }),
    },
  });
}

async function slackTickOnce({
  home,
  once,
  daemonInstanceId,
  slackListener,
  runSlackTick,
  runPhase,
  phaseTimeoutMs,
  postTimeoutMs,
  phaseName,
  superviseListener,
}) {
  const identity = slackCredentialsIdentity(home);
  const present = identity !== null;
  try {
    // A --once run is short-lived and must not leave a socket child behind.
    if (!once && superviseListener) slackListener.sync(identity);
    if (present) {
      const phase = await runPhase(
        phaseName,
        ({ signal }) =>
          runSlackTick({ home, daemonInstanceId, signal, postTimeoutMs }),
        phaseTimeoutMs,
      );
      if (!phase.ok)
        process.stderr.write(`tldr daemon ${phaseName}: ${phase.error}\n`);
    }
  } catch (error) {
    process.stderr.write(
      `tldr daemon ${phaseName} lane failed: ${error?.message || error}\n`,
    );
  }
}

// Returns a slack lane (outbound, inbound, or the working sweep); the loop supplies
// its own cadence and stop state. Only the inbound lane supervises the listener:
// its phase stays short, while an outbound tick can hold its lane for minutes (ac-jfv.59).
export function createSlackLane({
  once,
  isStopped,
  homeExists,
  home,
  sleepInterval,
  phaseName,
  superviseListener = false,
  ...tick
}) {
  return async () => {
    do {
      // Yield a macrotask so an instant waitFn can never starve the other lanes.
      // eslint-disable-next-line no-await-in-loop -- once per slack tick.
      await new Promise((resolveYield) => setImmediate(resolveYield));
      // eslint-disable-next-line no-await-in-loop -- one slack tick per cadence.
      await slackTickOnce({
        home,
        once,
        phaseName,
        superviseListener,
        ...tick,
      });
      if (!once && !isStopped()) {
        // eslint-disable-next-line no-await-in-loop -- the next tick starts only after the configured cadence.
        await sleepInterval();
      }
    } while (!once && !isStopped() && homeExists(home));
  };
}
