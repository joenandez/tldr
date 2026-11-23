#!/usr/bin/env node
// The run host: a sidecar that lives exactly as long as one agent run and
// owns that run's stdin, so the daemon can hand a live run a new prompt.
//
//   node run_host.mjs --runtime claude --session <id> [--resume <id>] -- <agent command...>
//
// It reads the brief from its own stdin until EOF, spawns the agent, writes
// the brief through the runtime adapter, and passes the agent's stdout
// through unchanged (the resumer's output capture parses it as before). A
// prompt arrives as one JSON line on <state-root>/sessions/<session>/in.sock:
//
//   -> {"op":"prompt","id":"<delivery id>","text":"...","deliver":"steer"|"queue","owner_launch_token":"..."}
//   <- {"id","ok":true,"delivered":"steer"|"queue"}  |  {"id"?,"ok":false,"reason":"owner"|"closed"|"busy"|"rejected"|"error"}
//
// Only the endpoint's current owner may take a prompt: the request names the
// owner's launch token and the host refuses (`owner`) unless it equals its own
// TIGHTBEAM_LAUNCH_TOKEN. A host with no token cannot prove it owns anything,
// so it refuses every prompt and the mail takes today's hook and resume routes.
// A repeated id gets its first ack (or waits on its pending one) and writes nothing. Input ends 5 s after
// the run is idle with no background task (the run then exits on its own); later prompts get
// `closed`. `busy` (Codex only: a turn is starting) and `rejected` (Codex only: the app-server
// refused every turn that could carry it) are retryable and never cached. A failed bind ends input right after the brief: today's run.
// The host exits with the agent's exit code and removes its socket.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { isSafeSessionId, sessionPaths } from "../protocol/session_paths.mjs";
import { resolveStateRoot } from "../protocol/state_root_location.mjs";
import {
  createClaudeAdapter,
  parseJsonLine,
} from "../runtimes/claude_stream_adapter.mjs";
import { createCodexAdapter } from "../runtimes/codex_app_server_adapter.mjs";
import {
  bindInputSocket,
  createRunHostLogger,
  destroyAgentPipes,
  releaseInputSocket,
  trackOutputDrain,
} from "./run_host_files.mjs";

export const GRACE_MS = 5_000;
// How long after the agent's 'exit' the host waits for 'close' before resolving without it.
const CLOSE_WAIT_MS = 2_000;
// Bound on how long output still in flight after 'exit' may delay finishing (a grandchild that keeps writing).
// shortcut: a live consumer that stops reading our stdout still holds the process via the pending write; bound it if that is ever seen.
const OUTPUT_DRAIN_CAP_MS = 60_000;
const FORWARDED_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];

export const ADAPTERS = {
  claude: createClaudeAdapter,
  codex: createCodexAdapter,
};

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

const DELIVER_MODES = new Set(["steer", "queue"]);

function isPromptRequest(request) {
  const fieldsOk =
    typeof request?.text === "string" && typeof request.id === "string";
  return (
    fieldsOk &&
    request.id !== "" &&
    request.op === "prompt" &&
    DELIVER_MODES.has(request.deliver)
  );
}

function refusalOf(run, request) {
  if (!isPromptRequest(request)) return "error";
  if (!run.launchToken || request.owner_launch_token !== run.launchToken)
    return "owner";
  return run.acks.has(request.id) || run.inputOpen ? null : "closed";
}

// Claude: an ack means the line reached the agent's stdin pipe, not the model (review M4).
// Codex: an ack means the app-server accepted a turn carrying the text; a refusal is dropped
// from the replay table so the same id stays retryable.
async function deliverOnce(run, request) {
  const delivered = await run.deliver(
    request.text,
    request.deliver,
    request.id,
  );
  if (!delivered.refused) return { id: request.id, ok: true, delivered };
  run.acks.delete(request.id);
  return { id: request.id, ok: false, reason: delivered.refused };
}

/**
 * One protocol reply. An id already taken shares its first (possibly pending) answer, so it is
 * written at most once. A caller that stops waiting (the daemon's request timeout) gets no ack.
 */
function answerPrompt(run, request) {
  const reason = refusalOf(run, request);
  if (reason)
    return {
      ...(typeof request?.id === "string" ? { id: request.id } : {}),
      ok: false,
      reason,
    };
  if (!run.acks.has(request.id))
    run.acks.set(request.id, deliverOnce(run, request));
  return run.acks.get(request.id);
}

function serveConnection(run, socket) {
  run.connections.add(socket);
  socket.on("close", () => run.connections.delete(socket));
  // A client that hangs up before its reply loses only the ack; the id stays replayable.
  socket.on("error", () => socket.destroy());
  readline
    .createInterface({ input: socket, crlfDelay: Infinity })
    // readline re-emits socket errors: a late reply to a caller that timed out and left must not throw.
    .on("error", () => socket.destroy())
    .on("line", async (line) => {
      const startedAt = performance.now();
      const request = parseJsonLine(line);
      const reply = await answerPrompt(run, request);
      run.logger.info({
        event: "run_host.prompt",
        params: { id: reply.id, deliver: request?.deliver },
        result: reply.ok
          ? { delivered: reply.delivered }
          : { reason: reply.reason },
        status: reply.ok ? "ok" : "refused",
        latency_ms: Math.round(performance.now() - startedAt),
      });
      socket.write(`${JSON.stringify(reply)}\n`);
    });
}

/** The live input side of one run: adapter, input lifetime, replay table, and socket. */
function createRun({ child, runtime, logger, graceMs, launch, launchToken }) {
  let graceTimer = null;
  const run = {
    logger,
    launchToken,
    inputOpen: true,
    exited: false,
    gone: false,
    bound: null,
    acks: new Map(),
    connections: new Set(),
    endInput(why, error) {
      if (!run.inputOpen) return;
      run.inputOpen = false;
      clearTimeout(graceTimer);
      run.adapter.endInput();
      logger.info({
        event: "run_host.input_ended",
        params: { why },
        status: "ok",
        ...(error ? { error: error.message } : {}),
      });
    },
    deliver(text, deliver, id) {
      clearTimeout(graceTimer);
      return run.adapter.prompt(text, deliver, id);
    },
    release() {
      run.gone = true;
      run.inputOpen = false;
      clearTimeout(graceTimer);
      if (run.bound) {
        releaseInputSocket(run.bound);
        for (const socket of run.connections) socket.destroy();
        run.bound = null;
      }
    },
  };
  run.adapter = ADAPTERS[runtime]({
    ...launch,
    child,
    input: child.stdin,
    output: child.stdout,
    logger,
    // The grace starts only when the run is idle with no background task (review H2).
    onIdle: () => {
      clearTimeout(graceTimer);
      if (run.inputOpen)
        graceTimer = setTimeout(() => run.endInput("grace"), graceMs);
    },
    onBusy: () => clearTimeout(graceTimer),
  });
  return run;
}

function exitCodeOf(code, signal) {
  return code ?? 128 + (os.constants.signals[signal] ?? 0);
}

function waitForExit(child, run, params) {
  return new Promise((resolve) => {
    const drain = trackOutputDrain(child, run, params);
    const finish = (code, fields = {}) => {
      if (run.exited) return;
      run.exited = true;
      drain.stop();
      run.release();
      // Rejects a handshake still waiting on an app-server that is gone.
      run.adapter.lines?.close();
      destroyAgentPipes(child);
      const ok = code === 0;
      const undelivered = run.adapter.undelivered?.() ?? 0;
      if (undelivered > 0)
        run.logger.error({
          event: "run_host.prompts_undelivered",
          params,
          result: { count: undelivered },
          status: "error",
        });
      run.logger[ok ? "info" : "warn"]({
        event: "run_host.exited",
        params,
        result: { code },
        status: ok ? "ok" : "error",
        ...fields,
      });
      resolve(code);
    };
    // 127: the shell's "command could not run"; no 'close' is promised after a spawn error.
    child.on("error", (error) =>
      finish(127, { error: { message: error.message, stack: error.stack } }),
    );
    // 'close' can wait on a grandchild that inherited stdout; the socket goes with the agent.
    const done = (code, signal) => {
      const agentCode = exitCodeOf(code, signal);
      finish(
        run.adapter.exitCode?.(agentCode) ?? agentCode,
        signal ? { signal } : {},
      );
    };
    // ...so a 'close' that never follows 'exit' must not hang the host: resolve from the exit.
    // Unread output (a paused or slow consumer) is not dropped: wait until it drains, bounded by the cap.
    child.on("exit", (code, signal) => {
      run.release();
      drain.start(() => done(code, signal));
    });
    child.on("close", done);
  });
}

function bindOrNull(stateRoot, session, run) {
  return bindInputSocket(stateRoot, session, (socket) =>
    serveConnection(run, socket),
  ).catch((error) => {
    run.logger.warn({
      event: "run_host.input_unavailable",
      params: { session },
      result: { reason: error.code ?? "unsafe_session_id" },
      status: "error",
      error: { message: error.message, stack: error.stack },
    });
    return null;
  });
}

// The host stays up to report the agent's exit code; the agent decides how to stop.
function forwardSignalsUntil(child, exited) {
  const forward = (signal) => child.kill(signal);
  for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);
  exited.finally(() => {
    for (const signal of FORWARDED_SIGNALS) process.off(signal, forward);
  });
}

/** Runs one hosted agent to completion; resolves with the exit code to pass on. */
export async function runHost({
  runtime,
  session,
  resume = null,
  approvalPolicy,
  sandbox,
  command,
  args = [],
  stateRoot,
  launchToken = null,
  input,
  output,
  logger,
  spawnFn = spawn,
  graceMs = GRACE_MS,
  safetyKillMs,
  killGraceMs,
  closeWaitMs = CLOSE_WAIT_MS,
  drainCapMs = OUTPUT_DRAIN_CAP_MS,
  handshakeMs,
  forwardSignals = false,
}) {
  const brief = await readAll(input);
  const child = spawnFn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
  const launch = {
    resume,
    approvalPolicy,
    sandbox,
    safetyKillMs,
    killGraceMs,
    handshakeMs,
    stdout: output,
  };
  const run = createRun({
    child,
    runtime,
    logger,
    graceMs,
    launch,
    launchToken,
  });
  run.closeWaitMs = closeWaitMs;
  run.drainCapMs = drainCapMs;
  run.output = output;
  if (!run.adapter.ownsStdout) child.stdout.pipe(output, { end: false });
  const exitParams = { runtime, session };
  const exited = waitForExit(child, run, exitParams);
  if (forwardSignals) forwardSignalsUntil(child, exited);
  child.stdin.on("error", (error) => run.endInput("stdin_error", error));
  // An adapter that learns the session from the agent (Codex: the thread id) resolves it here.
  const learned = brief ? await run.adapter.start(brief) : undefined;
  if (!brief) run.endInput("no_brief");
  exitParams.session = learned === undefined ? session : learned;
  if (isSafeSessionId(exitParams.session))
    logger.attach?.(sessionPaths(stateRoot, exitParams.session).dir);
  run.bound = exitParams.session
    ? await bindOrNull(stateRoot, exitParams.session, run)
    : null;
  const socketBound = run.bound !== null;
  // The child may have exited while the bind was in flight.
  if (run.gone) run.release();
  logger.info({
    event: "run_host.started",
    params: { ...exitParams, socket_bound: socketBound },
    status: "ok",
  });
  if (!socketBound) run.endInput("bind_failed");
  return exited;
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      runtime: { type: "string" },
      session: { type: "string" },
      resume: { type: "string" },
      "approval-policy": { type: "string" },
      sandbox: { type: "string" },
    },
    allowPositionals: true,
  });
  const [command, ...args] = positionals;
  // A Codex run's session is its thread id, learned from the app-server.
  const sessionOk = values.session || values.runtime === "codex";
  if (!ADAPTERS[values.runtime] || !sessionOk || !command) {
    process.stderr.write(
      `usage: run_host --runtime <${Object.keys(ADAPTERS).join("|")}> --session <id> [--resume <id>] [--approval-policy <p>] [--sandbox <s>] -- <command...>\n`,
    );
    return 2;
  }
  const { "approval-policy": approvalPolicy, ...rest } = values;
  const options = {
    ...rest,
    approvalPolicy,
    command,
    args,
    stateRoot: resolveStateRoot(),
    launchToken: process.env.TIGHTBEAM_LAUNCH_TOKEN || null,
  };
  // stderr is the daemon's pipe: after a daemon restart a write fails with EPIPE.
  process.stderr.on("error", () => {});
  return runHost({
    ...options,
    forwardSignals: true,
    input: process.stdin,
    output: process.stdout,
    logger: createRunHostLogger(),
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href
) {
  process.exitCode = await main(process.argv.slice(2));
}
