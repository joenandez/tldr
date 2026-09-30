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
    if (!child.ok) {
      // A tick can fail after inbound mail was already polled (an outbound
      // failure is reported last); its envelope still carries those counts.
      throw Object.assign(new Error(child.error || "inbox poll child failed"), {
        code: child.error_code || null,
        // The diagnostics allowlist drops unknown child codes and stderr goes
        // to /dev/null, so this class is what records why a tick failed.
        reasonCode: child.timed_out
          ? "poll_child_timeout"
          : child.abort_source
            ? "poll_child_aborted"
            : "poll_child_failed",
        inbound: child.data?.inbound || null,
        outbound: child.data?.outbound || null,
      });
    }
    const data = child.data || {};
    // pollChannel nests the inbound counts beside the outbound result.
    const inbound = data.inbound || {};
    const candidateFound =
      Number(inbound.fresh || 0) > 0 || Number(inbound.written || 0) > 0;
    appendActivityEvent({
      event_type: "daemon_inbox_poll_tick",
      daemon_instance_id: daemonInstanceId,
      scope_id: targetScope.scope_id,
      cwd: targetScope.cwd,
      metadata: {
        ok: Boolean(inbound.ok),
        error: inbound.error || null,
        fetched: inbound.fetched ?? 0,
        fresh: inbound.fresh ?? 0,
        written: inbound.written ?? 0,
        skipped_duplicates: inbound.skipped_duplicates ?? 0,
        errors: Array.isArray(inbound.errors) ? inbound.errors.length : 0,
        latency_ms: Date.now() - startedAt,
        inbox_id: inboxId,
        next_poll_at: new Date(started.nextPollAtMs).toISOString(),
        delivered: data.outbound?.delivered ?? 0,
        failed: data.outbound?.failed ?? 0,
        // Item 41: a read that recovered on its one in-tick retry.
        retried: inbound.list_retries ?? 0,
      },
    });
    return pollResult(inbound, started, candidateFound);
  } catch (err) {
    process.stderr.write(`helm daemon inbox poll failed: ${err.message}\n`);
    appendActivityEvent({
      event_type: "daemon_inbox_poll_tick_failed",
      daemon_instance_id: daemonInstanceId,
      scope_id: targetScope.scope_id,
      cwd: targetScope.cwd,
      error_code: err.code || null,
      reason_code: err.reasonCode || "poll_child_failed",
      metadata: {
        error: err.message,
        latency_ms: Date.now() - startedAt,
        inbox_id: inboxId,
        next_poll_at: new Date(started.nextPollAtMs).toISOString(),
        ...(err.inbound
          ? {
              fetched: err.inbound.fetched ?? 0,
              fresh: err.inbound.fresh ?? 0,
              written: err.inbound.written ?? 0,
              // Item 41: why the inbox read failed (allowlisted enums and
              // numbers; see inboxListFailureCause in transports/email.mjs).
              // Absent keys stay absent: the count projection reads null as 0.
              ...Object.fromEntries(
                ["cause", "broker_code", "bridge_ms", "bridge_exit_code"]
                  .filter((key) => (err.inbound[key] ?? null) !== null)
                  .map((key) => [key, err.inbound[key]]),
              ),
              retried: err.inbound.list_retries ?? 0,
            }
          : {}),
        // Item 49: an outbound failure the tick reports (a failed claim) is
        // counted like any other; its cause wins, as its code is error_code.
        ...(err.outbound
          ? {
              delivered: err.outbound.delivered ?? 0,
              failed: err.outbound.failed ?? 0,
              ...(err.outbound.cause ? { cause: err.outbound.cause } : {}),
            }
          : {}),
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
