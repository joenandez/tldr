import { AUTH_ERRORS, SlackApiError, findMarkedPost } from "./slack_api.mjs";
import { timed } from "./slack_delivery_claim.mjs";
import { TLDR_AGENT_SLACK_LOOKUP_MS } from "./tldr_agent_daemon_phase_timeouts.mjs";

// A lost channel is the caller's to recreate; any other failed look is only a try again.
export const LOST_CHANNEL_ERRORS = new Set([
  "channel_not_found",
  "is_archived",
]);
// Posts are searched for from ten minutes before the send: a margin for clock skew and for
// a daemon that died mid-post and came back later.
const LOOKUP_MARGIN_S = 600;
// Where a search for a post starts: the earlier try's start (else now), less the margin.
// `??`, not a default parameter: a first try passes null, and null - 600 is a negative ts.
export const lookupOldest = (startedAt) =>
  ((startedAt ?? Date.now() / 1000) - LOOKUP_MARGIN_S).toFixed(6);
// A look that can never succeed (a missing scope, a dead token) fails the delivery with that
// code instead of being retried for ever.
const NEVER_HEALS = new Set([...AUTH_ERRORS, "missing_scope"]);

// A look gets its own window; `outer` also ends it (the tick's signal, for a look before a send).
// After a send the deadline that cut it must not cut the look, so that look passes no outer.
const lookWindow = (outer) =>
  AbortSignal.any(
    [AbortSignal.timeout(TLDR_AGENT_SLACK_LOOKUP_MS), outer].filter(Boolean),
  );

// Look for a post by its marker. A failed look is retryable, never final: the delivery is
// released with backoff and the retry looks again before it sends.
export async function lookup(ctx, args, outer) {
  try {
    return await timed(ctx, "lookup_ms", () =>
      findMarkedPost(args, { ...ctx.slackOpts, signal: lookWindow(outer) }),
    );
  } catch (error) {
    ctx.logger({
      event: "slack_post_lookup_failed",
      status: "warn",
      params: { channel: args.channel, marker: args.marker },
      result: { slack_error: error.slackError ?? null },
    });
    if (
      LOST_CHANNEL_ERRORS.has(error.slackError) ||
      (error.permanent && NEVER_HEALS.has(error.slackError))
    )
      throw error;
    throw new SlackApiError({
      method:
        error.method ??
        (args.thread_ts ? "conversations.replies" : "conversations.history"),
      slackError: error.slackError ?? "post_lookup_failed",
      httpStatus: error.httpStatus,
      retryable: true,
      retryAfterMs: error.retryAfterMs,
    });
  }
}

// The stored place an earlier try's root is in, or null. A lost channel holds nothing to find.
export async function earlierRootTarget(ctx, attempt) {
  const marker = `${ctx.deliveryId}:1`;
  const oldest = lookupOldest(attempt.startedAt);
  for (const { channelId, threadTs, note } of attempt.targets) {
    const look = {
      channel: channelId,
      thread_ts: threadTs ?? undefined,
      marker,
      oldest,
    };
    try {
      // eslint-disable-next-line no-await-in-loop -- one place at a time, in the order tried.
      if (await lookup(ctx, look, ctx.signal))
        return { channelId, threadTs: threadTs ?? undefined, note };
    } catch (error) {
      if (!LOST_CHANNEL_ERRORS.has(error.slackError)) throw error;
    }
  }
  return null;
}
