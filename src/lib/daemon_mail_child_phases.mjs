import {
  tldrAgentParentPhaseTimeout,
  tldrAgentPhaseTimeout,
  runSequentialTldrAgentMailPhases,
} from "./tldr_agent_daemon_phase_timeouts.mjs";
import { writeTldrAgentDaemonPollHealth } from "./tldr_agent_daemon_health.mjs";
import { runInboxPollChildPhase } from "./daemon_inbox_poll_phase.mjs";

export { runInboxPollChildPhase } from "./daemon_inbox_poll_phase.mjs";

// The daemon has one channel bridge phase. Routine message dispatch and reply
// obligations are Tightbeam-owned and intentionally have no local child phase.
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
  const childTimeout = tldrAgentPhaseTimeout("inbox_poll", { phaseTimeoutMs });
  const parentTimeout = tldrAgentParentPhaseTimeout("inbox_poll", {
    phaseTimeoutMs,
  });
  const startedMs = nowMs();
  const phaseResults = await runSequentialTldrAgentMailPhases({
    runPhase,
    phases: {
      inbox_poll: {
        timeoutMs: parentTimeout,
        run: ({ signal }) =>
          runInboxPollChildPhase({
            scopes,
            schedulerScriptPath,
            daemonInstanceId,
            signal,
            childTimeoutMs: childTimeout,
            defaultEmailConfigPath,
            readEmailConfig,
            inboxPollScheduler,
            emitInboxPollSchedulerSkip,
            appendActivityEvent,
          }),
      },
    },
  });
  const poll = phaseResults.find(
    (entry) => entry.phase === "inbox_poll",
  )?.result;
  let health = null;
  try {
    health = recordPollHealth({
      home: scopes[0]?.storage_root || scopes[0]?.cwd,
      poll,
      dispatcher: null,
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
    phaseTimeouts: { inbox_poll: parentTimeout },
    health,
  };
}
