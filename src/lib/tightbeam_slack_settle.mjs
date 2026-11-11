import { SlackApiError, abortError } from "./slack_api.mjs";

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
  const result = await ctx.channel[call]({ delivery_id, token, ...extra });
  if (result?.ok === true) return null;
  ctx.logger({
    event,
    status: "error",
    params: { delivery_id },
    result: { code: result?.code ?? null },
  });
  return { ok: false, delivery_id, error: result?.code ?? event };
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
