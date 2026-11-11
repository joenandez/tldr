import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { abortError } from "./slack_api.mjs";
import {
  TLDR_AGENT_SLACK_LOOKUP_MS,
  TLDR_AGENT_SLACK_SETTLE_MS,
} from "./tldr_agent_daemon_phase_timeouts.mjs";

const isText = (value) => typeof value === "string";
const READ_ONLY_REQUEST = /\/conversations\.(history|replies)$/;

// Every Slack request on the claim path can write (post, channel create, invite): any request
// that actually starts sets state.sent (the attempt may have sent). A request whose signal is
// already aborted never leaves the process.
export const trackedFetch = (state, signal, fetchImpl) => (url, init) => {
  // A look for an earlier post writes nothing: it may run after the deadline that cut a send
  // (the claim's lease covers it), and it does not make the attempt possibly sent (ac-jfv.59).
  if (READ_ONLY_REQUEST.test(String(url)))
    return (fetchImpl ?? globalThis.fetch)(url, init);
  // A continuation that outlived its tick (a late lookup, then invite) must not send: its
  // claim is already released.
  if (signal?.aborted) throw abortError("request", signal, false);
  if (!init?.signal?.aborted) state.sent = true;
  return (fetchImpl ?? globalThis.fetch)(url, init);
};

// Where the time of one delivery went, in ms by stage (ctx.timings), for the tick's diagnostics.
export async function timed(ctx, stage, fn) {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    if (ctx.timings)
      ctx.timings[stage] = (ctx.timings[stage] ?? 0) + Date.now() - started;
  }
}

// The post deadline: a signal that fires postTimeoutMs after start() (called once the claim is in
// hand), or when outer fires. Its reason names the deadline for the diagnostics. Once fired it
// stays aborted, so an adapter serves one tick (the lane builds one per tick).
export function postDeadline(outer, postTimeoutMs) {
  if (!postTimeoutMs) return { signal: outer, start() {}, stop() {} };
  const deadline = new AbortController();
  let timer = null;
  return {
    signal: AbortSignal.any([deadline.signal, outer].filter(Boolean)),
    // budgetMs: what the post may use (postBudget); none left ends it at once, before any send.
    start(budgetMs = postTimeoutMs) {
      const fire = () => {
        const reason = new Error("slack post deadline");
        reason.code = "slack_post_deadline";
        deadline.abort(reason);
      };
      if (!(budgetMs > 0)) {
        fire();
        return;
      }
      timer = setTimeout(fire, budgetMs);
      timer.unref?.();
    },
    stop: () => clearTimeout(timer),
  };
}

// What the post may use: its own deadline, cut so the post, a look and two settle calls end
// inside the claim's lease (ac-jfv.59 r7). The lease is counted from the commit, which comes
// after claimStartedAt, so this bound is safe however late the claim CLI answered.
export function postBudget(
  { postTimeoutMs, leaseMs },
  claimStartedAt,
  now = Date.now(),
) {
  if (!leaseMs) return postTimeoutMs;
  const leaseLeft =
    claimStartedAt +
    leaseMs -
    TLDR_AGENT_SLACK_LOOKUP_MS -
    2 * TLDR_AGENT_SLACK_SETTLE_MS -
    now;
  return Math.min(postTimeoutMs, leaseLeft);
}

// When the claim's lease began, from the expiry Tightbeam answered: the commit, not the moment the
// CLI was started, so a slow claim CLI does not eat the post budget. No usable expiry: fallback.
export function leaseStart(claim, leaseMs, fallback) {
  const expires = Date.parse(claim?.lease_expires_at);
  return leaseMs > 0 && Number.isFinite(expires) ? expires - leaseMs : fallback;
}

export function hasLeaseFields(claim) {
  return isText(claim?.delivery_id) && isText(claim.token);
}

function validMessage(message) {
  return (
    isText(message?.conversation_id) &&
    isText(message.body) &&
    isText(message.sender_principal_id)
  );
}

const hasBinding = (claim) =>
  isText(claim.reply_binding) && claim.reply_binding.length > 0;

export function validClaim(claim) {
  return (
    hasLeaseFields(claim) &&
    isText(claim.message_id) &&
    hasBinding(claim) &&
    validMessage(claim.message)
  );
}

export function messageText(message) {
  const subject = message.metadata?.subject;
  return isText(subject) && subject.length > 0
    ? `*${subject}*\n${message.body}`
    : message.body;
}

// The claim runs before the post deadline starts and is not cut by it: an abandoned claim would
// hold its delivery for its whole lease. Its CLI is killed only at the lease, if it hangs.
export const claimDelivery = (ctx) =>
  ctx.channel.claimSlackDelivery({ leaseMs: ctx.leaseMs });

function backoffUntil(ctx) {
  try {
    return (
      Number(JSON.parse(readFileSync(ctx.backoffPath, "utf8")).notBefore) || 0
    );
  } catch {
    return 0;
  }
}

export function writeBackoff(ctx, ms) {
  mkdirSync(dirname(ctx.backoffPath), { recursive: true });
  writeFileSync(ctx.backoffPath, JSON.stringify({ notBefore: ctx.now() + ms }));
}

// An aborted daemon phase or an active backoff claims nothing.
export function gate(ctx) {
  if (ctx.signal?.aborted) return { ok: false, code: "aborted" };
  const notBefore = backoffUntil(ctx);
  return notBefore > ctx.now()
    ? { ok: false, code: "backoff", retry_at: notBefore }
    : null;
}
