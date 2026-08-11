export const DEFAULT_TLDR_AGENT_PHASE_TIMEOUT_MS = 5000;
export const DEFAULT_TLDR_AGENT_CHILD_GRACE_MS = 5000;
export const TLDR_AGENT_MAIL_PHASE_SEQUENCE = Object.freeze([
  "inbox_poll",
  "reply_obligation_sla",
  "comms_dispatcher",
]);

function numericTimeout(value, fallback) {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : fallback;
}

export function tldrAgentPhaseTimeout(
  _name,
  { phaseTimeoutMs = DEFAULT_TLDR_AGENT_PHASE_TIMEOUT_MS } = {},
) {
  return numericTimeout(phaseTimeoutMs, DEFAULT_TLDR_AGENT_PHASE_TIMEOUT_MS);
}

export function tldrAgentParentPhaseTimeout(
  name,
  {
    phaseTimeoutMs = DEFAULT_TLDR_AGENT_PHASE_TIMEOUT_MS,
    cleanupGraceMs = process.env.HELM_DAEMON_CHILD_PHASE_PARENT_GRACE_MS,
  } = {},
) {
  return (
    tldrAgentPhaseTimeout(name, { phaseTimeoutMs }) +
    numericTimeout(cleanupGraceMs, DEFAULT_TLDR_AGENT_CHILD_GRACE_MS)
  );
}

export async function runSequentialTldrAgentMailPhases({
  runPhase,
  phases,
} = {}) {
  if (typeof runPhase !== "function") {
    throw new Error("runSequentialTldrAgentMailPhases requires runPhase");
  }
  const results = [];
  for (const name of TLDR_AGENT_MAIL_PHASE_SEQUENCE) {
    const phase = phases?.[name];
    if (!phase || typeof phase.run !== "function") {
      throw new Error(`missing tldr; mail phase runner: ${name}`);
    }
    // eslint-disable-next-line no-await-in-loop -- mail phases share one ordered lifecycle lane.
    results.push(await runPhase(name, phase.run, phase.timeoutMs));
  }
  return results;
}
