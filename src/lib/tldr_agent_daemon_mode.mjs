export const TLDR_AGENT_DAEMON_MODE_ENV = "TLDR_AGENT_DAEMON_MODE";
export const TLDR_AGENT_POLL_ONLY_MODE = "poll-only";

export function isTldrAgentPollOnlyDaemon(environment = process.env) {
  return (
    environment?.[TLDR_AGENT_DAEMON_MODE_ENV] === TLDR_AGENT_POLL_ONLY_MODE
  );
}

export async function runOptionalDeliverySurface({ pollOnly, action }) {
  if (pollOnly) return { action: "skipped", reason: "tldr_agent_poll_only" };
  return action();
}
