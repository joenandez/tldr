import { SlackApiError, abortError } from "./slack_api.mjs";
import { writeBackoff } from "./slack_delivery_claim.mjs";
import {
  TIER_ECHO_BACKOFF_MS,
  echoesTier,
  tierEchoWarning,
} from "./tier_echo.mjs";

// The delivery.release outcome tightbeam excludes from attempt counting and backoff.
export const UNSENT_OUTCOME = "aborted_unsent";

// How a failed attempt settles: `aborted_unsent` first, before any terminal failure, so an
// abort that cut an awaited pre-write step short (sender lookup, target resolution) cannot
// read as that step's permanent failure. Only a failure that cannot heal is final: a cut
// overflow keeps its receipt and resumes on retry (ac-jfv.59).
export function failureOutcome(ctx, error) {
  if (ctx.signal?.aborted && !ctx.sent) return UNSENT_OUTCOME;
  const permanent = error instanceof SlackApiError && error.permanent;
  return permanent ? "failed" : "released";
}

// The bound of one settle call. The user-route lanes bound it shorter than the normal 30 s
// (ac-jfv.74.1). On those lanes a complete runs to the lease end: Tightbeam accepts it until then
// (claim_expired after), and a killed complete leaves a posted reply undelivered (ac-jfv.81).
// Trade-off: the next answer waits up to the rest of the lease (~20 s), not 8 s. The end is read
// from lease_expires_at, capped at the lane's lease length so a bad value does not stretch it;
// this host's clock against Tightbeam's can skew it, so a complete may still run past the real
// lease end or be cut short of it. With less lease left than settleMs the complete is bound by
// what is left (it is refused after, and the re-offer completes it from the receipt). A lease
// that is over, missing or invalid (NaN) leaves the settle bound. The outbound lane (no settleMs)
// keeps the CLI's 30 s default.
function settleBound(ctx, claim, untilLease) {
  if (!untilLease || ctx.settleMs === undefined) return ctx.settleMs;
  const leaseLeft = Math.min(
    Date.parse(claim.lease_expires_at) - Date.now(),
    ctx.leaseMs ?? 0,
  );
  return leaseLeft > 0 ? leaseLeft : ctx.settleMs;
}

// Returns null on success, else a failure result (logged, never thrown).
async function settle({ ctx, claim, call, event, extra, untilLease }) {
  const { delivery_id, token } = claim;
  ctx.onSettling?.(); // the post is done: this task no longer holds a send slot
  const timeoutMs = settleBound(ctx, claim, untilLease);
  const result = await ctx.channel[call]({
    delivery_id,
    token,
    ...extra,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  if (result?.ok === true) return null;
  ctx.logger({
    event,
    status: "error",
    params: { delivery_id },
    result: { code: result?.code ?? null },
  });
  // held_until: the claim stays leased until then (retry_wake), however the settle call ended.
  return {
    ok: false,
    delivery_id,
    error: result?.code ?? event,
    held_until: claim.lease_expires_at,
  };
}

export const complete = (ctx, claim, outcome) =>
  settle({
    ctx,
    claim,
    call: "completeSlackDelivery",
    event: "slack_delivery_complete_failed",
    extra: { outcome },
    untilLease: true,
  });

export const release = (ctx, claim, extra) =>
  settle({
    ctx,
    claim,
    call: "releaseSlackDelivery",
    event: "slack_delivery_release_failed",
    extra,
  });

// The phase ended before any Slack request of this claim started: nothing can
// be on Slack, so the release says so (the attempt does not count) and no
// adapter backoff is written. Tightbeam offers the delivery again next tick.
export async function releaseUnsent(ctx, claim, error) {
  const bad = await release(ctx, claim, { outcome: UNSENT_OUTCOME });
  ctx.logger({
    event: "slack_delivery_abort_released",
    status: bad ? "error" : "ok",
    params: {
      delivery_id: claim.delivery_id,
      cause: ctx.signal.reason?.code ?? error.slackError ?? null,
    },
    result: {
      outcome: UNSENT_OUTCOME,
      counted: false,
      release: bad ? bad.error : "released",
    },
  });
  // A non-Slack error is not an abort result: surface it as before.
  if (!(error instanceof SlackApiError)) throw error;
  return (
    bad ?? {
      ok: false,
      delivery_id: claim.delivery_id,
      error: "aborted",
      retryable: true,
      released: true,
    }
  );
}

// A wait before the first Slack write ends when the phase aborts (it rejects), so the claim
// is released inside the phase's cleanup grace; the wait itself runs on unobserved.
// stillWaiting: false once the write has begun, which only its own signal handling may cut.
export function beforeWrite(ctx, wait, stillWaiting = () => true) {
  const { signal } = ctx;
  if (!signal) return wait;
  return new Promise((resolve, reject) => {
    const onAbort = () => stillWaiting() && reject(abortError("claim", signal));
    if (signal.aborted) onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    wait
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

// The claim did not echo the lane's tier (tier_echo.mjs): nothing was sent, so the release says so
// (the attempt does not count), the lane's own backoff file holds the next claims for one period,
// and the warn is logged here only, so once per period rather than per poll.
export async function releaseUnechoed(ctx, claim) {
  const bad = await release(ctx, claim, { outcome: UNSENT_OUTCOME });
  writeBackoff(ctx, TIER_ECHO_BACKOFF_MS);
  ctx.logger(tierEchoWarning(ctx.tier, claim));
  return bad ?? { ok: false, code: "tier_filter_not_echoed", released: true };
}

// The claim, kept only when it echoes the lane's tier; otherwise it is released unsent and the
// result is the failure the adapter hands back.
export async function claimEchoed(ctx, claimDelivery) {
  const claimed = await claimDelivery(ctx);
  return claimed?.ok === true && !echoesTier(ctx.tier, claimed.claim)
    ? releaseUnechoed(ctx, claimed.claim)
    : claimed;
}
