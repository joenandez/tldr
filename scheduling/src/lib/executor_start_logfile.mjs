// executor_start_logfile — launch an agent command that writes straight to its run log files.
//
// A Skyhook handoff returns while the session keeps running, and the process that launched it (the
// daemon's per-tick dispatch child, or the CLI for run-now) usually exits right after. Pipes owned by
// that process would close with it: later output (a post-handoff rate_limit_event) never reached the
// log and the session's next write died of SIGPIPE. Here the child owns the log fds, so every byte
// lands in logPaths whether the launcher lives or not; results read the files back (bounded).

import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  deriveMemoryAfterRun,
  spawnWrappedCommand,
} from "./process_wrapper.mjs";
import {
  createBoundedTextCapture,
  makeStdinFd,
  outputMetadata,
  positiveIntegerEnv,
  safeCloseFd,
} from "./executor_process_utils.mjs";

const DEFAULT_CAPTURE_BYTES = 64 * 1024;

function readLog(path) {
  try {
    return readFileSync(path);
  } catch {
    return Buffer.alloc(0);
  }
}

// shortcut: re-reads the whole log on each snapshot (taken only at start and at exit, never per chunk);
// HELM_LOG_MAX_BYTES no longer caps these logs, the codex launcher already behaves the same.
function captureLogs(logPaths, captureBytes) {
  const stdoutBytes = readLog(logPaths.stdout);
  const stderrBytes = readLog(logPaths.stderr);
  const stdout = createBoundedTextCapture(captureBytes);
  const stderr = createBoundedTextCapture(captureBytes);
  stdout.append(stdoutBytes);
  stderr.append(stderrBytes);
  // The child writes the files itself: they are never capped and record no write errors.
  const logState = {
    stdoutBytes: stdoutBytes.length,
    stderrBytes: stderrBytes.length,
    errors: [],
  };
  return {
    stdout: stdout.text(),
    stderr: stderr.text(),
    output: outputMetadata(stdout, stderr, { state: logState }),
  };
}

// Truncates the logs and spawns the child with them as its stdout/stderr fds.
function spawnIntoLogs({
  command,
  args,
  cwd,
  timeoutSec,
  stdinText,
  extraEnv,
  memoryMode,
  logPaths,
}) {
  mkdirSync(dirname(logPaths.stdout), { recursive: true });
  writeFileSync(logPaths.stdout, "", "utf8");
  writeFileSync(logPaths.stderr, "", "utf8");
  const stdinSpec = makeStdinFd(stdinText, logPaths);
  const stdoutFd = openSync(logPaths.stdout, "a");
  const stderrFd = openSync(logPaths.stderr, "a");
  try {
    return spawnWrappedCommand({
      command,
      args,
      cwd,
      env: { ...process.env, ...extraEnv },
      memoryMode,
      stdio: [stdinSpec.fd, stdoutFd, stderrFd],
      timeoutMs:
        Number.isFinite(timeoutSec) && timeoutSec > 0
          ? timeoutSec * 1000
          : null,
    });
  } finally {
    safeCloseFd(stdinSpec.fd);
    safeCloseFd(stdoutFd);
    safeCloseFd(stderrFd);
  }
}

// The first call resolves with build(payload); later calls do nothing (no snapshot either).
function settleOnce(resolve, build) {
  let settled = false;
  return (payload) => {
    if (settled) return;
    settled = true;
    resolve(build(payload));
  };
}

function exitBeforeStartPayload(code, signal, error) {
  return {
    status: code === 0 ? "started" : "failure",
    signal_source:
      code === 0
        ? "process_exit_zero_before_start"
        : "process_exit_before_start",
    error,
    exit_code: code,
    signal,
  };
}

function spawnInfo(child, wrapperEvidence, cwd) {
  return {
    pid: child.pid,
    pgid: wrapperEvidence.pgid || child.pid || null,
    command: wrapperEvidence.command,
    args: wrapperEvidence.args,
    cwd,
    wrapper: wrapperEvidence,
  };
}

/**
 * Same contract as launchCommandUntilStarted (executor_start_confirm.mjs): resolve `started` once the
 * child survives `startupWindowMs`, or with the exit if it ends first; `terminal` resolves at exit.
 * `logPaths` is required.
 */
export function launchLogFileCommandUntilStarted({
  command,
  args = [],
  cwd,
  timeoutSec = null,
  stdinText = null,
  extraEnv = {},
  memoryMode = null,
  onSpawn = null,
  logPaths,
  startupWindowMs = 250,
}) {
  const started = Date.now();
  const captureBytes = positiveIntegerEnv(
    "HELM_EXECUTOR_CAPTURE_BYTES",
    DEFAULT_CAPTURE_BYTES,
    extraEnv,
  );
  const { child, evidence: wrapperEvidence } = spawnIntoLogs({
    command,
    args,
    cwd,
    timeoutSec,
    stdinText,
    extraEnv,
    memoryMode,
    logPaths,
  });

  let startResolve;
  let terminalResolve;
  const startedPromise = new Promise((resolve) => {
    startResolve = resolve;
  });
  const terminal = new Promise((resolve) => {
    terminalResolve = resolve;
  });
  const snapshot = () => {
    const captured = captureLogs(logPaths, captureBytes);
    wrapperEvidence.memory = deriveMemoryAfterRun(
      wrapperEvidence.memory,
      captured.stderr,
    );
    return {
      stdout: captured.stdout,
      stderr: captured.stderr,
      duration_ms: Date.now() - started,
      memory: wrapperEvidence.memory,
      wrapper: wrapperEvidence,
      output: captured.output,
    };
  };

  let startupTimer = null;
  const finishStart = settleOnce(startResolve, (payload) => {
    clearTimeout(startupTimer);
    const {
      stdout,
      stderr,
      duration_ms: durationMs,
      memory,
      wrapper,
      output,
    } = snapshot();
    return {
      ...payload,
      stdout,
      stderr,
      duration_ms: durationMs,
      elapsed_ms: Date.now() - started,
      startup_window_ms: startupWindowMs,
      pid: child.pid || null,
      pgid: wrapperEvidence.pgid || child.pid || null,
      memory,
      wrapper,
      output,
      terminal,
      // The child owns its log fds; this only stops it holding the launcher's event loop open.
      detach() {
        child.unref?.();
      },
    };
  });
  const finishTerminal = settleOnce(terminalResolve, (payload) => ({
    ...payload,
    ...snapshot(),
  }));

  child.on("error", (err) => {
    const error = String(err.message || err);
    finishStart({ status: "failure", signal_source: "spawn_error", error });
    finishTerminal({ status: "failure", error, exit_code: null, signal: null });
  });
  child.on("close", (code, signal) => {
    const status = code === 0 ? "success" : "failure";
    const error = code === 0 ? null : `exit_code_${code}`;
    finishStart(exitBeforeStartPayload(code, signal, error));
    finishTerminal({ status, error, exit_code: code, signal });
  });
  if (typeof onSpawn === "function") {
    onSpawn(spawnInfo(child, wrapperEvidence, cwd));
  }
  startupTimer = setTimeout(
    () => {
      finishStart({
        status: "started",
        signal_source: "process_started",
        error: null,
      });
    },
    Math.max(1, Number(startupWindowMs || 1)),
  );
  return startedPromise;
}
