import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { resolveNodeExecutable } from "./node_exec.mjs";

function schedulerWorkingDir(schedulerScriptPath) {
  return resolve(dirname(schedulerScriptPath), "..", "..");
}

function scopeArgs(scope) {
  return scope?.cwd ? ["--cwd", scope.cwd] : [];
}

function parseJsonLine(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // Keep looking for the last JSON payload; warnings can share stdout.
    }
  }
  return null;
}

function parentAbortSource(reason) {
  if (reason?.code === "daemon_phase_timeout") return "phase_timeout";
  if (reason?.code === "daemon_tick_budget") return "tick_budget";
  return "parent_abort";
}

export function runHelmTasksJsonChild({
  schedulerScriptPath,
  args,
  scope = null,
  daemonInstanceId = null,
  timeoutMs = 15000,
  signal = null,
  env = {},
} = {}) {
  if (!schedulerScriptPath) {
    return Promise.resolve({
      ok: false,
      error: "scheduler_script_required",
      code: null,
      signal: null,
    });
  }
  if (!Array.isArray(args) || args.length === 0) {
    return Promise.resolve({
      ok: false,
      error: "child_args_required",
      code: null,
      signal: null,
    });
  }

  return new Promise((resolveResult) => {
    const child = spawn(
      resolveNodeExecutable(),
      [schedulerScriptPath, ...args, ...scopeArgs(scope), "--json-only"],
      {
        cwd: schedulerWorkingDir(schedulerScriptPath),
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ...env,
          HELM_DAEMON: "1",
          HELM_DAEMON_PID: String(process.pid),
          ...(daemonInstanceId
            ? { HELM_DAEMON_INSTANCE_ID: daemonInstanceId }
            : {}),
        },
      },
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let abortSource = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveResult(result);
    };

    const abort = (source) => {
      if (!abortSource) abortSource = source;
      process.stderr.write(
        `[🪳 TEMP DAEMON_CHILD_ABORT] source=${abortSource} args=${args.join(" ")}\n`,
      );
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 1000).unref?.();
    };

    const onAbort = () => abort(parentAbortSource(signal?.reason));
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    };

    const timer =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            abort("child_timeout");
          }, timeoutMs)
        : null;
    timer?.unref?.();

    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 1024 * 1024) stdout = stdout.slice(-1024 * 1024);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 256 * 1024) stderr = stderr.slice(-256 * 1024);
    });
    child.on("error", (err) => {
      finish({
        ok: false,
        error: err?.message || String(err),
        code: null,
        signal: null,
        abort_source: abortSource,
        stdout,
        stderr,
      });
    });
    child.on("close", (code, closeSignal) => {
      const parsed = parseJsonLine(stdout);
      finish({
        ok: code === 0 && Boolean(parsed?.ok),
        code,
        signal: closeSignal,
        timed_out: timedOut,
        abort_source: abortSource,
        error:
          parsed?.errors?.[0]?.message ||
          parsed?.errors?.[0]?.code ||
          (code === 0 ? null : `child exited ${code ?? closeSignal}`),
        data: parsed?.data || null,
        payload: parsed,
        stdout,
        stderr,
      });
    });
  });
}

export function runInboxPollChild({
  schedulerScriptPath,
  scope,
  daemonInstanceId,
  signal,
  timeoutMs,
  dispatchCaptured = true,
} = {}) {
  return runHelmTasksJsonChild({
    schedulerScriptPath,
    scope,
    daemonInstanceId,
    signal,
    timeoutMs,
    args: [
      "__tldr-agent-inbox-poll",
      ...(dispatchCaptured ? ["--dispatch-captured"] : []),
    ],
  });
}

export function runInboxDispatchChild({
  schedulerScriptPath,
  scope,
  daemonInstanceId,
  signal,
  timeoutMs,
} = {}) {
  return runHelmTasksJsonChild({
    schedulerScriptPath,
    scope,
    daemonInstanceId,
    signal,
    timeoutMs,
    args: ["__tldr-agent-inbox-dispatch"],
  });
}

export function runReplyObligationChild({
  schedulerScriptPath,
  scope,
  daemonInstanceId,
  signal,
  timeoutMs,
} = {}) {
  return runHelmTasksJsonChild({
    schedulerScriptPath,
    scope,
    daemonInstanceId,
    signal,
    timeoutMs,
    args: ["__tldr-agent-reply-obligations"],
  });
}
