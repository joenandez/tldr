import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolveNodeExecutable } from "./node_exec.mjs";
import { TLDR_AGENT_EMAIL_NOTICE } from "./tldr_agent_daemon_phase_timeouts.mjs";

const CHILD_PATH = fileURLToPath(
  new URL("./email_notice_child.mjs", import.meta.url),
);

// The whole process group: the child and every CLI call it started. Forked detached, the child is
// its own group leader. ESRCH (nothing left) is the normal answer after a clean exit.
function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    // nothing left in the group
  }
}

const replyOf = (message) =>
  message.type === "result"
    ? { ok: true, outbound: message.outbound }
    : {
        ok: false,
        error: "child_error",
        code: message.code,
        message: message.message,
      };

// A child that stayed up for a full backoff window starts the ladder over.
const nextFailures = (failures, upMs, restartMaxMs) =>
  (upMs > restartMaxMs ? 0 : failures) + 1;
const restartDelay = (failures, restartBaseMs, restartMaxMs) =>
  Math.min(restartBaseMs * 2 ** (failures - 1), restartMaxMs);

// Why a request cannot go to a child now, or null: stopped, or a restart is not due yet.
function refusalOf(stopping, child, untilStartMs) {
  if (stopping) return { ok: false, error: "stopped" };
  if (!child && untilStartMs > 0)
    return { ok: false, error: "child_backoff", retry_in_ms: untilStartMs };
  return null;
}

// The one request in flight. A settled id is ignored, so a late reply, a timeout and an exit
// race to one result.
function createSlot() {
  let pending = null;
  let seq = 0;
  const settle = (id, result) => {
    if (pending?.id !== id) return;
    const { resolve, timer } = pending;
    pending = null;
    clearTimeout(timer);
    resolve(result);
  };
  return {
    settleReply: (id, result) => settle(id, result),
    settleCurrent: (result) => pending && settle(pending.id, result),
    isOpen: (id) => id !== undefined && id === pending?.id,
    open: (timeoutMs, onTimeout, send) =>
      new Promise((resolve) => {
        const id = (seq += 1);
        const timer = setTimeout(() => {
          settle(id, { ok: false, error: "child_timeout" });
          onTimeout();
        }, timeoutMs);
        pending = { id, resolve, timer };
        send(id, (error) => {
          if (error) settle(id, { ok: false, error: "child_exited" });
        });
      }),
  };
}

function spawnChild(childPath, env) {
  return fork(childPath, [], {
    execPath: resolveNodeExecutable(),
    detached: true,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    env: { ...process.env, HELM_DAEMON: "1", ...env },
  });
}

// The warm child of the email notice lane (ac-jfv.74.1): started on the first request, kept for
// every later one, restarted after a crash or a timeout with backoff, and killed with its process
// group by stop() (daemon stop). One request at a time: the lane is one tick at a time.
// request({ wake, timeoutMs }) resolves { ok: true, outbound } or { ok: false, error } where error
// is child_exited, child_timeout, child_backoff (a restart is not due yet), child_error, or
// stopped. A request that times out kills the child's group: a wedged child holds no lease past it
// (a send it cut is safe: the claim is released or re-offered, and the provider key stops a second
// send).
export function createWarmNoticeChild({
  childPath = CHILD_PATH,
  env = {},
  restartBaseMs = TLDR_AGENT_EMAIL_NOTICE.restartBaseMs,
  restartMaxMs = TLDR_AGENT_EMAIL_NOTICE.restartMaxMs,
  graceMs = TLDR_AGENT_EMAIL_NOTICE.graceMs,
  now = Date.now,
  log = () => {},
} = {}) {
  let child = null;
  const slot = createSlot();
  let exited = null; // resolves when the live child has exited
  let failures = 0;
  let nextStartAt = 0;
  let startedAt = 0;
  let stopping = false;

  const onGone = (current, resolveExit, info) => {
    killGroup(current.pid, "SIGKILL"); // sweep what a crashed child's CLI calls left
    if (child === current) child = null;
    resolveExit();
    slot.settleCurrent({ ok: false, error: "child_exited" });
    if (!stopping) scheduleRestart(info);
  };

  const scheduleRestart = (info) => {
    failures = nextFailures(failures, now() - startedAt, restartMaxMs);
    const delayMs = restartDelay(failures, restartBaseMs, restartMaxMs);
    nextStartAt = now() + delayMs;
    log({
      event: "email_notice_child_exited",
      ...info,
      restart_in_ms: delayMs,
    });
  };

  const start = () => {
    const current = spawnChild(childPath, env);
    child = current;
    startedAt = now();
    exited = new Promise((resolveExit) => {
      current.once("exit", (code, signal) =>
        onGone(current, resolveExit, { code, signal }),
      );
      current.once("error", (error) =>
        onGone(current, resolveExit, { error: error?.message }),
      );
    });
    current.on("message", (message) => {
      if (slot.isOpen(message?.id))
        slot.settleReply(message.id, replyOf(message));
    });
    log({ event: "email_notice_child_started", pid: current.pid });
    return current;
  };

  const dispatch = ({ wake, timeoutMs }, target = child ?? start()) =>
    slot.open(
      timeoutMs,
      () => killGroup(target.pid, "SIGKILL"),
      (id, done) => target.send({ type: "wake", id, wake }, done),
    );

  const request = (options) => {
    const refused = refusalOf(stopping, child, nextStartAt - now());
    return refused ? Promise.resolve(refused) : dispatch(options);
  };

  // SIGTERM to the group, SIGKILL after `graceMs`, and wait for the exit.
  async function terminate(current) {
    killGroup(current.pid, "SIGTERM");
    const hardStop = setTimeout(
      () => killGroup(current.pid, "SIGKILL"),
      graceMs,
    );
    try {
      await exited;
    } finally {
      clearTimeout(hardStop);
    }
  }

  async function stop() {
    stopping = true;
    const current = child;
    if (current) await terminate(current);
  }

  return { request, stop, pid: () => child?.pid ?? null };
}
