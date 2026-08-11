import { spawn } from "node:child_process";

const TRUNCATION_MARKER = "\n[... tldr-agent output truncated ...]\n";

function boundedCapture(maxBytes) {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 0;
  const headLimit = Math.floor(limit / 2);
  const tailLimit = limit - headLimit;
  let totalBytes = 0;
  let full = Buffer.alloc(0);
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let truncated = false;
  return {
    append(chunk) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(String(chunk));
      totalBytes += buffer.length;
      if (!truncated && full.length + buffer.length <= limit) {
        full = Buffer.concat([full, buffer]);
        return;
      }
      if (!truncated) {
        truncated = true;
        head = full.subarray(0, headLimit);
        tail = full.subarray(Math.max(0, full.length - tailLimit));
        full = Buffer.alloc(0);
      }
      tail = Buffer.concat([tail, buffer]);
      if (tail.length > tailLimit) {
        tail = tail.subarray(tail.length - tailLimit);
      }
    },
    text() {
      return truncated
        ? `${head.toString()}${TRUNCATION_MARKER}${tail.toString()}`
        : full.toString();
    },
    metadata() {
      return { bytes: totalBytes, truncated };
    },
  };
}

function signalProcessGroup(pid, signal, killImpl) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    killImpl(-pid, signal);
    return true;
  } catch {
    try {
      killImpl(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

export function superviseControlledProcess({
  command,
  args = [],
  cwd,
  stdinText = "",
  timeoutMs,
  killGraceMs,
  captureBytes,
  startupWindowMs,
  signal = null,
  onSpawn = null,
  spawnImpl = spawn,
  killImpl = process.kill.bind(process),
}) {
  const stdout = boundedCapture(captureBytes);
  const stderr = boundedCapture(captureBytes);
  const startedAt = Date.now();
  let child;
  try {
    child = spawnImpl(command, args, {
      cwd,
      env: process.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    const message = error?.message || String(error);
    return Promise.resolve({
      status: "failure",
      error: message,
      terminal: Promise.resolve({ status: "failure", error: message }),
    });
  }

  let startSettled = false;
  let terminalSettled = false;
  let terminationError = null;
  let timedOut = false;
  let startupTimer = null;
  let timeoutTimer = null;
  let killTimer = null;
  let resolveStart;
  let resolveTerminal;
  const terminal = new Promise((resolve) => {
    resolveTerminal = resolve;
  });
  const started = new Promise((resolve) => {
    resolveStart = resolve;
  });

  const output = () => {
    const stdoutMeta = stdout.metadata();
    const stderrMeta = stderr.metadata();
    return {
      stdout_bytes: stdoutMeta.bytes,
      stderr_bytes: stderrMeta.bytes,
      stdout_truncated: stdoutMeta.truncated,
      stderr_truncated: stderrMeta.truncated,
      output_truncated: stdoutMeta.truncated || stderrMeta.truncated,
    };
  };
  const finishStart = (result) => {
    if (startSettled) return;
    startSettled = true;
    if (startupTimer) clearTimeout(startupTimer);
    resolveStart({
      ...result,
      pid: child.pid || null,
      pgid: child.pid || null,
      stdout: stdout.text(),
      stderr: stderr.text(),
      elapsed_ms: Date.now() - startedAt,
      terminal,
    });
  };
  const cleanup = () => {
    if (startupTimer) clearTimeout(startupTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (killTimer) clearTimeout(killTimer);
    signal?.removeEventListener?.("abort", onAbort);
  };
  const finishTerminal = (result) => {
    if (terminalSettled) return;
    terminalSettled = true;
    cleanup();
    resolveTerminal({
      ...result,
      stdout: stdout.text(),
      stderr: stderr.text(),
      duration_ms: Date.now() - startedAt,
      timed_out: timedOut,
      output: output(),
    });
  };
  const terminate = (error) => {
    if (terminalSettled || terminationError) return;
    terminationError = error;
    timedOut = error === "process_timeout";
    finishStart({ status: "failure", error });
    signalProcessGroup(child.pid, "SIGTERM", killImpl);
    killTimer = setTimeout(
      () => signalProcessGroup(child.pid, "SIGKILL", killImpl),
      Math.max(0, Number(killGraceMs) || 0),
    );
  };
  function onAbort() {
    terminate("process_aborted");
  }

  child.stdout?.on("data", (chunk) => stdout.append(chunk));
  child.stderr?.on("data", (chunk) => stderr.append(chunk));
  child.stdin?.on("error", () => {});
  child.once("spawn", () => {
    if (terminationError) return;
    if (typeof onSpawn === "function") {
      try {
        onSpawn({
          pid: child.pid || null,
          pgid: child.pid || null,
          command,
          args,
          cwd,
        });
      } catch {}
    }
    startupTimer = setTimeout(
      () => finishStart({ status: "started", error: null }),
      Math.max(1, Number(startupWindowMs) || 1),
    );
  });
  child.once("error", (error) => {
    const message = error?.message || String(error);
    finishStart({ status: "failure", error: message });
    finishTerminal({
      status: "failure",
      error: message,
      exit_code: null,
      signal: null,
    });
  });
  child.once("close", (code, closeSignal) => {
    const processFailed = code !== 0 || Boolean(terminationError);
    const error = terminationError || (code === 0 ? null : `exit_code_${code}`);
    if (!startSettled) {
      finishStart({
        status: processFailed ? "failure" : "started",
        error,
        exit_code: code,
        signal: closeSignal,
      });
    }
    finishTerminal({
      status: processFailed ? "failure" : "success",
      error,
      exit_code: code,
      signal: closeSignal,
    });
  });

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutTimer = setTimeout(() => terminate("process_timeout"), timeoutMs);
  }
  if (signal?.aborted) onAbort();
  else signal?.addEventListener?.("abort", onAbort, { once: true });
  child.stdin?.end(stdinText);
  return started;
}
