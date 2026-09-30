import { spawnSync } from "node:child_process";
import {
  createWriteStream,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdapterRegistry } from "./adapters/registry.mjs";
import {
  buildHelmContextBlock,
  buildHelmContextEnv,
  DEFAULT_REPORT_CMD,
} from "./helm_context.mjs";
import { mergeAdapterSessionIdentity } from "./adapter_session_identity.mjs";
import { runHeartbeatPath } from "./store.mjs";
import {
  classifyAgentRun,
  continuationPrompt,
  extractAgentSessionId,
  extractAgentPrompt,
  fallbackFor,
  ensureSessionCaptureArgs,
  managedAgentProcessDescriptor,
  readAgentDefaults,
  structuredAgentCommand,
} from "./agent_fallback.mjs";
import { writeAgentRunSession } from "./agent_run_session.mjs";
import { completionDeadlineAt } from "./run_deadline.mjs";
import { effectiveCompletionDelivery } from "./assignment_completion_delivery.mjs";
import { sessionBoundaryLaunch } from "./run_session_outcome.mjs";
import {
  deriveMemoryAfterRun,
  resolveMemoryRequest,
  spawnWrappedCommand,
} from "./process_wrapper.mjs";
import {
  launchCommandUntilStarted,
  runPreparedAdapterUntilStarted,
} from "./executor_start_confirm.mjs";
import { launchManagedAgentUntilStartedWithFallback } from "./executor_agent_start_fallback.mjs";
import {
  makeStdinFd,
  safeCloseFd,
  signalStartedProcessGroup,
} from "./executor_process_utils.mjs";
import {
  recordMissingSessionIdentity,
  recordSessionIdentity,
} from "./session_identity_index.mjs";
import {
  listSessions,
  readIdentity,
  readState,
  resolveSessionFromPidAncestry,
} from "./identity_state.mjs";
import { resolveRunSessionFromTightbeam } from "./tightbeam_sessions.mjs";

const BUILTIN_ADAPTERS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "adapters",
);

const DEFAULT_CAPTURE_BYTES = 64 * 1024;
const TRUNCATION_MARKER = "\n[... helm output truncated ...]\n";

let cachedRegistry = null;
let cachedRegistryKey = null;

function getRegistry() {
  const override = process.env.HELM_ADAPTERS_DIR || "";
  const key = `${BUILTIN_ADAPTERS_DIR}::${override}`;
  if (cachedRegistry && cachedRegistryKey === key) return cachedRegistry;
  const dirs = [BUILTIN_ADAPTERS_DIR];
  if (override) dirs.push(override);
  cachedRegistry = createAdapterRegistry({ dirs });
  cachedRegistryKey = key;
  return cachedRegistry;
}

function snapshotSidecarIds(sidecarSpec, cwd = undefined) {
  if (!sidecarSpec?.snapshot) return [];
  try {
    const result = spawnSync(
      sidecarSpec.snapshot.argv[0],
      sidecarSpec.snapshot.argv.slice(1),
      {
        cwd,
        encoding: "utf8",
        env: { ...process.env },
        timeout: 10_000,
      },
    );
    if (result.status !== 0) return [];
    const parsed = JSON.parse(result.stdout || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => (typeof item === "string" ? item : item?.id))
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function resolvePrompt(job, scope) {
  const type = job.prompt?.type;
  if (type === "inline") return job.prompt?.value || "";
  if (type === "file") {
    const relMode = job.prompt?.relative_to || "cwd";
    const base = relMode === "cwd" ? scope.cwd : scope.cwd;
    const resolved = isAbsolute(job.prompt.path)
      ? job.prompt.path
      : join(base, job.prompt.path);
    return readFileSync(resolved, "utf8");
  }
  return "";
}

function executionHints(job) {
  const explicitSessionRequired =
    job.execution_hints?.session_required !== undefined &&
    job.execution_hints?.session_required !== null;
  const managed =
    job.execution_hints?.managed === true ||
    Boolean(job.execution_hints?.provider);
  return {
    model: job.execution_hints?.model ?? job.execution?.model ?? null,
    max_turns:
      job.execution_hints?.max_turns ?? job.execution?.max_turns ?? null,
    output_format: job.execution_hints?.output_format ?? null,
    timeout_sec: job.limits?.timeout_sec ?? job.execution?.timeout_sec ?? null,
    managed,
    unmanaged: job.execution_hints?.unmanaged === true,
    session_required: explicitSessionRequired
      ? job.execution_hints.session_required === true
      : job.execution_hints?.unmanaged === true
        ? false
        : managed || !job.process?.command,
  };
}

function resolveProcessStdin(job, scope) {
  if (typeof job.process?.stdin === "string") return job.process.stdin;
  if (job.process?.stdin_file) {
    const base = job.process.cwd || scope.cwd;
    const resolved = isAbsolute(job.process.stdin_file)
      ? job.process.stdin_file
      : join(base, job.process.stdin_file);
    return readFileSync(resolved, "utf8");
  }
  return null;
}

function positiveIntegerEnv(name, fallback = null, env = process.env) {
  const raw = env?.[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function createBoundedTextCapture(maxBytes = DEFAULT_CAPTURE_BYTES) {
  const limit = Math.max(256, Number(maxBytes || DEFAULT_CAPTURE_BYTES));
  const headLimit = Math.floor(limit / 2);
  const tailLimit = limit - headLimit;
  let full = Buffer.alloc(0);
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let totalBytes = 0;
  let truncated = false;

  return {
    append(chunk) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(String(chunk));
      totalBytes += buffer.length;
      if (!truncated) {
        full = Buffer.concat([full, buffer]);
        if (full.length <= limit) return;
        truncated = true;
        head = full.subarray(0, headLimit);
        tail = full.subarray(full.length - tailLimit);
        full = Buffer.alloc(0);
        return;
      }
      if (head.length < headLimit) {
        const headRoom = headLimit - head.length;
        head = Buffer.concat([head, buffer.subarray(0, headRoom)]);
      }
      tail = Buffer.concat([tail, buffer]);
      if (tail.length > tailLimit) {
        tail = tail.subarray(tail.length - tailLimit);
      }
    },
    text() {
      if (!truncated) return full.toString();
      return `${head.toString()}${TRUNCATION_MARKER}${tail.toString()}`;
    },
    stats() {
      return {
        bytes: totalBytes,
        truncated,
        retained_bytes: Buffer.byteLength(this.text()),
      };
    },
  };
}

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
  const maxBytes = positiveIntegerEnv("HELM_LOG_MAX_BYTES", null, env);
  const state = {
    maxBytes,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    errors: [],
  };
  if (env.HELM_LOG_FAIL_WRITES === "1") {
    state.errors.push({
      stream: "all",
      code: "injected_log_write_failure",
      message: "log write failure injected by HELM_LOG_FAIL_WRITES",
    });
  }
  const stdout = createWriteStream(logPaths.stdout, { flags: "a" });
  const stderr = createWriteStream(logPaths.stderr, { flags: "a" });
  stdout.on("error", (err) => {
    state.errors.push({
      stream: "stdout",
      code: err?.code || "log_write_failed",
      message: err?.message || String(err),
    });
  });
  stderr.on("error", (err) => {
    state.errors.push({
      stream: "stderr",
      code: err?.code || "log_write_failed",
      message: err?.message || String(err),
    });
  });
  return {
    stdout,
    stderr,
    state,
  };
}

function closeLogStreams(streams) {
  if (!streams) return;
  streams.stdout.end();
  streams.stderr.end();
}

function appendLogChunk(streams, name, chunk) {
  if (!streams) return;
  if (streams.state.errors.length > 0) return;
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

function outputMetadata(stdoutCapture, stderrCapture, logStreams) {
  const stdout = stdoutCapture.stats();
  const stderr = stderrCapture.stats();
  return {
    stdout_bytes: stdout.bytes,
    stderr_bytes: stderr.bytes,
    stdout_truncated: stdout.truncated,
    stderr_truncated: stderr.truncated,
    output_truncated: stdout.truncated || stderr.truncated,
    retained_stdout_bytes: stdout.retained_bytes,
    retained_stderr_bytes: stderr.retained_bytes,
    log_stdout_bytes: logStreams?.state?.stdoutBytes ?? null,
    log_stderr_bytes: logStreams?.state?.stderrBytes ?? null,
    log_stdout_truncated: Boolean(logStreams?.state?.stdoutTruncated),
    log_stderr_truncated: Boolean(logStreams?.state?.stderrTruncated),
    log_write_errors: logStreams?.state?.errors || [],
  };
}

function outputMetadataFromLogFiles(stdoutCapture, stderrCapture, logPaths) {
  const stdout = stdoutCapture.stats();
  const stderr = stderrCapture.stats();
  return {
    stdout_bytes: stdout.bytes,
    stderr_bytes: stderr.bytes,
    stdout_truncated: stdout.truncated,
    stderr_truncated: stderr.truncated,
    output_truncated: stdout.truncated || stderr.truncated,
    retained_stdout_bytes: stdout.retained_bytes,
    retained_stderr_bytes: stderr.retained_bytes,
    log_stdout_bytes: logPaths
      ? Buffer.byteLength(readFileSync(logPaths.stdout, "utf8"))
      : null,
    log_stderr_bytes: logPaths
      ? Buffer.byteLength(readFileSync(logPaths.stderr, "utf8"))
      : null,
    log_stdout_truncated: false,
    log_stderr_truncated: false,
    log_write_errors: [],
  };
}

function readLogSnapshot(logPaths) {
  return {
    stdout: readFileSync(logPaths.stdout, "utf8"),
    stderr: readFileSync(logPaths.stderr, "utf8"),
  };
}

function appendLogDeltas(snapshot, offsets, stdoutCapture, stderrCapture) {
  if (snapshot.stdout.length > offsets.stdout) {
    stdoutCapture.append(snapshot.stdout.slice(offsets.stdout));
    offsets.stdout = snapshot.stdout.length;
  }
  if (snapshot.stderr.length > offsets.stderr) {
    stderrCapture.append(snapshot.stderr.slice(offsets.stderr));
    offsets.stderr = snapshot.stderr.length;
  }
}

function agentExecutionEnv(
  extraEnv = {},
  { sessionId = null, sessionRequired = true } = {},
) {
  return {
    ...extraEnv,
    ...(sessionRequired ? { HELM_AGENT_SESSION_REQUIRED: "1" } : {}),
    HELM_AGENT_LAUNCH_MODE:
      extraEnv.HELM_AGENT_LAUNCH_MODE || "non_interactive",
    ...(sessionId ? { HELM_AGENT_SESSION_ID: sessionId } : {}),
  };
}

function recordAdapterIdentityEvidence({
  adapter,
  job,
  prepared,
  finalized,
  runResult = {},
  cwd = null,
  env = {},
}) {
  const merged = mergeAdapterSessionIdentity({
    finalized,
    prepared,
    sessionRequired: job.execution_hints?.session_required !== false,
  });
  const runId = env.HELM_RUN_ID || prepared?.run_id || null;
  const jobId = env.HELM_JOB_ID || job?.id || null;
  if (!runId || !jobId || !adapter?.name) return merged;
  if (merged.ok && merged.identity) {
    recordSessionIdentity({
      runId,
      jobId,
      provider: adapter.name,
      pid: runResult.wrapper?.child_pid || null,
      processGroupId: runResult.wrapper?.process_group_id || null,
      sessionId: merged.identity.session_id,
      threadId: merged.identity.thread_id,
      resumeCommand: merged.identity.resume_command,
      resumeCwd: merged.identity.resume_cwd || cwd,
      confidence: merged.identity.confidence,
      source: merged.identity.source,
      evidencePath: merged.identity.evidence_path || null,
    });
  } else if (merged.status === "missing") {
    recordMissingSessionIdentity({
      runId,
      jobId,
      provider: adapter.name,
      pid: runResult.wrapper?.child_pid || null,
      processGroupId: runResult.wrapper?.process_group_id || null,
      reason: merged.reason,
    });
  }
  return merged;
}

function recordTrackedAgentSession({
  tracking,
  sessionId,
  extraEnv,
  pid,
  cwd,
}) {
  if (!tracking?.agent || tracking.recordedSessionId === sessionId) return;
  const jobId = extraEnv?.HELM_JOB_ID || null;
  const runId = extraEnv?.HELM_RUN_ID || null;
  if (!jobId || !runId || !sessionId) return;
  writeAgentRunSession({
    jobId,
    runId,
    sessionId,
    agent: tracking.agent,
    pid,
    cwd,
  });
  tracking.recordedSessionId = sessionId;
}

function runCommand(
  cmd,
  args,
  cwd,
  timeoutSec,
  stdinText = null,
  extraEnv = {},
  onSpawn = null,
  logPaths = null,
  { appendLogs = false, trackAgentSession = null, memoryMode = null } = {},
) {
  const started = Date.now();

  return new Promise((resolvePromise) => {
    const logStreams = initializeLogFiles(logPaths, {
      append: appendLogs,
      env: extraEnv,
    });
    const { child, evidence: wrapperEvidence } = spawnWrappedCommand({
      command: cmd,
      args,
      cwd,
      env: {
        ...process.env,
        ...extraEnv,
      },
      memoryMode,
      stdio: ["pipe", "pipe", "pipe"],
      timeoutMs:
        Number.isFinite(timeoutSec) && timeoutSec > 0
          ? timeoutSec * 1000
          : null,
      onSpawn,
    });

    const captureBytes = positiveIntegerEnv(
      "HELM_EXECUTOR_CAPTURE_BYTES",
      DEFAULT_CAPTURE_BYTES,
      extraEnv,
    );
    const stdoutCapture = createBoundedTextCapture(captureBytes);
    const stderrCapture = createBoundedTextCapture(captureBytes);
    let settled = false;

    child.stdout.on("data", (d) => {
      stdoutCapture.append(d);
      appendLogChunk(logStreams, "stdout", d);
      const stdout = stdoutCapture.text();
      const sessionId = trackAgentSession?.agent
        ? extractAgentSessionId(trackAgentSession.agent, stdout)
        : null;
      if (sessionId) {
        recordTrackedAgentSession({
          tracking: trackAgentSession,
          sessionId,
          extraEnv,
          pid: child.pid,
          cwd,
        });
      }
    });
    child.stderr.on("data", (d) => {
      stderrCapture.append(d);
      appendLogChunk(logStreams, "stderr", d);
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      closeLogStreams(logStreams);
      const stdout = stdoutCapture.text();
      const stderr = stderrCapture.text();
      const memory = deriveMemoryAfterRun(wrapperEvidence.memory, stderr);
      wrapperEvidence.memory = memory;
      resolvePromise({
        status: "failure",
        stdout,
        stderr,
        error: String(err.message || err),
        duration_ms: Date.now() - started,
        wrapper: wrapperEvidence,
        memory,
        output: outputMetadata(stdoutCapture, stderrCapture, logStreams),
      });
    });

    if (stdinText !== null) child.stdin.end(stdinText);
    else child.stdin.end();

    child.on("close", (code, _signal) => {
      if (settled) return;
      settled = true;
      closeLogStreams(logStreams);
      const finished = Date.now();
      const durationMs = finished - started;
      const stdout = stdoutCapture.text();
      const stderr = stderrCapture.text();
      const memory = deriveMemoryAfterRun(wrapperEvidence.memory, stderr);
      wrapperEvidence.memory = memory;
      const output = outputMetadata(stdoutCapture, stderrCapture, logStreams);
      if (output.log_write_errors.length > 0) {
        resolvePromise({
          status: "failure",
          stdout,
          stderr,
          error: `log_write_failed:${output.log_write_errors[0].code}`,
          duration_ms: durationMs,
          wrapper: wrapperEvidence,
          memory,
          output,
        });
        return;
      }
      if (wrapperEvidence.cleanup?.reason === "timeout" && timeoutSec) {
        resolvePromise({
          status: "failure",
          stdout,
          stderr,
          error: `timeout after ${timeoutSec}s`,
          duration_ms: durationMs,
          wrapper: wrapperEvidence,
          memory,
          output,
        });
        return;
      }
      if (code === 0) {
        resolvePromise({
          status: "success",
          stdout,
          stderr,
          error: null,
          duration_ms: durationMs,
          wrapper: wrapperEvidence,
          memory,
          output,
        });
      } else {
        resolvePromise({
          status: "failure",
          stdout,
          stderr,
          error: `exit_code_${code}`,
          duration_ms: durationMs,
          wrapper: wrapperEvidence,
          memory,
          output,
        });
      }
    });
  });
}

export function launchAgentUntilStarted({
  agent,
  command: requestedCommand,
  args: requestedArgs = [],
  cwd,
  timeoutSec = null,
  stdinText = null,
  extraEnv = {},
  memoryMode = null,
  onSpawn = null,
  logPaths = null,
  startupWindowMs = 30_000,
  runId = null,
  jobId = null,
} = {}) {
  const normalizedAgent =
    typeof agent === "string" && agent.trim() ? agent.trim() : null;
  if (!normalizedAgent) throw new TypeError("agent is required");
  if (typeof requestedCommand !== "string" || requestedCommand.trim() === "") {
    throw new TypeError("command is required");
  }
  // This launch is a handoff: it resolves when the session starts and the
  // session outlives every Helm process that could watch it (the daemon
  // dispatches each scope in a forked child, and a foreground run returns at
  // handoff). Wrapping it makes the session record its own terminal boundary,
  // so the run still gains a work outcome and a finish time.
  const { command, args } = sessionBoundaryLaunch({
    command: requestedCommand,
    args: requestedArgs,
  });
  if (logPaths) {
    const started = Date.now();
    mkdirSync(dirname(logPaths.stdout), { recursive: true });
    writeFileSync(logPaths.stdout, "", "utf8");
    writeFileSync(logPaths.stderr, "", "utf8");
    const captureBytes = positiveIntegerEnv(
      "HELM_EXECUTOR_CAPTURE_BYTES",
      DEFAULT_CAPTURE_BYTES,
      extraEnv,
    );
    const stdoutCapture = createBoundedTextCapture(captureBytes);
    const stderrCapture = createBoundedTextCapture(captureBytes);
    const offsets = { stdout: 0, stderr: 0 };
    const tracking = { agent: normalizedAgent };
    const stdinSpec = makeStdinFd(stdinText, logPaths);
    const stdoutFd = openSync(logPaths.stdout, "a");
    const stderrFd = openSync(logPaths.stderr, "a");
    const { child, evidence: wrapperEvidence } = spawnWrappedCommand({
      command,
      args,
      cwd,
      env: {
        ...process.env,
        ...extraEnv,
      },
      memoryMode,
      stdio: [stdinSpec.fd, stdoutFd, stderrFd],
      timeoutMs: null,
      onSpawn,
    });
    safeCloseFd(stdinSpec.fd);
    safeCloseFd(stdoutFd);
    safeCloseFd(stderrFd);
    child.unref?.();

    let startSettled = false;
    let terminalSettled = false;
    let startResolve;
    let terminalResolve;
    const startedPromise = new Promise((fulfillStarted) => {
      startResolve = fulfillStarted;
    });
    const terminal = new Promise((fulfillTerminal) => {
      terminalResolve = fulfillTerminal;
    });

    const currentOutput = () => {
      const snapshot = readLogSnapshot(logPaths);
      appendLogDeltas(snapshot, offsets, stdoutCapture, stderrCapture);
      return {
        stdout: stdoutCapture.text(),
        stderr: stderrCapture.text(),
      };
    };

    const finishStart = (payload) => {
      if (startSettled) return;
      startSettled = true;
      clearInterval(pollTimer);
      clearTimeout(startupTimer);
      const output = currentOutput();
      startResolve({
        ...payload,
        ...output,
        duration_ms: Date.now() - started,
        elapsed_ms: Date.now() - started,
        startup_window_ms: startupWindowMs,
        pid: child.pid || null,
        pgid: wrapperEvidence.pgid || child.pid || null,
        wrapper: wrapperEvidence,
        output: outputMetadataFromLogFiles(
          stdoutCapture,
          stderrCapture,
          logPaths,
        ),
        terminal,
        detach() {},
      });
    };

    const finishTerminal = (payload) => {
      if (terminalSettled) return;
      terminalSettled = true;
      const output = currentOutput();
      terminalResolve({
        ...payload,
        ...output,
        duration_ms: Date.now() - started,
        wrapper: wrapperEvidence,
        output: outputMetadataFromLogFiles(
          stdoutCapture,
          stderrCapture,
          logPaths,
        ),
      });
    };

    const checkForStart = () => {
      const { stdout } = currentOutput();
      const sessionId = extractAgentSessionId(normalizedAgent, stdout);
      if (!sessionId) return false;
      recordTrackedAgentSession({
        tracking,
        sessionId,
        extraEnv: {
          ...extraEnv,
          ...(jobId ? { HELM_JOB_ID: jobId } : {}),
          ...(runId ? { HELM_RUN_ID: runId } : {}),
        },
        pid: child.pid,
        cwd,
      });
      finishStart({
        status: "started",
        session_id: sessionId,
        signal_source: "stdout_session_id",
        error: null,
      });
      return true;
    };

    const pollTimer = setInterval(checkForStart, 25);
    const startupTimer = setTimeout(
      () => {
        // CANARY-BUG-008: signal the started process group on startup timeout,
        // matching the non-log branch. Without this the detached wrapper/agent
        // group survives the dispatch and leaks as an orphan reparented to
        // launchd (the reaper has no live record once the run is finalized).
        signalStartedProcessGroup(child.pid, "SIGTERM");
        finishStart({
          status: "failure",
          error: `missing_agent_session_id: ${normalizedAgent} did not register a session_id within startup window`,
          agent_session_required: true,
          signal_source: "startup_timeout",
          session_id: null,
        });
      },
      Math.max(1, Number(startupWindowMs || 1)),
    );
    checkForStart();

    child.on("error", (err) => {
      const error = String(err.message || err);
      finishStart({
        status: "failure",
        session_id: null,
        signal_source: "spawn_error",
        error,
      });
      finishTerminal({
        status: "failure",
        error,
        exit_code: null,
        signal: null,
      });
    });
    child.on("close", (code, signal) => {
      if (!startSettled) {
        finishStart({
          status: "failure",
          session_id: null,
          signal_source: "process_exit_before_session",
          error:
            code === 0
              ? `missing_agent_session_id: ${normalizedAgent} completed without a captured session_id`
              : `exit_code_${code}`,
        });
      }
      finishTerminal({
        status: code === 0 ? "success" : "failure",
        error: code === 0 ? null : `exit_code_${code}`,
        exit_code: code,
        signal,
      });
    });

    return startedPromise;
  }
  const started = Date.now();
  let logStreams = initializeLogFiles(logPaths, {
    append: false,
    env: extraEnv,
  });
  const { child, evidence: wrapperEvidence } = spawnWrappedCommand({
    command,
    args,
    cwd,
    env: {
      ...process.env,
      ...extraEnv,
    },
    memoryMode,
    stdio: ["pipe", "pipe", "pipe"],
    timeoutMs:
      Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : null,
    onSpawn,
  });
  const captureBytes = positiveIntegerEnv(
    "HELM_EXECUTOR_CAPTURE_BYTES",
    DEFAULT_CAPTURE_BYTES,
    extraEnv,
  );
  const stdoutCapture = createBoundedTextCapture(captureBytes);
  const stderrCapture = createBoundedTextCapture(captureBytes);
  const tracking = { agent: normalizedAgent };
  let startSettled = false;
  let terminalSettled = false;
  let startResolve;
  let terminalResolve;
  const startedPromise = new Promise((fulfillStarted) => {
    startResolve = fulfillStarted;
  });
  const terminal = new Promise((fulfillTerminal) => {
    terminalResolve = fulfillTerminal;
  });

  const finishStart = (payload) => {
    if (startSettled) return;
    startSettled = true;
    const memory = deriveMemoryAfterRun(
      wrapperEvidence.memory,
      stderrCapture.text(),
    );
    wrapperEvidence.memory = memory;
    startResolve({
      ...payload,
      duration_ms: Date.now() - started,
      elapsed_ms: Date.now() - started,
      startup_window_ms: startupWindowMs,
      pid: child.pid || null,
      pgid: wrapperEvidence.pgid || child.pid || null,
      memory,
      wrapper: wrapperEvidence,
      output: outputMetadata(stdoutCapture, stderrCapture, logStreams),
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
    const memory = deriveMemoryAfterRun(
      wrapperEvidence.memory,
      stderrCapture.text(),
    );
    wrapperEvidence.memory = memory;
    terminalResolve({
      ...payload,
      duration_ms: Date.now() - started,
      stdout: stdoutCapture.text(),
      stderr: stderrCapture.text(),
      memory,
      wrapper: wrapperEvidence,
      output: outputMetadata(stdoutCapture, stderrCapture, logStreams),
    });
  };

  const timer = setTimeout(
    () => {
      signalStartedProcessGroup(child.pid, "SIGTERM");
      finishStart({
        status: "failure",
        error: `missing_agent_session_id: ${normalizedAgent} did not register a session_id within startup window`,
        agent_session_required: true,
        signal_source: "startup_timeout",
        session_id: null,
      });
    },
    Math.max(1, Number(startupWindowMs || 1)),
  );
  timer.unref?.();

  child.stdout.on("data", (d) => {
    stdoutCapture.append(d);
    appendLogChunk(logStreams, "stdout", d);
    const stdout = stdoutCapture.text();
    const sessionId = extractAgentSessionId(normalizedAgent, stdout);
    if (!sessionId) return;
    clearTimeout(timer);
    recordTrackedAgentSession({
      tracking,
      sessionId,
      extraEnv: {
        ...extraEnv,
        ...(jobId ? { HELM_JOB_ID: jobId } : {}),
        ...(runId ? { HELM_RUN_ID: runId } : {}),
      },
      pid: child.pid,
      cwd,
    });
    finishStart({
      status: "started",
      session_id: sessionId,
      signal_source: "stdout_session_id",
      stdout,
      stderr: stderrCapture.text(),
      error: null,
    });
  });
  child.stderr.on("data", (d) => {
    stderrCapture.append(d);
    appendLogChunk(logStreams, "stderr", d);
  });

  child.on("error", (err) => {
    clearTimeout(timer);
    const error = String(err.message || err);
    finishStart({
      status: "failure",
      session_id: null,
      signal_source: "spawn_error",
      error,
      stdout: stdoutCapture.text(),
      stderr: stderrCapture.text(),
    });
    finishTerminal({
      status: "failure",
      error,
      exit_code: null,
      signal: null,
    });
  });

  if (stdinText !== null) child.stdin.end(stdinText);
  else child.stdin.end();

  child.on("close", (code, signal) => {
    clearTimeout(timer);
    if (!startSettled) {
      finishStart({
        status: "failure",
        session_id: null,
        signal_source: "process_exit_before_session",
        error:
          code === 0
            ? `missing_agent_session_id: ${normalizedAgent} completed without a captured session_id`
            : `exit_code_${code}`,
        stdout: stdoutCapture.text(),
        stderr: stderrCapture.text(),
      });
    }
    finishTerminal({
      status: code === 0 ? "success" : "failure",
      error: code === 0 ? null : `exit_code_${code}`,
      exit_code: code,
      signal,
    });
  });

  return startedPromise;
}

function defaultResumeCommand(agent, sessionId) {
  if (!sessionId) return null;
  if (agent === "claude") return `claude -r ${sessionId}`;
  if (agent === "codex") return `codex resume ${sessionId}`;
  return null;
}

function promoteClassifiedSession(agent, result, classification, cwd = null) {
  const sessionId = result.session_id || classification.session_id || null;
  if (!sessionId) return result;
  return {
    ...result,
    session_id: sessionId,
    resume_command:
      result.resume_command || defaultResumeCommand(agent, sessionId),
    resume_cwd: result.resume_cwd || cwd || null,
    resume_confidence: result.resume_confidence || "high",
    resume_candidates:
      Array.isArray(result.resume_candidates) &&
      result.resume_candidates.length > 0
        ? result.resume_candidates
        : [sessionId],
  };
}

function wrapperTimeRange(wrapper = {}) {
  const times = (Array.isArray(wrapper.lifecycle) ? wrapper.lifecycle : [])
    .map((entry) => Date.parse(entry?.ts))
    .filter((value) => Number.isFinite(value));
  if (times.length === 0) return null;
  return {
    startedMs: Math.min(...times),
    finishedMs: Math.max(...times),
  };
}

function sessionStartedInsideWrapper(identity, wrapper) {
  const sessionStartedMs = Date.parse(identity?.session_started_at || "");
  const range = wrapperTimeRange(wrapper);
  if (!Number.isFinite(sessionStartedMs) || !range) return false;
  const graceMs = 5_000;
  return (
    sessionStartedMs >= range.startedMs - graceMs &&
    sessionStartedMs <= range.finishedMs + graceMs
  );
}

function resolveSessionFromWrapperWindow(agent, wrapper) {
  const matches = [];
  for (const sessionId of listSessions()) {
    const identity = readIdentity(sessionId);
    if (!identity) continue;
    if (identity.runtime && identity.runtime !== agent) continue;
    if (!sessionStartedInsideWrapper(identity, wrapper)) continue;
    matches.push({
      ok: true,
      session_id: sessionId,
      runtime: identity.runtime || null,
      identity,
      state: readState(sessionId),
      source: "session_start_window",
    });
  }
  if (matches.length !== 1) {
    return {
      ok: false,
      error:
        matches.length > 1
          ? "session_start_window_ambiguous"
          : "session_start_window_unresolved",
      candidates: matches.map((entry) => entry.session_id),
    };
  }
  return matches[0];
}

// Session facts come from Tightbeam's session endpoints. The legacy files
// the retired Helm hooks wrote are read only when Tightbeam cannot name the
// session (one-release fallback); an ambiguous Tightbeam answer fails closed.
async function recoverSessionStartIdentity(agent, result, cwd) {
  const pid = result.wrapper?.pid || result.wrapper?.pgid || null;
  if (!pid) {
    return { ok: false, error: "wrapper_pid_missing", candidates: [] };
  }
  const range = wrapperTimeRange(result.wrapper);
  const fromTightbeam = await resolveRunSessionFromTightbeam({
    agent,
    startedMs: range?.startedMs,
    finishedMs: range?.finishedMs,
    cwd: result.wrapper?.cwd || cwd,
    pids: [result.wrapper?.pid, result.wrapper?.pgid],
  });
  if (fromTightbeam.ok) {
    const { session } = fromTightbeam;
    return {
      ok: true,
      session_id: session.session_id,
      runtime: session.runtime,
      identity: session,
      source: `tightbeam_${fromTightbeam.match}`,
    };
  }
  if (fromTightbeam.error === "tightbeam_session_ambiguous") {
    return fromTightbeam;
  }
  const resolved = resolveSessionFromPidAncestry({ pid });
  if (resolved.ok) return { ...resolved, source: "pid_ancestry" };
  const byWindow = resolveSessionFromWrapperWindow(agent, result.wrapper);
  return byWindow.ok ? byWindow : resolved;
}

async function promoteSessionStartIdentity(
  agent,
  result,
  extraEnv = {},
  cwd = null,
) {
  if (result.status !== "success" || result.session_id) return result;
  const pid = result.wrapper?.pid || result.wrapper?.pgid || null;
  if (!pid) return result;
  const resolved = await recoverSessionStartIdentity(agent, result, cwd);
  if (!resolved.ok) {
    return result;
  }
  if (!sessionStartedInsideWrapper(resolved.identity, result.wrapper)) {
    return result;
  }
  if (resolved.runtime && resolved.runtime !== agent) {
    return result;
  }
  recordTrackedAgentSession({
    tracking: { agent },
    sessionId: resolved.session_id,
    extraEnv,
    pid,
    cwd,
  });
  return {
    ...result,
    session_id: resolved.session_id,
    resume_command:
      result.resume_command || defaultResumeCommand(agent, resolved.session_id),
    resume_cwd: result.resume_cwd || cwd || null,
    resume_confidence: result.resume_confidence || "high",
    resume_candidates:
      Array.isArray(result.resume_candidates) &&
      result.resume_candidates.length > 0
        ? result.resume_candidates
        : [resolved.session_id],
    session_identity_source:
      result.session_identity_source || "session_start_hook",
    session_identity_resolution: resolved.source || null,
  };
}

function requireAgentSession(agent, result) {
  if (result.status !== "success" || result.session_id) return result;
  return {
    ...result,
    status: "failure",
    error: `missing_agent_session_id: ${agent} completed without a captured session_id; check SessionStart hooks and structured output capture.`,
    agent_session_required: true,
  };
}

function maybeRequireAgentSession(agent, result, sessionRequired = true) {
  return sessionRequired === false
    ? result
    : requireAgentSession(agent, result);
}

function withClassifiedStatus(agent, result, cwd = null) {
  const classification = classifyAgentRun(agent, result);
  const promoted = promoteClassifiedSession(agent, result, classification, cwd);
  if (classification.status === "failure" && result.status === "success") {
    return {
      ...promoted,
      status: "failure",
      error: classification.failure_summary || `${agent}_structured_failure`,
      agent_classification: classification,
    };
  }
  return {
    ...promoted,
    agent_classification: classification,
  };
}

function fallbackMetadata({
  primaryAgent,
  fallbackAgent,
  fallbackPolicy,
  primary,
  fallback,
  fallbackMode,
}) {
  return {
    fallback_triggered: Boolean(fallback),
    fallback_policy: fallbackPolicy,
    fallback_mode: fallbackMode || null,
    primary_agent: primaryAgent,
    fallback_agent: fallbackAgent || null,
    selected_agent: fallback ? fallbackAgent : primaryAgent,
    primary_status: primary?.status || null,
    primary_failure_summary:
      primary?.agent_classification?.failure_summary || primary?.error || null,
    primary_raw_error_class:
      primary?.agent_classification?.raw_error_class || null,
    primary_saw_model_tool_call: Boolean(
      primary?.agent_classification?.saw_model_tool_call,
    ),
    fallback_status: fallback?.status || null,
    fallback_failure_summary:
      fallback?.agent_classification?.failure_summary ||
      fallback?.error ||
      null,
  };
}

async function runFallbackCommand({
  primaryAgent,
  fallbackAgent,
  prompt,
  primaryResult,
  cwd,
  timeoutSec,
  extraEnv,
  memoryMode = null,
  onSpawn,
  logPaths,
}) {
  const fallbackPrompt = primaryResult.agent_classification?.saw_model_tool_call
    ? continuationPrompt({
        originalPrompt: prompt,
        primaryAgent,
        failureSummary:
          primaryResult.agent_classification?.failure_summary ||
          primaryResult.error,
        stdoutPath: logPaths?.stdout || null,
        stderrPath: logPaths?.stderr || null,
      })
    : prompt;
  const spec = structuredAgentCommand(fallbackAgent, fallbackPrompt);
  if (!spec) return null;
  const trackedEnv = agentExecutionEnv(extraEnv);
  const result = await runCommand(
    spec.command,
    spec.args,
    cwd,
    timeoutSec,
    null,
    trackedEnv,
    onSpawn,
    logPaths,
    {
      appendLogs: true,
      trackAgentSession: { agent: fallbackAgent },
      memoryMode,
    },
  );
  return withClassifiedStatus(fallbackAgent, result, cwd);
}

async function runDirectAgentCommandWithFallback({
  agent,
  command,
  args,
  cwd,
  timeoutSec,
  stdinText,
  extraEnv,
  memoryMode = null,
  onSpawn,
  logPaths,
  sessionRequired = true,
  wrapper = null,
}) {
  const defaults = readAgentDefaults();
  const fallbackAgent = fallbackFor(agent, defaults);
  const captureArgs = ensureSessionCaptureArgs(agent, args, wrapper);
  const prompt = extractAgentPrompt({ agent, args: captureArgs, stdinText });
  const trackedEnv = agentExecutionEnv(extraEnv, { sessionRequired });
  const primaryRaw = await runCommand(
    command,
    captureArgs,
    cwd,
    timeoutSec,
    stdinText,
    trackedEnv,
    onSpawn,
    logPaths,
    { trackAgentSession: { agent }, memoryMode },
  );
  const primary = await promoteSessionStartIdentity(
    agent,
    withClassifiedStatus(agent, primaryRaw, cwd),
    trackedEnv,
    cwd,
  );
  if (
    primary.status === "success" ||
    defaults.fallback_policy === "never" ||
    !fallbackAgent ||
    fallbackAgent === agent ||
    !prompt
  ) {
    const selected = maybeRequireAgentSession(agent, primary, sessionRequired);
    return {
      ...selected,
      agent_fallback: fallbackMetadata({
        primaryAgent: agent,
        fallbackAgent: fallbackAgent || null,
        fallbackPolicy: defaults.fallback_policy,
        primary,
        fallback: null,
        fallbackMode:
          !prompt && primary.status !== "success"
            ? "ineligible:no_prompt"
            : null,
      }),
    };
  }
  const fallback = await runFallbackCommand({
    primaryAgent: agent,
    fallbackAgent,
    prompt,
    primaryResult: primary,
    cwd,
    timeoutSec,
    extraEnv: trackedEnv,
    memoryMode,
    onSpawn,
    logPaths,
  });
  const selected = maybeRequireAgentSession(
    fallbackAgent,
    fallback,
    sessionRequired,
  );
  return {
    ...selected,
    agent_fallback: fallbackMetadata({
      primaryAgent: agent,
      fallbackAgent,
      fallbackPolicy: defaults.fallback_policy,
      primary,
      fallback: selected,
      fallbackMode: primary.agent_classification?.saw_model_tool_call
        ? "continuation"
        : "replay",
    }),
  };
}

function resolveAdapter(job) {
  const provider = job.execution_hints?.provider;
  if (!provider) return null;
  const adapter = getRegistry().get(provider);
  return adapter || null;
}

function selectedAdapterRuntime(adapter, job) {
  if (adapter?.name !== "academy") return adapter?.name || null;
  const runtime =
    job?.execution_hints?.provider_config?.academy_runtime || "claude";
  return runtime === "codex" ? "codex" : "claude";
}

async function runPreparedAdapter({
  adapter,
  job,
  prepared,
  cwd,
  timeoutSec,
  extraEnv,
  memoryMode = null,
  onSpawn,
  logPaths,
  appendLogs = false,
}) {
  const sidecarBefore = prepared.sidecar
    ? snapshotSidecarIds(prepared.sidecar, cwd)
    : [];
  const trackedEnv = agentExecutionEnv(extraEnv, {
    sessionId: prepared.session_id || null,
  });
  if (prepared.session_id) {
    writeAgentRunSession({
      jobId: trackedEnv.HELM_JOB_ID,
      runId: trackedEnv.HELM_RUN_ID,
      sessionId: prepared.session_id,
      agent: adapter.name,
      cwd,
    });
  }
  const result = await runCommand(
    prepared.argv[0],
    prepared.argv.slice(1),
    cwd,
    timeoutSec,
    prepared.stdin ?? null,
    trackedEnv,
    onSpawn,
    logPaths,
    { appendLogs, trackAgentSession: { agent: adapter.name }, memoryMode },
  );
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
  return {
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
}

async function runPreparedAdapterUntilStartedWithFallback({
  adapter,
  job,
  prepared,
  prompt,
  primaryAgent,
  cwd,
  timeoutSec,
  extraEnv,
  memoryMode = null,
  onSpawn,
  logPaths,
  startupWindowMs,
  defaults,
  buildAgentExecutionEnv,
  launchUntilStarted,
  recordIdentityEvidence,
  snapshotSidecars,
}) {
  const primaryRaw = await runPreparedAdapterUntilStarted({
    adapter,
    sessionAgent: primaryAgent,
    job,
    prepared,
    cwd,
    timeoutSec,
    extraEnv,
    memoryMode,
    onSpawn,
    logPaths,
    startupWindowMs,
    agentExecutionEnv: buildAgentExecutionEnv,
    launchAgentUntilStarted: launchUntilStarted,
    recordAdapterIdentityEvidence: recordIdentityEvidence,
    snapshotSidecarIds: snapshotSidecars,
  });
  const primary = withClassifiedStatus(primaryAgent, primaryRaw, cwd);
  const fallbackAgent = fallbackFor(primaryAgent, defaults);
  if (
    primary.status === "started" ||
    defaults.fallback_policy === "never" ||
    !fallbackAgent ||
    fallbackAgent === primaryAgent ||
    !prompt
  ) {
    return {
      ...primary,
      provider: adapter.name,
      agent_fallback: fallbackMetadata({
        primaryAgent,
        fallbackAgent,
        fallbackPolicy: defaults.fallback_policy,
        primary,
        fallback: null,
        fallbackMode:
          !prompt && primary.status !== "started"
            ? "ineligible:no_prompt"
            : null,
      }),
    };
  }
  const fallbackPrompt = primary.agent_classification?.saw_model_tool_call
    ? continuationPrompt({
        originalPrompt: prompt,
        primaryAgent,
        failureSummary:
          primary.agent_classification?.failure_summary || primary.error,
        stdoutPath: logPaths?.stdout || null,
        stderrPath: logPaths?.stderr || null,
      })
    : prompt;
  const fallbackSpec = structuredAgentCommand(fallbackAgent, fallbackPrompt);
  if (!fallbackSpec) {
    return {
      ...primary,
      provider: adapter.name,
      agent_fallback: {
        ...fallbackMetadata({
          primaryAgent,
          fallbackAgent,
          fallbackPolicy: defaults.fallback_policy,
          primary,
          fallback: null,
        }),
        fallback_mode: "ineligible:no_structured_command",
      },
    };
  }

  const fallbackRaw = await launchAgentUntilStarted({
    agent: fallbackAgent,
    command: fallbackSpec.command,
    args: fallbackSpec.args,
    cwd,
    timeoutSec,
    stdinText: null,
    extraEnv: buildAgentExecutionEnv(extraEnv),
    memoryMode,
    onSpawn,
    logPaths,
    startupWindowMs,
    runId: prepared.run_id || null,
    jobId: job.id || null,
  });
  const fallback = withClassifiedStatus(fallbackAgent, fallbackRaw, cwd);
  return {
    ...fallback,
    provider: adapter.name,
    agent_fallback: fallbackMetadata({
      primaryAgent,
      fallbackAgent,
      fallbackPolicy: defaults.fallback_policy,
      primary,
      fallback,
      fallbackMode: primary.agent_classification?.saw_model_tool_call
        ? "continuation"
        : "replay",
    }),
  };
}

// Exported for unit-testing the threading of assignment context through the prompt path.
export function augmentPromptWithHelmContext(prompt, context) {
  const block = buildHelmContextBlock(context);
  return `${block}\n\n${prompt}`;
}

// Render a job schedule object as a human-readable string for the assignment context block.
// The complete schedule-rendering belongs to the helm-assignments binary;
// this covers the common cases needed for the spawned agent's self-awareness line.
function formatAssignmentSchedule(schedule) {
  if (!schedule) return "unscheduled";
  if (schedule.type === "recurring") return schedule.cron || "recurring";
  if (schedule.type === "interval") return `every ${schedule.every}`;
  if (schedule.type === "once")
    return schedule.start_at ? `once at ${schedule.start_at}` : "once";
  return schedule.type || "unscheduled";
}

function enrichWithAdapter({
  adapter,
  prepared,
  fake,
  sidecarBefore,
  sidecarAfter,
  job,
}) {
  const finalized = adapter.finalize(
    {
      prepared,
      stdout: fake.stdout || "",
      stderr: fake.stderr || "",
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
    runResult: fake,
    cwd: job.process?.cwd || job.cwd || null,
    env: {
      HELM_JOB_ID: job.id || "",
      HELM_RUN_ID: prepared.run_id || "",
    },
  });
  return {
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
}

export async function executeJob(job, opts) {
  const adapter = resolveAdapter(job);
  const memoryRequest = resolveMemoryRequest({
    requestedMode: opts?.memoryMode ?? null,
    env: process.env,
    job,
  });
  for (const warning of memoryRequest.warnings || []) {
    process.stderr.write(`${warning}\n`);
  }
  const memoryMode = memoryRequest.mode;

  if (process.env.HELM_FAKE_EXEC_JSON) {
    try {
      const fake = JSON.parse(process.env.HELM_FAKE_EXEC_JSON);
      if (opts.logPaths) {
        mkdirSync(dirname(opts.logPaths.stdout), { recursive: true });
        writeFileSync(opts.logPaths.stdout, fake.stdout || "", "utf8");
        writeFileSync(opts.logPaths.stderr, fake.stderr || "", "utf8");
      }
      const base = {
        status: fake.status || "success",
        stdout: fake.stdout || "",
        stderr: fake.stderr || "",
        error: fake.error || null,
        duration_ms: Number(fake.duration_ms || 1),
        memory: {
          requested_mode: memoryMode,
          effective_mode: memoryMode === "off" ? "off" : "read+write",
          reason: memoryMode === "off" ? "operator_off" : "ok",
          workspace: null,
          read: memoryMode === "read+write",
          write: memoryMode === "read+write",
          context_cwd: job.process?.cwd || opts.scope?.cwd || null,
          notes: ["fake_exec"],
        },
      };
      if (adapter) {
        const prompt = resolvePrompt(job, opts.scope);
        const enrichedJob = {
          ...job,
          cwd: job.process?.cwd || opts.scope?.cwd || "",
        };
        const prepared = adapter.prepare({
          job: enrichedJob,
          run: { job_id: job.id, run_id: opts.runId || "" },
          prompt,
          model: job.execution_hints?.model ?? null,
        });
        return requireAgentSession(adapter.name, {
          ...base,
          ...enrichWithAdapter({
            adapter,
            prepared,
            fake,
            sidecarBefore: [],
            sidecarAfter: [],
            job: enrichedJob,
          }),
        });
      }
      if (opts.resolveOnStarted && base.status === "success") {
        return {
          ...base,
          status: "started",
          error: null,
          signal_source: fake.signal_source || "fake_exec_started",
          detach: () => {},
        };
      }
      return base;
    } catch {
      // fall through to real execution
    }
  }

  const { scope } = opts;
  const hints = executionHints(job);
  const timeoutSec = hints.timeout_sec;

  if (adapter) {
    const defaults = readAgentDefaults();
    const rawPrompt = resolvePrompt(job, scope);
    const reportCmd = process.env.HELM_REPORT_CMD || DEFAULT_REPORT_CMD;
    const cwd = job.process?.cwd || scope.cwd;
    const scopeId = scope.scope_id || scope.cwd;
    // Build the assignment self-awareness arg from job.metadata?.assignment (skill_path, status)
    // plus name and schedule from the job record — these are not stored on the assignment metadata.
    const assignmentMeta = job.metadata?.assignment;
    const assignment = assignmentMeta
      ? {
          name: job.name,
          skill_path: assignmentMeta.skill_path,
          schedule: formatAssignmentSchedule(job.schedule),
          run_mode: opts.runMode || "scheduled",
          completion_delivery: effectiveCompletionDelivery(assignmentMeta),
        }
      : undefined;
    const reportDeadline = assignment
      ? completionDeadlineAt({
          startedAt: opts.startedAt || new Date().toISOString(),
          job,
        })
      : null;
    const prompt = augmentPromptWithHelmContext(rawPrompt, {
      jobId: job.id,
      runId: opts.runId || "pending",
      reportCmd,
      scopeId,
      scopeCwd: cwd,
      completionDeadlineAt: reportDeadline,
      assignment,
    });
    const enrichedJob = { ...job, cwd };
    const prepared = adapter.prepare({
      job: enrichedJob,
      run: { job_id: job.id, run_id: opts.runId || "" },
      prompt,
      model: hints.model,
    });
    const helmEnv = buildHelmContextEnv({
      jobId: job.id,
      runId: opts.runId || "pending",
      reportCmd: process.env.HELM_REPORT_CMD || DEFAULT_REPORT_CMD,
      scopeId,
      scopeCwd: cwd,
      reportRequired: Boolean(assignment),
      completionDeadlineAt: reportDeadline,
    });
    const extraEnv = { ...helmEnv, ...(prepared.env || {}) };
    const primaryAgent = selectedAdapterRuntime(adapter, enrichedJob);
    if (opts.resolveOnStarted) {
      return runPreparedAdapterUntilStartedWithFallback({
        adapter,
        job: enrichedJob,
        prepared,
        prompt,
        primaryAgent,
        cwd,
        timeoutSec,
        extraEnv,
        memoryMode,
        onSpawn: opts.onSpawn,
        logPaths: opts.logPaths,
        startupWindowMs: opts.startupWindowMs,
        defaults,
        buildAgentExecutionEnv: agentExecutionEnv,
        launchUntilStarted: launchAgentUntilStarted,
        recordIdentityEvidence: recordAdapterIdentityEvidence,
        snapshotSidecars: snapshotSidecarIds,
      });
    }
    const primary = withClassifiedStatus(
      primaryAgent,
      await runPreparedAdapter({
        adapter,
        job: enrichedJob,
        prepared,
        cwd,
        timeoutSec,
        extraEnv,
        memoryMode,
        onSpawn: opts.onSpawn,
        logPaths: opts.logPaths,
      }),
      cwd,
    );
    const fallbackAgent = fallbackFor(primaryAgent, defaults);
    if (
      primary.status === "success" ||
      defaults.fallback_policy === "never" ||
      !fallbackAgent ||
      fallbackAgent === primaryAgent
    ) {
      const selected = requireAgentSession(primaryAgent, primary);
      return {
        ...selected,
        agent_fallback: fallbackMetadata({
          primaryAgent,
          fallbackAgent,
          fallbackPolicy: defaults.fallback_policy,
          primary,
          fallback: null,
        }),
      };
    }
    const fallbackAdapter = getRegistry().get(fallbackAgent);
    if (!fallbackAdapter) {
      return {
        ...primary,
        agent_fallback: {
          ...fallbackMetadata({
            primaryAgent,
            fallbackAgent,
            fallbackPolicy: defaults.fallback_policy,
            primary,
            fallback: null,
          }),
          fallback_mode: "ineligible:no_adapter",
        },
      };
    }
    const fallbackPrompt = primary.agent_classification?.saw_model_tool_call
      ? continuationPrompt({
          originalPrompt: prompt,
          primaryAgent,
          failureSummary:
            primary.agent_classification?.failure_summary || primary.error,
          stdoutPath: opts.logPaths?.stdout || null,
          stderrPath: opts.logPaths?.stderr || null,
        })
      : prompt;
    const fallbackPrepared = fallbackAdapter.prepare({
      job: enrichedJob,
      run: { job_id: job.id, run_id: opts.runId || "" },
      prompt: fallbackPrompt,
      model: hints.model,
    });
    const fallback = withClassifiedStatus(
      fallbackAgent,
      await runPreparedAdapter({
        adapter: fallbackAdapter,
        job: enrichedJob,
        prepared: fallbackPrepared,
        cwd,
        timeoutSec,
        extraEnv: { ...helmEnv, ...(fallbackPrepared.env || {}) },
        memoryMode,
        onSpawn: opts.onSpawn,
        logPaths: opts.logPaths,
        appendLogs: true,
      }),
      cwd,
    );
    const selected = requireAgentSession(fallbackAgent, fallback);
    return {
      ...selected,
      agent_fallback: fallbackMetadata({
        primaryAgent,
        fallbackAgent,
        fallbackPolicy: defaults.fallback_policy,
        primary,
        fallback: selected,
        fallbackMode: primary.agent_classification?.saw_model_tool_call
          ? "continuation"
          : "replay",
      }),
    };
  }

  const runtimeScopeId = scope.scope_id || scope.cwd;
  const runtimeScopeCwd = job.process?.cwd || scope.cwd;
  const runtimeEnv = {
    HELM_JOB_ID: job.id,
    HELM_JOB_NAME: job.name,
    HELM_RUN_ID: opts.runId || "",
    HELM_SCOPE_ID: runtimeScopeId,
    HELM_SCOPE_CWD: runtimeScopeCwd,
    HELM_TRIGGERED_AT: new Date().toISOString(),
  };
  // Opportunity #9: liveness contract for long-blocking work — anything the
  // run touches at this path counts as a heartbeat to the reaper, even when
  // CPU and log signals are flat.
  if (opts.runId) {
    const heartbeatPath = runHeartbeatPath(scope, opts.runId);
    try {
      mkdirSync(dirname(heartbeatPath), { recursive: true });
      runtimeEnv.HELM_RUN_HEARTBEAT_PATH = heartbeatPath;
    } catch {
      // best-effort: a run without a heartbeat path falls back to CPU/log signals
    }
  }

  if (job.process?.command) {
    const args = Array.isArray(job.process.args)
      ? job.process.args.map((value) => String(value))
      : [];
    const cwd = job.process.cwd || scope.cwd;
    const stdinText = resolveProcessStdin(job, scope);
    const extraEnv = {
      ...runtimeEnv,
      ...(job.process.env && typeof job.process.env === "object"
        ? job.process.env
        : {}),
    };
    const processRunOpts = {
      cwd,
      timeoutSec,
      stdinText,
      extraEnv,
      memoryMode,
      onSpawn: opts.onSpawn,
      logPaths: opts.logPaths,
    };
    const managedProcess = managedAgentProcessDescriptor({
      command: job.process.command,
      args,
    });
    if (managedProcess) {
      if (opts.resolveOnStarted) {
        return launchManagedAgentUntilStartedWithFallback({
          agent: managedProcess.agent,
          command: job.process.command,
          args,
          wrapper: managedProcess.wrapper,
          ...processRunOpts,
          startupWindowMs: opts.startupWindowMs,
          runId: opts.runId || null,
          jobId: job.id || null,
          agentExecutionEnv,
          launchAgentUntilStarted,
        });
      }
      return runDirectAgentCommandWithFallback({
        agent: managedProcess.agent,
        command: job.process.command,
        args,
        ...processRunOpts,
        sessionRequired: true,
        wrapper: managedProcess.wrapper,
      });
    }
    if (opts.resolveOnStarted) {
      return launchCommandUntilStarted({
        command: job.process.command,
        args,
        ...processRunOpts,
        startupWindowMs: opts.startupWindowMs,
      });
    }
    return runCommand(
      job.process.command,
      args,
      cwd,
      timeoutSec,
      stdinText,
      extraEnv,
      opts.onSpawn,
      opts.logPaths,
      { memoryMode },
    );
  }

  const prompt = resolvePrompt(job, scope).trim();
  const defaults = readAgentDefaults();
  const primary = structuredAgentCommand(defaults.primary, prompt);
  return runDirectAgentCommandWithFallback({
    agent: defaults.primary,
    command: primary.command,
    args: primary.args,
    cwd: scope.cwd,
    timeoutSec,
    stdinText: null,
    extraEnv: runtimeEnv,
    memoryMode,
    onSpawn: opts.onSpawn,
    logPaths: opts.logPaths,
    sessionRequired: hints.session_required,
  });
}
