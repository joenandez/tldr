import { existsSync } from "node:fs";

import { isTldrAgentPollOnlyDaemon } from "./tldr_agent_daemon_mode.mjs";
import { runInboxPollChild } from "./daemon_child_commands.mjs";
import { getHelmHome } from "./helm_home.mjs";
import { resolveTldrAgentScope } from "./store.mjs";

function readTldrAgentPollConfigDefault() {
  return Object.freeze({
    inbox_id: "aegis-protected-bound-inbox",
    inbox_email: "aegis-protected-bound-inbox",
  });
}

// Retained poll-child phase extracted from the inherited mail-phase module so
// that module stays within its historical size ratchet.
export async function runInboxPollChildPhase({
  scopes,
  schedulerScriptPath,
  daemonInstanceId,
  signal,
  childTimeoutMs,
  defaultEmailConfigPath,
  readEmailConfig,
  inboxPollScheduler,
  emitInboxPollSchedulerSkip,
  appendActivityEvent,
  runInboxPoll = runInboxPollChild,
  pollOnly = isTldrAgentPollOnlyDaemon(),
  readTldrAgentPollConfig = readTldrAgentPollConfigDefault,
}) {
  const configPath = defaultEmailConfigPath();
  const legacyConfigured = !pollOnly && existsSync(configPath);
  const config = pollOnly
    ? readTldrAgentPollConfig()
    : legacyConfigured
      ? readEmailConfig()
      : null;
  const configured = pollOnly ? Boolean(config) : legacyConfigured;
  const activeScopes =
    scopes.length > 0
      ? scopes
      : pollOnly
        ? [resolveTldrAgentScope({ cwd: getHelmHome() })]
        : [];
  if (!configured || activeScopes.length === 0) {
    return {
      action: "skipped",
      reason: configured ? "no_registered_scopes" : "email_not_configured",
    };
  }
  const targetScope = activeScopes[0];
  const inboxId = config?.inbox_id || config?.inbox_email || null;
  if (!inboxId) {
    appendActivityEvent({
      event_type: "daemon_inbox_poll_scheduler",
      daemon_instance_id: daemonInstanceId,
      scope_id: targetScope.scope_id,
      cwd: targetScope.cwd,
      metadata: { skipped: true, reason: "missing_inbox_key" },
    });
    return { action: "skipped", reason: "missing_inbox_key" };
  }
  const decision = inboxPollScheduler.nextDecision(inboxId);
  if (!decision.shouldPoll && decision.reason === "poll_skipped_in_flight") {
    emitInboxPollSchedulerSkip({
      daemonInstanceId,
      targetScope,
      inboxId,
      decision,
    });
    return {
      action: "skipped",
      reason: "poll_skipped_in_flight",
    };
  }
  if (!decision.shouldPoll) {
    return {
      action: "skipped",
      reason: decision.reason || "poll_not_due",
    };
  }
  return runScheduledPoll({
    inboxId,
    targetScope,
    schedulerScriptPath,
    daemonInstanceId,
    signal,
    childTimeoutMs,
    decision,
    inboxPollScheduler,
    appendActivityEvent,
    runInboxPoll,
  });
}

async function runScheduledPoll({
  inboxId,
  targetScope,
  schedulerScriptPath,
  daemonInstanceId,
  signal,
  childTimeoutMs,
  decision,
  inboxPollScheduler,
  appendActivityEvent,
  runInboxPoll,
}) {
  const startedAt = Date.now();
  const started = inboxPollScheduler.recordPollStarted(inboxId, {
    atMs: startedAt,
    catchUpReason: decision.catchUpReason,
  });
  try {
    const child = await runInboxPoll({
      schedulerScriptPath,
      scope: targetScope,
      daemonInstanceId,
      signal,
      dispatchCaptured: true,
      timeoutMs: childTimeoutMs,
    });
    if (!child.ok) throw new Error(child.error || "inbox poll child failed");
    const data = child.data || {};
    const candidateFound =
      Number(data.fresh || 0) > 0 || Number(data.written || 0) > 0;
    appendActivityEvent({
      event_type: "daemon_inbox_poll_tick",
      daemon_instance_id: daemonInstanceId,
      scope_id: targetScope.scope_id,
      cwd: targetScope.cwd,
      metadata: {
        ok: Boolean(data.ok),
        error: data.error || null,
        fetched: data.fetched ?? 0,
        fresh: data.fresh ?? 0,
        written: data.written ?? 0,
        skipped_duplicates: data.skipped_duplicates ?? 0,
        errors: Array.isArray(data.errors) ? data.errors.length : 0,
        latency_ms: Date.now() - startedAt,
        inbox_id: inboxId,
        next_poll_at: new Date(started.nextPollAtMs).toISOString(),
      },
    });
    return pollResult(data, started, candidateFound);
  } catch (err) {
    process.stderr.write(`helm daemon inbox poll failed: ${err.message}\n`);
    appendActivityEvent({
      event_type: "daemon_inbox_poll_tick_failed",
      daemon_instance_id: daemonInstanceId,
      scope_id: targetScope.scope_id,
      cwd: targetScope.cwd,
      metadata: {
        error: err.message,
        latency_ms: Date.now() - startedAt,
        inbox_id: inboxId,
        next_poll_at: new Date(started.nextPollAtMs).toISOString(),
      },
    });
    return {
      action: "failed",
      reason: err?.message || String(err),
      catch_up_reason: started.catchUpReason || null,
    };
  } finally {
    inboxPollScheduler.recordPollFinished(inboxId);
  }
}

function pollResult(data, started, candidateFound) {
  return {
    action: "polled",
    catch_up_reason: started.catchUpReason || null,
    fetched: Number(data.fetched) || 0,
    fresh: Number(data.fresh) || 0,
    written: Number(data.written) || 0,
    errors: Array.isArray(data.errors) ? data.errors.length : 0,
    candidate_found: candidateFound,
    last_seen_timestamp: data.last_seen_timestamp || null,
    last_polled_at: data.last_polled_at || null,
    next_poll_at: new Date(started.nextPollAtMs).toISOString(),
  };
}
