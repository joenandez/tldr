import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

import { superviseControlledProcess } from "./tldr_agent_supervised_child.mjs";

const DEFAULT_CAPTURE_BYTES = 64 * 1024;
const DEFAULT_MAX_STDIN_BYTES = 64 * 1024;
const DEFAULT_STARTUP_WINDOW_MS = 250;
const DEFAULT_KILL_GRACE_MS = 10_000;
const DEFAULT_SUPERVISOR_STARTUP_MS = 4_000;
const MAX_REQUEST_CLEANUP_GRACE_MS = 500;
const supervisorPath = fileURLToPath(
  new URL("./tldr_agent_resume_supervisor.mjs", import.meta.url),
);

function invalidStart(error) {
  return Promise.resolve({ status: "failure", error });
}

function validCommand(command, args, cwd, stdinText, maxStdinBytes) {
  if (typeof command !== "string" || command.trim() === "") {
    return "command_invalid";
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    return "args_invalid";
  }
  if (typeof cwd !== "string" || cwd.trim() === "") return "cwd_invalid";
  if (typeof stdinText !== "string") return "stdin_invalid";
  if (Buffer.byteLength(stdinText) > maxStdinBytes) return "stdin_too_large";
  return null;
}

function signalProcessGroup(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

function stopSupervisor(child, runtimePgid, killGraceMs) {
  signalProcessGroup(runtimePgid, "SIGTERM");
  signalProcessGroup(child.pid, "SIGTERM");
  const hardKillTimer = setTimeout(
    () => {
      signalProcessGroup(runtimePgid, "SIGKILL");
      signalProcessGroup(child.pid, "SIGKILL");
    },
    Math.min(
      MAX_REQUEST_CLEANUP_GRACE_MS,
      Math.max(0, Number(killGraceMs) || 0),
    ),
  );
  hardKillTimer.ref();
}

export function startControlledProcess({
  command,
  args = [],
  cwd,
  stdinText = "",
  timeoutMs = 14_400_000,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  captureBytes = DEFAULT_CAPTURE_BYTES,
  maxStdinBytes = DEFAULT_MAX_STDIN_BYTES,
  startupWindowMs = DEFAULT_STARTUP_WINDOW_MS,
  supervisorStartupMs = DEFAULT_SUPERVISOR_STARTUP_MS,
  signal = null,
  env = process.env,
  terminalContext = null,
  onSpawn = null,
  forkImpl = fork,
} = {}) {
  const invalid = validCommand(command, args, cwd, stdinText, maxStdinBytes);
  if (invalid) return invalidStart(invalid);

  let supervisor;
  try {
    supervisor = forkImpl(supervisorPath, [], {
      cwd,
      env,
      detached: true,
      execArgv: [],
      stdio: ["pipe", "ignore", "ignore", "ipc"],
    });
  } catch (error) {
    return invalidStart(error?.message || String(error));
  }

  return new Promise((resolve) => {
    let settled = false;
    let runtimePgid = null;
    const finish = (result, { terminate = false } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimer);
      signal?.removeEventListener?.("abort", onAbort);
      supervisor.removeAllListeners("error");
      supervisor.on("error", () => {});
      supervisor.removeAllListeners("exit");
      supervisor.removeAllListeners("message");
      if (terminate) stopSupervisor(supervisor, runtimePgid, killGraceMs);
      try {
        supervisor.disconnect();
      } catch {}
      supervisor.unref?.();
      resolve(result);
    };
    const onAbort = () =>
      finish(
        { status: "failure", error: "process_aborted" },
        { terminate: true },
      );
    const startupTimer = setTimeout(
      () =>
        finish(
          { status: "failure", error: "supervisor_start_timeout" },
          { terminate: true },
        ),
      Math.max(1, Number(supervisorStartupMs) || 1),
    );
    supervisor.once("error", (error) =>
      finish(
        { status: "failure", error: error?.message || String(error) },
        { terminate: Boolean(runtimePgid) },
      ),
    );
    supervisor.once("exit", (code, exitSignal) => {
      if (settled) return;
      finish(
        {
          status: "failure",
          error: `supervisor_exited_${code ?? exitSignal ?? "unknown"}`,
        },
        { terminate: Boolean(runtimePgid) },
      );
    });
    supervisor.on("message", (message) => {
      if (message?.status === "spawned") {
        runtimePgid = Number.isInteger(message.pgid) ? message.pgid : null;
        try {
          supervisor.send(
            { status: "ownership_ack", pgid: runtimePgid },
            (error) => {
              if (!error) return;
              finish(
                { status: "failure", error: "supervisor_ack_failed" },
                { terminate: true },
              );
            },
          );
        } catch {
          finish(
            { status: "failure", error: "supervisor_ack_failed" },
            { terminate: true },
          );
        }
        return;
      }
      if (message?.status === "started" && typeof onSpawn === "function") {
        try {
          onSpawn({
            pid: message.pid || null,
            pgid: message.pgid || null,
            command,
            args,
            cwd,
          });
        } catch {}
      }
      finish(message || { status: "failure", error: "supervisor_invalid" }, {
        terminate: Boolean(runtimePgid) && message?.status !== "started",
      });
    });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
    supervisor.stdin.on("error", () => {});
    supervisor.stdin.end(
      JSON.stringify({
        process: {
          command,
          args,
          cwd,
          timeoutMs,
          killGraceMs,
          captureBytes,
          startupWindowMs,
        },
        stdinText,
        terminalContext,
      }),
    );
  });
}

export { superviseControlledProcess };
