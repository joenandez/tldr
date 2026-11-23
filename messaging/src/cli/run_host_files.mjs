// The run host's files in <state-root>/sessions/<session>/: the prompt
// socket in.sock, in.pid (which live host serves it, for the resumer's
// synchronous spawn guard), and run_host.log, the host's own log. The host
// never logs to its stderr: that is the daemon's pipe, gone after a restart.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { sessionPaths } from "../protocol/session_paths.mjs";

// One older generation is kept, so a session's log stays under 2 x this.
export const RUN_HOST_LOG_MAX_BYTES = 256 * 1024;

function listen(server, file) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(file, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function accepts(file) {
  return new Promise((resolve) => {
    const probe = net.connect(file);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

function inodeOf(file) {
  try {
    return fs.lstatSync(file).ino;
  } catch {
    return null;
  }
}

function readInputPid(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function ensureSessionDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

// Written whole, then renamed, so the guard never reads half a record.
function writeInputPid(file, ino) {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify({ pid: process.pid, ino }), {
      mode: 0o600,
    });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/** Binds in.sock (0600 in a 0700 dir) and records in.pid; throws when it cannot. */
export async function bindInputSocket(stateRoot, session, onConnection) {
  const { dir, inputSocket, inputPid } = sessionPaths(stateRoot, session);
  ensureSessionDir(dir);
  const server = net.createServer(onConnection);
  try {
    await listen(server, inputSocket);
  } catch (error) {
    // A socket nobody answers is a dead host's leftover; a live one belongs to another run.
    const staleIno = inodeOf(inputSocket);
    if (error.code !== "EADDRINUSE" || (await accepts(inputSocket)))
      throw error;
    // Only the file probed: one bound since then has another inode.
    if (inodeOf(inputSocket) === staleIno)
      fs.rmSync(inputSocket, { force: true });
    await listen(server, inputSocket);
  }
  const bound = { server, socketPath: inputSocket, pidPath: inputPid };
  try {
    bound.ino = fs.lstatSync(inputSocket).ino;
    fs.chmodSync(inputSocket, 0o600);
    writeInputPid(inputPid, bound.ino);
  } catch (error) {
    // A listening server must not outlive a failed bind: the host would stay up without its socket.
    releaseInputSocket(bound);
    throw error;
  }
  return bound;
}

/** Closes the socket and removes in.sock and in.pid, but only while they are still this host's. */
export function releaseInputSocket(bound) {
  bound.server.close();
  if (inodeOf(bound.socketPath) === bound.ino)
    fs.rmSync(bound.socketPath, { force: true });
  if (readInputPid(bound.pidPath)?.ino === bound.ino)
    fs.rmSync(bound.pidPath, { force: true });
}

function openLog(dir) {
  ensureSessionDir(dir);
  const file = path.join(dir, "run_host.log");
  if (inodeOf(file) !== null && fs.statSync(file).size > RUN_HOST_LOG_MAX_BYTES)
    fs.renameSync(file, `${file}.1`);
  return fs.openSync(file, "a", 0o600);
}

/**
 * Line-JSON logger. Until attach(sessionDir) it writes to `fallback` (the
 * host's stderr); a failed write is dropped, never thrown, so logging can
 * never end a run.
 */
export function createRunHostLogger(fallback = process.stderr) {
  let fd = null;
  const write = (level) => (fields) => {
    const line = `${JSON.stringify({ level, ts: new Date().toISOString(), ...fields })}\n`;
    try {
      if (fd === null) fallback.write(line);
      else fs.writeSync(fd, line);
    } catch {
      // a closed pipe or a full disk: the run matters more than its log
    }
  };
  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    attach(dir) {
      try {
        fd = openLog(dir);
      } catch {
        // keep the fallback
      }
    },
  };
}

/** A grandchild may still hold the agent's pipes; destroying our ends keeps them from holding the host process alive. */
export function destroyAgentPipes(child) {
  for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe?.destroy();
}

/**
 * Output the agent wrote before it exited must reach the consumer before the pipes are destroyed:
 * `start(settle)` (on the agent's 'exit') calls `settle` once nothing is paused, buffered or pending
 * and no data arrived for a close wait, or at the drain cap. Timers are unref'd: a pending host
 * stdout write or an open agent pipe already keeps the process alive.
 */
export function trackOutputDrain(child, run, params) {
  let lastData = Date.now();
  let checkTimer;
  let capTimer;
  child.stdout.on("data", () => {
    lastData = Date.now();
  });
  const paused = () =>
    child.stdout.isPaused() || run.adapter.awaitingDrain === true;
  const drained = () =>
    !paused() &&
    child.stdout.readableLength === 0 &&
    (run.output?.writableLength ?? 0) === 0 &&
    Date.now() - lastData >= run.closeWaitMs;
  return {
    start(settle) {
      // A second 'exit' (after finish) must not arm timers nobody clears.
      if (run.exited) return;
      const check = () => {
        if (drained()) return settle();
        // Only the quiet window is left: look again the moment it ends, not a whole close wait later.
        const quietIn = lastData + run.closeWaitMs - Date.now();
        const flowing = !paused() && child.stdout.readableLength === 0;
        checkTimer = setTimeout(
          check,
          flowing && quietIn > 0 ? quietIn : run.closeWaitMs,
        ).unref();
      };
      capTimer = setTimeout(() => {
        run.logger.warn({
          event: "run_host.output_drain_cap",
          params,
          result: {
            buffered_bytes: child.stdout.readableLength,
            paused: paused(),
          },
          status: "error",
        });
        settle();
      }, run.drainCapMs).unref();
      // Never judge at 'exit' itself: the agent's last bytes may not have been read yet.
      checkTimer = setTimeout(check, run.closeWaitMs).unref();
    },
    stop() {
      clearTimeout(checkTimer);
      clearTimeout(capTimer);
    },
  };
}
