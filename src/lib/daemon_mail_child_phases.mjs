import {
  runInboxDispatchChild,
  runReplyObligationChild,
} from "./daemon_child_commands.mjs";
import {
  tldrAgentParentPhaseTimeout,
  tldrAgentPhaseTimeout,
  runSequentialTldrAgentMailPhases,
} from "./tldr_agent_daemon_phase_timeouts.mjs";
import {
  summarizeTldrAgentDispatchHealth,
  writeTldrAgentDaemonPollHealth,
} from "./tldr_agent_daemon_health.mjs";
import { runInboxPollChildPhase } from "./daemon_inbox_poll_phase.mjs";

export { runInboxPollChildPhase } from "./daemon_inbox_poll_phase.mjs";

export async function runDaemonMailSequence({
  runPhase,
  scopes,
  schedulerScriptPath,
  daemonInstanceId,
  phaseTimeoutMs,
  defaultEmailConfigPath,
  readEmailConfig,
  inboxPollScheduler,
  emitInboxPollSchedulerSkip,
  appendActivityEvent,
  nowMs,
  recordPollHealth = writeTldrAgentDaemonPollHealth,
}) {
  const childTimeout = (name) =>
    tldrAgentPhaseTimeout(name, { phaseTimeoutMs });
  const parentTimeout = (name) =>
    tldrAgentParentPhaseTimeout(name, { phaseTimeoutMs });
  const startedMs = nowMs();
  const phaseTimeouts = {
    inbox_poll: parentTimeout("inbox_poll"),
    reply_obligation_sla: parentTimeout("reply_obligation_sla"),
    comms_dispatcher: parentTimeout("comms_dispatcher"),
  };
  const phaseResults = await runSequentialTldrAgentMailPhases({
    runPhase,
    phases: {
      inbox_poll: {
        timeoutMs: phaseTimeouts.inbox_poll,
        run: ({ signal }) =>
          runInboxPollChildPhase({
            scopes,
            schedulerScriptPath,
            daemonInstanceId,
            signal,
            childTimeoutMs: childTimeout("inbox_poll"),
            defaultEmailConfigPath,
            readEmailConfig,
            inboxPollScheduler,
            emitInboxPollSchedulerSkip,
            appendActivityEvent,
          }),
      },
      reply_obligation_sla: {
        timeoutMs: phaseTimeouts.reply_obligation_sla,
        run: async ({ signal }) => {
          const child = await runReplyObligationChild({
            schedulerScriptPath,
            scope: scopes[0],
            daemonInstanceId,
            signal,
            timeoutMs: childTimeout("reply_obligation_sla"),
          });
          if (!child.ok) {
            throw new Error(child.error || "reply obligation SLA child failed");
          }
          return child.data?.result || child.data || null;
        },
      },
      comms_dispatcher: {
        timeoutMs: phaseTimeouts.comms_dispatcher,
        run: ({ heartbeat, signal }) =>
          runCommsDispatcherChildPhase({
            scopes,
            schedulerScriptPath,
            daemonInstanceId,
            signal,
            childTimeoutMs: childTimeout("comms_dispatcher"),
            heartbeat,
            appendActivityEvent,
          }),
      },
    },
  });
  const poll = phaseResults.find(
    (entry) => entry.phase === "inbox_poll",
  )?.result;
  const dispatcher = phaseResults.find(
    (entry) => entry.phase === "comms_dispatcher",
  )?.result;
  let health = null;
  try {
    health = recordPollHealth({
      home: scopes[0]?.storage_root || scopes[0]?.cwd,
      poll,
      dispatcher,
      now: new Date(nowMs()).toISOString(),
    });
  } catch (err) {
    process.stderr.write(
      `tldr-agent daemon poll health write failed: ${err?.message || String(err)}\n`,
    );
  }
  return {
    durationMs: Math.max(0, nowMs() - startedMs),
    phaseResults,
    phaseTimeouts,
    health,
  };
}

export async function runCommsDispatcherChildPhase({
  scopes,
  schedulerScriptPath,
  daemonInstanceId,
  signal,
  childTimeoutMs,
  heartbeat,
  appendActivityEvent,
  runInboxDispatch = runInboxDispatchChild,
}) {
  if (scopes.length === 0) {
    return {
      action: "skipped",
      reason: "no_registered_scopes",
      scope_count: 0,
      pending_count: 0,
      decision_count: 0,
    };
  }
  heartbeat({ scope_count: scopes.length });
  try {
    const child = await runInboxDispatch({
      schedulerScriptPath,
      scope: scopes[0],
      daemonInstanceId,
      signal,
      timeoutMs: childTimeoutMs,
    });
    if (!child.ok)
      throw new Error(child.error || "inbox dispatch child failed");
    const results = Array.isArray(child.data?.results)
      ? child.data.results
      : child.data?.result
        ? [child.data.result]
        : [];
    const dispatchHealth = summarizeTldrAgentDispatchHealth(results);
    for (const result of results) {
      if (!result?.decisions?.length) continue;
      appendActivityEvent({
        event_type: "comms_dispatcher_tick",
        daemon_instance_id: daemonInstanceId,
        scope_id: result.scope_id || null,
        cwd: result.cwd || null,
        metadata: {
          pending_count: result.pending_count,
          decisions: result.decisions,
        },
      });
    }
    return { ...dispatchHealth, scope_count: scopes.length };
  } catch (err) {
    process.stderr.write(
      `helm daemon comms dispatcher failed: ${err.message}\n`,
    );
    appendActivityEvent({
      event_type: "comms_dispatcher_tick_failed",
      daemon_instance_id: daemonInstanceId,
      metadata: { error: err.message },
    });
    return {
      action: "failed",
      reason: err?.message || String(err),
      scope_count: scopes.length,
      pending_count: 0,
      decision_count: 0,
    };
  }
}

export const _internals = {
  summarizeDispatchHealth: summarizeTldrAgentDispatchHealth,
};
