import { evaluateExactResumeOutput } from "./tldr_agent_exact_resume.mjs";
import { superviseControlledProcess } from "./tldr_agent_supervised_child.mjs";
import {
  getTransportState,
  mutateTransportState,
} from "./substrate/canonical_store.mjs";

const RETRY_DELAY_MS = 30_000;
const DISPATCH_SETTLE_MS = 1_000;
const SUPERVISOR_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendStartup(result) {
  if (typeof process.send !== "function" || !process.connected) return;
  process.send(result, () => {
    try {
      process.disconnect();
    } catch {}
  });
}

function sendOwnership(started, signal) {
  return new Promise((resolve) => {
    if (typeof process.send !== "function" || !process.connected) {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (accepted) => {
      if (settled) return;
      settled = true;
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
      signal?.removeEventListener?.("abort", onAbort);
      resolve(accepted);
    };
    const onMessage = (message) => {
      if (
        message?.status !== "ownership_ack" ||
        message?.pgid !== (started.pgid || null)
      ) {
        return;
      }
      finish(true);
    };
    const onDisconnect = () => finish(false);
    const onAbort = () => finish(false);
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
    signal?.addEventListener?.("abort", onAbort, { once: true });
    process.send(
      {
        status: "spawned",
        pid: started.pid || null,
        pgid: started.pgid || null,
      },
      (error) => {
        if (error) finish(false);
      },
    );
  });
}

function installShutdownController() {
  const controller = new AbortController();
  const handlers = new Map();
  for (const signalName of SUPERVISOR_SIGNALS) {
    const handler = () => controller.abort();
    handlers.set(signalName, handler);
    process.once(signalName, handler);
  }
  return {
    controller,
    cleanup() {
      for (const [signalName, handler] of handlers) {
        process.off(signalName, handler);
      }
    },
  };
}

async function readRequest() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 512 * 1024) throw new Error("supervisor_request_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function evaluateTerminal(context, result) {
  if (result?.status !== "success") return result;
  const evaluated = evaluateExactResumeOutput(
    context.runtime,
    result.stdout,
    context.sessionId,
  );
  return evaluated.ok
    ? { ...result, ...evaluated }
    : { ...result, status: "failure", error: evaluated.error };
}

async function waitForDispatchDecision(context) {
  const deadline = Date.now() + DISPATCH_SETTLE_MS;
  async function poll() {
    const state = getTransportState(context.scope, context.messageId);
    if (
      state?.dispatch_detail?.resume_id === context.resumeId &&
      state.dispatch_decision
    ) {
      return;
    }
    if (Date.now() >= deadline) return;
    await sleep(20);
    await poll();
  }
  await poll();
}

async function persistTerminal(context, result) {
  if (!context?.scope || !context?.messageId) return;
  const failed = result?.status !== "success";
  if (failed) await waitForDispatchDecision(context);
  const at = new Date().toISOString();
  mutateTransportState(context.scope, context.messageId, (prior) => {
    const lifecycle = prior.tldr_agent_inbound || {};
    const terminal = {
      direct_resume_terminal_state: failed ? "failure" : "success",
      direct_resume_terminal_error: result?.error || null,
      direct_resume_terminal_at: at,
      direct_resume_terminal_resume_id: context.resumeId,
    };
    if (!failed) {
      return {
        ...terminal,
        tldr_agent_inbound: {
          ...lifecycle,
          state: "reply_pending",
          updated_at: at,
          terminal: {
            state: "presented",
            decision: prior.dispatch_decision || "resumed_pid_dead",
            at,
          },
        },
      };
    }
    const attempts = (Number(prior.dispatch_attempts) || 0) + 1;
    const nextRetryAt = new Date(Date.now() + RETRY_DELAY_MS).toISOString();
    return {
      ...terminal,
      dispatch_decision: "resume_start_failed",
      dispatch_decided_at: at,
      dispatch_detail: {
        ...(prior.dispatch_detail || {}),
        invoke_ok: false,
        invoke_error: result?.error || "resume_terminal_failed",
        process_started: true,
        resume_id: context.resumeId,
        session_id: context.sessionId,
      },
      dispatch_attempts: attempts,
      dispatch_next_retry_at: nextRetryAt,
      inbound_terminal_state: null,
      inbound_terminal_reason: result?.error || "resume_terminal_failed",
      inbound_terminal_at: at,
      tldr_agent_inbound: {
        ...lifecycle,
        state: "retry_wait",
        updated_at: at,
        attempt_count: (Number(lifecycle.attempt_count) || 0) + 1,
        next_retry_at: nextRetryAt,
        last_error_code: result?.error || "resume_terminal_failed",
        terminal: null,
      },
    };
  });
}

function recordStarted(context, started) {
  if (!context?.scope || !context?.messageId) return;
  const at = new Date().toISOString();
  mutateTransportState(context.scope, context.messageId, (prior) => ({
    direct_resume_terminal_state: "running",
    direct_resume_terminal_error: null,
    direct_resume_terminal_at: null,
    direct_resume_terminal_resume_id: context.resumeId,
    tldr_agent_inbound: {
      ...(prior.tldr_agent_inbound || {}),
      version: 1,
      state: "reply_pending",
      updated_at: at,
      presentation: {
        state: "resume_started",
        at,
        session_id: context.sessionId,
        runtime: context.runtime || null,
        resume_id: context.resumeId,
        pid: started.pid || null,
      },
    },
  }));
}

async function main() {
  let request;
  try {
    request = await readRequest();
  } catch (error) {
    sendStartup({ status: "failure", error: error?.message || String(error) });
    return;
  }
  const shutdown = installShutdownController();
  const started = await superviseControlledProcess({
    ...request.process,
    stdinText: request.stdinText,
    signal: shutdown.controller.signal,
  });
  if (started.status !== "started") {
    shutdown.cleanup();
    sendStartup({
      status: "failure",
      error: started.error || "runtime_start_failed",
      stdout: started.stdout || "",
      stderr: started.stderr || "",
    });
    return;
  }
  const ownershipAccepted = await sendOwnership(
    started,
    shutdown.controller.signal,
  );
  if (!ownershipAccepted) {
    shutdown.controller.abort();
    await started.terminal;
    shutdown.cleanup();
    return;
  }
  try {
    recordStarted(request.terminalContext, started);
  } catch (error) {
    shutdown.controller.abort();
    await started.terminal;
    shutdown.cleanup();
    sendStartup({
      status: "failure",
      error: error?.message || "resume_start_state_failed",
    });
    return;
  }
  sendStartup({
    status: "started",
    pid: started.pid || null,
    pgid: started.pgid || null,
  });
  const terminal = await started.terminal;
  const final = request.terminalContext
    ? evaluateTerminal(request.terminalContext, terminal)
    : terminal;
  await persistTerminal(request.terminalContext, final);
  shutdown.cleanup();
}

await main().catch((error) => {
  sendStartup({ status: "failure", error: error?.message || String(error) });
  process.exitCode = 1;
});
