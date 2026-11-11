// The bridge may validate a reply parent and send through Aegis before it
// polls inbound mail. Its child must outlive the bounded outbound exchange.
export const DEFAULT_TLDR_AGENT_PHASE_TIMEOUT_MS = 35_000;
export const DEFAULT_TLDR_AGENT_CHILD_GRACE_MS = 5000;
// The outbound drain runs on its own lane, so a slow inbound read cannot eat its budget.
export const DEFAULT_TLDR_AGENT_OUTBOUND_TIMEOUT_MS = 120_000;
// One Slack tick (claim and post) has its own deadline instead of the shared phase limit:
// under load the claim handshake alone can pass 35 s, and cutting a post off after Slack
// took it would post it twice (ac-jfv.59). The settle margin covers the complete/release call.
export const DEFAULT_TLDR_AGENT_SLACK_POST_TIMEOUT_MS = 120_000;
export const TLDR_AGENT_SLACK_SETTLE_MS = 30_000;
// A look for a post Slack may hold (conversations.history/replies) gets this long.
export const TLDR_AGENT_SLACK_LOOKUP_MS = 10_000;
// The phase's budget for the claim stage (preflight, route list, claim). It is not a kill: a claim
// CLI killed after Tightbeam committed would orphan the delivery for its lease and count an
// attempt (ac-jfv.59 r6). The post deadline starts only once the claim is in hand.
export const TLDR_AGENT_SLACK_CLAIM_MS = 60_000;
const MAX_TIMER_MS = 2 ** 31 - 1;
// Tightbeam owns reply obligations and dispatch. The tldr; daemon retains only
// the provider-to-channel bridge poll.
export const TLDR_AGENT_MAIL_PHASE_SEQUENCE = Object.freeze(["inbox_poll"]);

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

export function tldrAgentOutboundTimeout({
  outboundTimeoutMs,
  env = process.env,
} = {}) {
  return numericTimeout(
    outboundTimeoutMs ?? env.HELM_DAEMON_OUTBOUND_TIMEOUT_MS,
    DEFAULT_TLDR_AGENT_OUTBOUND_TIMEOUT_MS,
  );
}

export function tldrAgentSlackPostTimeout({
  postTimeoutMs,
  env = process.env,
} = {}) {
  const timeout = numericTimeout(
    postTimeoutMs ?? env.HELM_DAEMON_SLACK_POST_TIMEOUT_MS,
    DEFAULT_TLDR_AGENT_SLACK_POST_TIMEOUT_MS,
  );
  // A whole number of ms (lease_ms must be an integer), and short enough that the phase
  // timer, deadline plus settle, stays under the 2^31-1 ms setTimeout limit.
  return Math.max(
    1,
    Math.min(
      Math.floor(timeout),
      MAX_TIMER_MS -
        TLDR_AGENT_SLACK_CLAIM_MS -
        TLDR_AGENT_SLACK_LOOKUP_MS -
        2 * TLDR_AGENT_SLACK_SETTLE_MS,
    ),
  );
}

// The slack_outbound phase budget: claim, post deadline, a look for a post the deadline cut, and
// the settle call. The phase signal never reaches the post, so an overrun (a claim slower than
// its budget) only stops the lane waiting: the tick runs on under its own deadline, inside a
// lease counted from the claim's commit.
export const tldrAgentSlackOutboundPhaseTimeout = (postTimeoutMs) =>
  TLDR_AGENT_SLACK_CLAIM_MS +
  postTimeoutMs +
  TLDR_AGENT_SLACK_LOOKUP_MS +
  TLDR_AGENT_SLACK_SETTLE_MS;

// The claim outlasts the phase and one more settle call, so a post never outlives its claim
// and gets claimed twice. Tightbeam's default lease is 60 s. Trade-off: a claim orphaned by a
// daemon crash (or a claim CLI killed after it committed) now waits this lease (~250 s) before
// Tightbeam offers it again, not 60 s. The outbound tick ignores the phase signal, so a
// shutdown (or --once) can wait up to its phase (~220 s) for a post in flight.
export const tldrAgentSlackClaimLease = (postTimeoutMs) =>
  tldrAgentSlackOutboundPhaseTimeout(postTimeoutMs) +
  TLDR_AGENT_SLACK_SETTLE_MS;

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
