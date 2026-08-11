import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  appendActivityEvent,
  maintainTldrAgentDiagnostics,
} from "./tldr_agent_diagnostics.mjs";
import {
  DEFAULT_TLDR_AGENT_CHILD_GRACE_MS,
  DEFAULT_TLDR_AGENT_PHASE_TIMEOUT_MS,
} from "./tldr_agent_daemon_phase_timeouts.mjs";
import { resolveDaemonCommandScope } from "./tldr_agent_daemon_scope.mjs";
import { runDaemonMailSequence } from "./daemon_mail_child_phases.mjs";
import { createInboxPollScheduler } from "./daemon_inbox_poll_scheduler.mjs";
import { helmHome } from "./store.mjs";

function defaultEmailConfigPath() {
  return (
    process.env.HELM_EMAIL_CONFIG_PATH ||
    join(helmHome(), "email", "config.json")
  );
}

function readEmailConfig() {
  try {
    return JSON.parse(readFileSync(defaultEmailConfigPath(), "utf8"));
  } catch {
    return null;
  }
}

function emitInboxPollSchedulerSkip({
  daemonInstanceId,
  targetScope,
  inboxId,
  decision,
}) {
  appendActivityEvent({
    event_type: "daemon_inbox_poll_scheduler",
    daemon_instance_id: daemonInstanceId,
    scope_id: targetScope?.scope_id || null,
    cwd: targetScope?.cwd || null,
    metadata: {
      skipped: true,
      reason: decision?.reason || "poll_skipped",
      inbox_id: inboxId,
    },
  });
}

function phaseTimeoutError(name) {
  const error = new Error(`tldr; daemon phase timed out: ${name}`);
  error.code = "daemon_phase_timeout";
  return error;
}

function phaseCleanupTimeoutError(name) {
  const error = new Error(`tldr; daemon phase cleanup timed out: ${name}`);
  error.code = "daemon_phase_cleanup_timeout";
  return error;
}

export async function runTldrAgentDaemonPhase({
  name,
  timeoutMs,
  cleanupGraceMs = DEFAULT_TLDR_AGENT_CHILD_GRACE_MS,
  parentSignal = null,
  fn,
} = {}) {
  const controller = new AbortController();
  let resolveParentAbort;
  const parentAbort = new Promise((resolveAbort) => {
    resolveParentAbort = resolveAbort;
  });
  const forwardAbort = () => {
    const error = parentSignal?.reason || new Error("daemon phase aborted");
    controller.abort(error);
    resolveParentAbort({ kind: "aborted", error });
  };
  if (parentSignal?.aborted) forwardAbort();
  else parentSignal?.addEventListener?.("abort", forwardAbort, { once: true });
  let timer = null;
  let cleanupTimer = null;
  try {
    const operation = Promise.resolve().then(() =>
      fn({ signal: controller.signal, heartbeat: () => {} }),
    );
    const completion = operation.then(
      (result) => ({ kind: "fulfilled", result }),
      (error) => ({ kind: "rejected", error }),
    );
    const timeout = new Promise((resolveTimeout) => {
      timer = setTimeout(() => {
        const error = phaseTimeoutError(name);
        controller.abort(error);
        resolveTimeout({ kind: "timed_out", error });
      }, timeoutMs);
    });
    const first = await Promise.race([completion, timeout, parentAbort]);
    if (first.kind === "fulfilled") {
      return { ok: true, phase: name, result: first.result };
    }
    if (first.kind === "rejected") throw first.error;

    const cleanupExpired = new Promise((resolveCleanup) => {
      cleanupTimer = setTimeout(
        () => resolveCleanup({ kind: "cleanup_expired" }),
        cleanupGraceMs,
      );
    });
    const cleanup = await Promise.race([completion, cleanupExpired]);
    if (cleanup.kind === "cleanup_expired") {
      throw phaseCleanupTimeoutError(name);
    }
    const error = first.error;
    return {
      ok: false,
      phase: name,
      error: error?.message || String(error),
      cause: error?.code || "daemon_phase_failed",
      timed_out: error?.code === "daemon_phase_timeout",
    };
  } catch (error) {
    if (error?.code === "daemon_phase_cleanup_timeout") throw error;
    return {
      ok: false,
      phase: name,
      error: error?.message || String(error),
      cause: error?.code || "daemon_phase_failed",
      timed_out: error?.code === "daemon_phase_timeout",
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (cleanupTimer) clearTimeout(cleanupTimer);
    parentSignal?.removeEventListener?.("abort", forwardAbort);
  }
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

export async function runTldrAgentDaemonLoop({
  schedulerScriptPath,
  intervalSec = 10,
  once = false,
  home = helmHome(),
  scope = resolveDaemonCommandScope({ cwd: home, tldrAgentHome: home }),
  homeExists = existsSync,
  runMailSequence = runDaemonMailSequence,
  maintainDiagnostics = maintainTldrAgentDiagnostics,
  phaseTimeoutMs = Number(
    process.env.HELM_DAEMON_PHASE_TIMEOUT_MS ||
      DEFAULT_TLDR_AGENT_PHASE_TIMEOUT_MS,
  ),
} = {}) {
  if (!homeExists(home)) return [];
  const daemonInstanceId = `tldr_agent_daemon_${process.pid}_${Date.now()}`;
  const inboxPollScheduler = createInboxPollScheduler();
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let lastResults = [];
  try {
    do {
      // eslint-disable-next-line no-await-in-loop -- one ordered mail lifecycle owns each daemon tick.
      const sequence = await runMailSequence({
        runPhase: (name, fn, timeoutMs) =>
          runTldrAgentDaemonPhase({ name, fn, timeoutMs }),
        scopes: [scope],
        schedulerScriptPath,
        daemonInstanceId,
        phaseTimeoutMs,
        defaultEmailConfigPath,
        readEmailConfig,
        inboxPollScheduler,
        emitInboxPollSchedulerSkip,
        appendActivityEvent,
        nowMs: Date.now,
      });
      lastResults = sequence.phaseResults;
      try {
        maintainDiagnostics({ home });
      } catch {
        // Diagnostics are best effort and must never block mail delivery.
      }
      if (!once && !stopped) {
        // eslint-disable-next-line no-await-in-loop -- the next tick starts only after the configured cadence.
        await wait(Math.max(1, Number(intervalSec)) * 1000);
      }
    } while (!once && !stopped && homeExists(home));
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
  return lastResults;
}
