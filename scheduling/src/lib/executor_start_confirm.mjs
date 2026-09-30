import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  deriveMemoryAfterRun,
  spawnWrappedCommand,
} from "./process_wrapper.mjs";
import {
  createBoundedTextCapture,
  outputMetadata,
  positiveIntegerEnv,
} from "./executor_process_utils.mjs";
import { writeAgentRunSession } from "./agent_run_session.mjs";

const DEFAULT_CAPTURE_BYTES = 64 * 1024;

function initializeLogFiles(
  logPaths = null,
  { append = false, env = process.env } = {},
) {
  if (!logPaths) return null;
  mkdirSync(dirname(logPaths.stdout), { recursive: true });
  if (!append) {
    writeFileSync(logPaths.stdout, "", "utf8");
    writeFileSync(logPaths.stderr, "", "utf8");
  }
  const state = {
    maxBytes: positiveIntegerEnv("HELM_LOG_MAX_BYTES", null, env),
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    errors: [],
  };
  const stdout = createWriteStream(logPaths.stdout, { flags: "a" });
  const stderr = createWriteStream(logPaths.stderr, { flags: "a" });
  stdout.on("error", (err) =>
    state.errors.push({
      stream: "stdout",
      code: err?.code || "log_write_failed",
      message: err?.message || String(err),
    }),
  );
  stderr.on("error", (err) =>
    state.errors.push({
      stream: "stderr",
      code: err?.code || "log_write_failed",
      message: err?.message || String(err),
    }),
  );
  return { stdout, stderr, state };
}

function closeLogStreams(streams) {
  if (!streams) return;
  streams.stdout.end();
  streams.stderr.end();
}

function appendLogChunk(streams, name, chunk) {
  if (!streams || streams.state.errors.length > 0) return;
  const stream = streams[name];
  if (!stream) return;
  const key = name === "stdout" ? "stdoutBytes" : "stderrBytes";
  const truncatedKey =
    name === "stdout" ? "stdoutTruncated" : "stderrTruncated";
  const maxBytes = streams.state.maxBytes;
  let buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  if (maxBytes !== null) {
    const remaining = maxBytes - streams.state[key];
    if (remaining <= 0) {
      streams.state[truncatedKey] = true;
      return;
    }
    if (buffer.length > remaining) {
      buffer = buffer.subarray(0, remaining);
      streams.state[truncatedKey] = true;
    }
  }
  streams.state[key] += buffer.length;
  stream.write(buffer);
}

export function launchCommandUntilStarted({
  command,
  args = [],
  cwd,
  timeoutSec = null,
  stdinText = null,
  extraEnv = {},
  memoryMode = null,
  onSpawn = null,
  logPaths = null,
  startupWindowMs = 250,
} = {}) {
  if (typeof command !== "string" || command.trim() === "") {
    throw new TypeError("command is required");
  }
  const started = Date.now();
  let logStreams = initializeLogFiles(logPaths, { env: extraEnv });
  const { child, evidence: wrapperEvidence } = spawnWrappedCommand({
    command,
    args,
    cwd,
    env: { ...process.env, ...extraEnv },
    memoryMode,
    stdio: ["pipe", "pipe", "pipe"],
    timeoutMs:
      Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : null,
  });
  const captureBytes = positiveIntegerEnv(
    "HELM_EXECUTOR_CAPTURE_BYTES",
    DEFAULT_CAPTURE_BYTES,
    extraEnv,
  );
  const stdoutCapture = createBoundedTextCapture(captureBytes);
  const stderrCapture = createBoundedTextCapture(captureBytes);
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
  const currentMemory = () => {
    const memory = deriveMemoryAfterRun(
      wrapperEvidence.memory,
      stderrCapture.text(),
    );
    wrapperEvidence.memory = memory;
    return memory;
  };
  const currentOutput = () =>
    outputMetadata(stdoutCapture, stderrCapture, logStreams);
  let startupTimer = null;
  const finishStart = (payload) => {
    if (startSettled) return;
    startSettled = true;
    if (startupTimer) clearTimeout(startupTimer);
    const memory = currentMemory();
    startResolve({
      ...payload,
      stdout: stdoutCapture.text(),
      stderr: stderrCapture.text(),
      duration_ms: Date.now() - started,
      elapsed_ms: Date.now() - started,
      startup_window_ms: startupWindowMs,
      pid: child.pid || null,
      pgid: wrapperEvidence.pgid || child.pid || null,
      memory,
      wrapper: wrapperEvidence,
      output: currentOutput(),
      terminal,
      detach() {
        closeLogStreams(logStreams);
        logStreams = null;
        child.unref?.();
        child.stdout?.unref?.();
        child.stderr?.unref?.();
        child.stdin?.unref?.();
      },
    });
  };
  const finishTerminal = (payload) => {
    if (terminalSettled) return;
    terminalSettled = true;
    closeLogStreams(logStreams);
    const memory = currentMemory();
    terminalResolve({
      ...payload,
      stdout: stdoutCapture.text(),
      stderr: stderrCapture.text(),
      duration_ms: Date.now() - started,
      memory,
      wrapper: wrapperEvidence,
      output: currentOutput(),
    });
  };
  child.stdout.on("data", (d) => {
    stdoutCapture.append(d);
    appendLogChunk(logStreams, "stdout", d);
  });
  child.stderr.on("data", (d) => {
    stderrCapture.append(d);
    appendLogChunk(logStreams, "stderr", d);
  });
  child.on("error", (err) => {
    const error = String(err.message || err);
    finishStart({ status: "failure", signal_source: "spawn_error", error });
    finishTerminal({ status: "failure", error, exit_code: null, signal: null });
  });
  child.on("close", (code, signal) => {
    const status = code === 0 ? "success" : "failure";
    const error = code === 0 ? null : `exit_code_${code}`;
    if (!startSettled && code === 0) {
      finishStart({
        status: "started",
        signal_source: "process_exit_zero_before_start",
        error: null,
        exit_code: code,
        signal,
      });
    } else if (!startSettled) {
      finishStart({
        status: "failure",
        signal_source: "process_exit_before_start",
        error,
        exit_code: code,
        signal,
      });
    }
    finishTerminal({ status, error, exit_code: code, signal });
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
  if (stdinText !== null) child.stdin.end(stdinText);
  else child.stdin.end();
  return startedPromise;
}

export async function runPreparedAdapterUntilStarted({
  adapter,
  sessionAgent = adapter.name,
  job,
  prepared,
  cwd,
  timeoutSec,
  extraEnv,
  memoryMode = null,
  onSpawn,
  logPaths,
  startupWindowMs,
  agentExecutionEnv,
  launchAgentUntilStarted,
  recordAdapterIdentityEvidence,
  snapshotSidecarIds,
}) {
  if (adapter.name === "academy") {
    process.stderr.write(
      `[🪳 TEMP ACADEMY_RUNTIME] provider=${adapter.name} session_owner=${sessionAgent}\n`,
    );
  }
  const sidecarBefore = prepared.sidecar
    ? snapshotSidecarIds(prepared.sidecar, cwd)
    : [];
  const trackedEnv = agentExecutionEnv(extraEnv, {
    sessionId: prepared.session_id || null,
  });
  const common = {
    command: prepared.argv[0],
    args: prepared.argv.slice(1),
    cwd,
    timeoutSec,
    stdinText: prepared.stdin ?? null,
    extraEnv: trackedEnv,
    memoryMode,
    onSpawn,
    logPaths,
    startupWindowMs,
  };
  const result =
    prepared.strategy === "external_mint"
      ? await launchCommandUntilStarted(common)
      : await launchAgentUntilStarted({
          agent: sessionAgent,
          ...common,
          runId: prepared.run_id || null,
          jobId: job.id || null,
        });
  if (result.status !== "started") {
    const missing = recordAdapterIdentityEvidence({
      adapter,
      job,
      prepared,
      finalized: {},
      runResult: result,
      cwd,
      env: trackedEnv,
    });
    return {
      ...result,
      session_id: null,
      resume_command: null,
      resume_cwd: null,
      resume_confidence: null,
      resume_candidates: [],
      session_identity_status: missing.status,
      session_identity_source: null,
      injected_via: prepared.injected_via,
      strategy: prepared.strategy,
    };
  }
  if (prepared.session_id) {
    writeAgentRunSession({
      jobId: trackedEnv.HELM_JOB_ID,
      runId: trackedEnv.HELM_RUN_ID,
      sessionId: prepared.session_id,
      agent: adapter.name,
      cwd,
    });
  }
  const sidecarAfter = prepared.sidecar
    ? snapshotSidecarIds(prepared.sidecar, cwd)
    : [];
  const finalized = adapter.finalize(
    {
      prepared,
      stdout: result.stdout,
      stderr: result.stderr,
      sidecarBefore,
      sidecarAfter,
    },
    { job },
  );
  const identity = recordAdapterIdentityEvidence({
    adapter,
    job,
    prepared,
    finalized,
    runResult: result,
    cwd,
    env: trackedEnv,
  });
  const enriched = {
    ...result,
    session_id: identity.identity?.session_id || finalized.session_id,
    resume_command:
      identity.identity?.resume_command || finalized.resume_command,
    resume_cwd: identity.identity?.resume_cwd || finalized.resume_cwd,
    resume_confidence:
      identity.identity?.confidence || finalized.resume_confidence,
    resume_candidates: finalized.resume_candidates,
    session_identity_status: identity.status,
    session_identity_source: identity.identity?.source || null,
    injected_via: prepared.injected_via,
    strategy: prepared.strategy,
  };
  if (identity.ok) return enriched;
  return {
    ...enriched,
    status: "failure",
    error: `missing_agent_session_id: ${adapter.name} did not register a session_id within startup window`,
    agent_session_required: true,
  };
}
