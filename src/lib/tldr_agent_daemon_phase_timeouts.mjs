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

// The answer Slack lane (tier 1, answers to the user; ac-jfv.74.1): one tick at a time, a short
// lease and its own backoff file. A lost claim returns in `leaseMs`, the post is cut at
// `postTimeoutMs`, and post + look + two settle calls end inside the lease (postBudget), so the
// post keeps its whole 10 s. A `complete` that misses its bound only leaves the delivery to be
// re-offered: the outbound_post receipt then completes it without a second post. A settle call is
// the claim's CLI path: claim measured up to 4.2 s and a notice complete cut at 4.0 s at load
// 120-130 (P0-18, P0-19), so settleMs is 8 s and the lease 30 s (10 + 2 + 2 x 8 = 28).
export const TLDR_AGENT_SLACK_ANSWER = Object.freeze({
  leaseMs: 30_000,
  postTimeoutMs: 10_000,
  lookupMs: 2000,
  settleMs: 8000,
});

// The notice Slack lane (tier 0, busy and resume_failed notices): a notice is due 120 s after the
// user's message, plus <= 1 s sweep and <= 1 s watermark poll, and must reach the user inside
// 2:15 (135 s). That leaves 13 s for claim + send: the post is cut at 8 s and the claim CLI is
// killed at the lease, so claim (~2 s measured at load 100+) + post fit with margin. Post + look
// + two settle calls end inside the lease (postBudget), so the post keeps its whole 8 s (8 + 2 +
// 2 x 8 = 26 of 30; settleMs as for the answer lane).
export const TLDR_AGENT_SLACK_NOTICE = Object.freeze({
  leaseMs: 30_000,
  postTimeoutMs: 8000,
  lookupMs: 2000,
  settleMs: 8000,
});

// Claim (its CLI is killed at the lease) + post + look + one settle call, as the normal phase.
const slackLanePhaseTimeout = ({
  leaseMs,
  postTimeoutMs,
  lookupMs,
  settleMs,
}) => leaseMs + postTimeoutMs + lookupMs + settleMs;
export const tldrAgentSlackAnswerPhaseTimeout = () =>
  slackLanePhaseTimeout(TLDR_AGENT_SLACK_ANSWER);
export const tldrAgentSlackNoticePhaseTimeout = () =>
  slackLanePhaseTimeout(TLDR_AGENT_SLACK_NOTICE);

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

// The answer EMAIL lane (tier 1; ac-jfv.74.1) drains the answers to the user in its own short
// child, one tick at a time. One drain is claim + one send + complete. The Aegis send is bounded
// at 25 s and the complete is a Tightbeam CLI call, so a send and its complete (40 s) are what the
// drain must have left before it claims again. A child cut off mid-send is safe: the delivery's
// receipt and provider key stop a second send.
export const TLDR_AGENT_EMAIL_ANSWER = Object.freeze({
  claimMs: 30_000,
  sendMs: 25_000,
  completeMs: 15_000,
});

export const tldrAgentEmailAnswerTimeout = () =>
  TLDR_AGENT_EMAIL_ANSWER.claimMs +
  TLDR_AGENT_EMAIL_ANSWER.sendMs +
  TLDR_AGENT_EMAIL_ANSWER.completeMs;

// The notice EMAIL lane (tier 0) keeps one warm child (email_notice_warm_child.mjs), so a wake is
// one claim CLI call plus the send. Budget as for Slack: 13 s for claim + send inside 2:15. Every
// CLI call the child makes is killed at `cliMs`, and the send is cut at `sendMs` (up to 4 sends at
// once). `claimMs` is the claim stage, preflight aside: a handshake on a loaded daemon is ~33 ms
// of scrypt, so 10 s is a hung call. The Tightbeam lease is its 60 s default: claim + send +
// complete (or release) must fit it. `tickMs` stops new claims in a long drain; `killMs` is the
// parent's hard stop of a wedged child, after the tick's last claim could still send and settle.
export const TIGHTBEAM_DEFAULT_LEASE_MS = 60_000;
export const TLDR_AGENT_EMAIL_NOTICE = Object.freeze({
  cliMs: 10_000,
  sendMs: 8000,
  tickMs: 30_000,
  restartBaseMs: 1000,
  restartMaxMs: 30_000,
  graceMs: 2000,
});
// One claimed notice: its claim CLI, its send, its settle CLI (complete or release).
export const tldrAgentEmailNoticeDeliveryMs = () =>
  TLDR_AGENT_EMAIL_NOTICE.cliMs +
  TLDR_AGENT_EMAIL_NOTICE.sendMs +
  TLDR_AGENT_EMAIL_NOTICE.cliMs;
export const tldrAgentEmailNoticeKillMs = () =>
  TLDR_AGENT_EMAIL_NOTICE.tickMs + tldrAgentEmailNoticeDeliveryMs();
