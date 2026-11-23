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

// Returns null on success, else a failure result (logged, never thrown).
async function settle({ ctx, claim, call, event, extra }) {
  const { delivery_id, token } = claim;
  // The user-route lanes bound their settle call shorter than the normal 30 s (ac-jfv.74.1).
  const result = await ctx.channel[call]({
    delivery_id,
    token,
    ...extra,
    ...(ctx.settleMs ? { timeoutMs: ctx.settleMs } : {}),
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
