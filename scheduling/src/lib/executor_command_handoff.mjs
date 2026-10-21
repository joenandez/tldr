// executor_command_handoff — launch a scheduled command job that is handed off
// after its startup window and still reports how it actually ended.
//
// Unlike launchCommandUntilStarted (executor_start_confirm.mjs), the child
// writes straight to the run's log files instead of through pipes owned by the
// dispatcher. The dispatcher is usually a short-lived forked child; once it
// exits, piped output was lost and a later write could kill the command with
// SIGPIPE. The command is also wrapped so its own process tree records its exit
// status (command_exit_record.mjs), which is what lets the run be finalized
// with the real exit code after every Helm process that launched it is gone.

import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  deriveMemoryAfterRun,
  spawnWrappedCommand,
} from "./process_wrapper.mjs";
import {
  createBoundedTextCapture,
  makeStdinFd,
  positiveIntegerEnv,
  safeCloseFd,
} from "./executor_process_utils.mjs";
import {
  commandExitBoundaryLaunch,
  commandResolvable,
} from "./command_exit_record.mjs";

const DEFAULT_CAPTURE_BYTES = 64 * 1024;

function readLog(path) {
  try {
    return readFileSync(path);
  } catch {
    return Buffer.alloc(0);
  }
}

function captureLogs(logPaths, captureBytes) {
  const stdout = createBoundedTextCapture(captureBytes);
  const stderr = createBoundedTextCapture(captureBytes);
  const stdoutBytes = readLog(logPaths.stdout);
  const stderrBytes = readLog(logPaths.stderr);
  stdout.append(stdoutBytes);
  stderr.append(stderrBytes);
  const out = stdout.stats();
  const err = stderr.stats();
  return {
    stdout: stdout.text(),
    stderr: stderr.text(),
    output: {
      stdout_bytes: out.bytes,
      stderr_bytes: err.bytes,
      stdout_truncated: out.truncated,
      stderr_truncated: err.truncated,
      output_truncated: out.truncated || err.truncated,
      retained_stdout_bytes: out.retained_bytes,
      retained_stderr_bytes: err.retained_bytes,
      log_stdout_bytes: stdoutBytes.length,
      log_stderr_bytes: stderrBytes.length,
      log_stdout_truncated: false,
      log_stderr_truncated: false,
      log_write_errors: [],
    },
  };
}

function spawnErrorResult(command, startupWindowMs) {
  const error = `spawn ${command} ENOENT`;
  return {
    status: "failure",
    signal_source: "spawn_error",
    error,
    exit_code: null,
    stdout: "",
    stderr: "",
    duration_ms: 0,
    elapsed_ms: 0,
    startup_window_ms: startupWindowMs,
    pid: null,
    pgid: null,
    memory: null,
    wrapper: null,
    output: null,
    terminal: Promise.resolve({ status: "failure", error, exit_code: null }),
    detach() {},
  };
}

/**
 * Launch a command, resolve once it survives `startupWindowMs` (or exits
 * first), and keep a `terminal` promise for its real exit.
 *
 * Requires `logPaths` and `exitRecordPath`; the exit record path is exported to
 * the child as HELM_RUN_EXIT_PATH.
 */
export async function launchRecordedCommandUntilStarted({
  command,
  args = [],
  cwd,
  timeoutSec = null,
  stdinText = null,
  extraEnv = {},
  memoryMode = null,
  onSpawn = null,
  logPaths,
  exitRecordPath,
  startupWindowMs = 250,
} = {}) {
  if (typeof command !== "string" || command.trim() === "") {
    throw new TypeError("command is required");
  }
  if (!logPaths?.stdout || !logPaths?.stderr || !exitRecordPath) {
    throw new TypeError("logPaths and exitRecordPath are required");
  }
  const env = { ...process.env, ...extraEnv };
  if (!commandResolvable(command, { cwd, env })) {
    process.stderr.write(
      `[helm command-handoff] spawn_error command_unresolvable command=${command} cwd=${cwd || "unknown"}\n`,
    );
    return spawnErrorResult(command, startupWindowMs);
  }

  const started = Date.now();
  const captureBytes = positiveIntegerEnv(
    "HELM_EXECUTOR_CAPTURE_BYTES",
    DEFAULT_CAPTURE_BYTES,
    extraEnv,
  );
  mkdirSync(dirname(logPaths.stdout), { recursive: true });
  writeFileSync(logPaths.stdout, "", "utf8");
  writeFileSync(logPaths.stderr, "", "utf8");
  const stdinSpec = makeStdinFd(stdinText, logPaths);
  const stdoutFd = openSync(logPaths.stdout, "a");
  const stderrFd = openSync(logPaths.stderr, "a");
  const launch = commandExitBoundaryLaunch({ command, args });
  const { child, evidence: wrapperEvidence } = spawnWrappedCommand({
    command: launch.command,
    args: launch.args,
    cwd,
    env: { ...env, HELM_RUN_EXIT_PATH: exitRecordPath },
    memoryMode,
    stdio: [stdinSpec.fd, stdoutFd, stderrFd],
    timeoutMs:
      Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : null,
  });
  safeCloseFd(stdinSpec.fd);
  safeCloseFd(stdoutFd);
  safeCloseFd(stderrFd);
  child.unref?.();

  let startSettled = false;
  let terminalSettled = false;
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
    return captured;
  };

  let startupTimer = null;
  const finishStart = (payload) => {
    if (startSettled) return;
    startSettled = true;
    if (startupTimer) clearTimeout(startupTimer);
    const captured = snapshot();
    startResolve({
      ...payload,
      stdout: captured.stdout,
      stderr: captured.stderr,
      duration_ms: Date.now() - started,
      elapsed_ms: Date.now() - started,
      startup_window_ms: startupWindowMs,
      pid: child.pid || null,
      pgid: wrapperEvidence.pgid || child.pid || null,
      memory: wrapperEvidence.memory,
      wrapper: wrapperEvidence,
      output: captured.output,
      exit_record_path: exitRecordPath,
      terminal,
      // Nothing to release: the child owns its log fds and is already unref'd.
      detach() {},
    });
  };
  const finishTerminal = (payload) => {
    if (terminalSettled) return;
    terminalSettled = true;
    const captured = snapshot();
    terminalResolve({
      ...payload,
      stdout: captured.stdout,
      stderr: captured.stderr,
      duration_ms: Date.now() - started,
      memory: wrapperEvidence.memory,
      wrapper: wrapperEvidence,
      output: captured.output,
    });
  };

  child.on("error", (err) => {
    const error = String(err.message || err);
    finishStart({ status: "failure", signal_source: "spawn_error", error });
    finishTerminal({ status: "failure", error, exit_code: null, signal: null });
  });
  child.on("close", (code, signal) => {
    const error =
      code === 0 ? null : code === null ? `signal_${signal}` : `exit_code_${code}`;
    if (!startSettled) {
      finishStart(
        code === 0
          ? {
              status: "started",
              signal_source: "process_exit_zero_before_start",
              error: null,
              exit_code: code,
              signal,
            }
          : {
              status: "failure",
              signal_source: "process_exit_before_start",
              error,
              exit_code: code,
              signal,
            },
      );
    }
    finishTerminal({
      status: code === 0 ? "success" : "failure",
      error,
      exit_code: code,
      signal,
    });
  });
  if (typeof onSpawn === "function") {
    onSpawn({
      pid: child.pid,
      pgid: wrapperEvidence.pgid || child.pid || null,
      command: wrapperEvidence.command,
      args: wrapperEvidence.args,
      cwd,
      wrapper: wrapperEvidence,
    });
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
