import { postMessage } from "./slack_api.mjs";
import { lookup, lookupOldest } from "./slack_post_lookup.mjs";

// Slack cuts a post at 4,000 characters; stay clear of it.
const SLACK_PART_LIMIT = 3900;
// A rate-limited overflow part is retried in place, bounded.
const PART_RETRIES = 2;
const PART_RETRY_WAIT_MS = 1000;
const PART_RETRY_MAX_WAIT_MS = 30000;

// Cut at the last paragraph break, else line break, else hard, within the limit.
function splitForSlack(text) {
  const parts = [];
  let rest = text;
  while (rest.length > SLACK_PART_LIMIT) {
    const [cut, skip] = ["\n\n", "\n"]
      .map((sep) => [rest.lastIndexOf(sep, SLACK_PART_LIMIT), sep.length])
      .find(([at]) => at > 0) ?? [SLACK_PART_LIMIT, 0];
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut + skip);
  }
  parts.push(rest);
  // Slack rejects a blank post (a run of newlines can cut into one).
  return parts.filter((part) => part.trim() !== "");
}

// A post gets longer than a read: under load 10 s would decide it, not the tick's deadline.
// The tick's signal still ends it at the deadline. Used only when no post deadline is set.
export const POST_CALL_TIMEOUT_MS = 60_000;

function recovered(ctx, found, via) {
  ctx.logger({
    event: "slack_post_recovered",
    status: "warn",
    params: { channel: found.channel, via },
    result: { ts: found.ts },
  });
  return { ...found, recovered: true };
}

// The request left and no answer came: Slack may hold the post. Absent now is not final (the
// retry looks again before it sends); a failed look releases the delivery.
async function lostAnswer(ctx, error, look) {
  if (!look || !error.maybeSent) throw error;
  const found = await lookup(ctx, look);
  if (found) return recovered(ctx, found, "after_error");
  throw error;
}

// Sends one part with its marker. A part that may already be in Slack (a retry, a daemon
// that died mid-post, or its own resend) is looked for before it is sent.
function partSender(ctx, channelId) {
  const tried = new Set();
  const oldest = lookupOldest(ctx.priorAttemptAt);
  return async (part, thread_ts, n) => {
    const marker = ctx.deliveryId ? `${ctx.deliveryId}:${n}` : undefined;
    const look = marker
      ? { channel: channelId, thread_ts, marker, oldest }
      : null;
    const maybeThere = typeof ctx.priorAttemptAt === "number" || tried.has(n);
    const earlier =
      look && maybeThere ? await lookup(ctx, look, ctx.signal) : null;
    if (earlier) return recovered(ctx, earlier, "before_send");
    tried.add(n);
    try {
      return await postMessage(
        { channel: channelId, text: part, thread_ts, marker },
        {
          // A slow root post may use the whole deadline: cutting it sooner only delays it.
          timeoutMs:
            ctx.postCallTimeoutMs ?? ctx.postTimeoutMs ?? POST_CALL_TIMEOUT_MS,
          ...ctx.slackOpts,
        },
      );
    } catch (error) {
      return lostAnswer(ctx, error, look);
    }
  };
}

// The wait before retrying a transient failure, or null to give up.
// An aborted phase never retries: a part may not post after the phase ends.
function retryWait(error, attempt, signal) {
  const waitMs = error.retryAfterMs ?? PART_RETRY_WAIT_MS;
  const ok = error.retryable && attempt <= PART_RETRIES && !signal?.aborted;
  return ok && waitMs <= PART_RETRY_MAX_WAIT_MS ? waitMs : null;
}

async function retryPart(ctx, part, sendPart) {
  for (let n = 1; ; n += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential by design.
      return await sendPart();
    } catch (error) {
      const waitMs = retryWait(error, n, ctx.signal);
      if (waitMs === null) throw error;
      const params = { part, attempt: n, retry_after_ms: waitMs };
      ctx.logger({
        event: "slack_delivery_part_retry",
        status: "warn",
        params,
      });
      // An aborted tick ends the wait: the failure that caused it is what gets released.
      // eslint-disable-next-line no-await-in-loop -- sequential by design.
      await ctx.sleep(waitMs).catch(() => {
        throw error;
      });
    }
  }
}

// The overflow as replies in the root's thread, in order. A failed part carries `partial`:
// the root is posted and `sent` parts are out, so a retry resumes after them.
async function sendOverflow(ctx, send, place) {
  const { channelId, threadTs, root, overflow, sent } = place;
  for (const [i, part] of overflow.entries()) {
    // Part i + 2 is out already when a resume says `sent` parts are.
    if (i + 2 <= sent) continue;
    try {
      // eslint-disable-next-line no-await-in-loop -- replies must stay in order.
      await retryPart(ctx, i + 2, () => send(part, threadTs ?? root.ts, i + 2));
    } catch (error) {
      error.partial = {
        channelId,
        ts: root.ts,
        threadTs,
        sent: i + 1,
        late: root.recovered,
      };
      throw error;
    }
  }
}

// One root plus the overflow as replies in its thread, so one thread root maps
// the whole message. A failed later part carries `partial`: the root is posted.
// ctx.onRoot, if given, runs once the root lands, before any overflow part. It is
// not awaited: its network calls must never delay the caller's durable receipt.
// It must not throw or reject.
// target.resume ({ ts, sent }): the root and its first `sent` parts are out; send the rest.
export async function postInParts(ctx, target, text) {
  const { channelId, threadTs, resume } = target;
  const rendered = Date.now();
  const [first, ...overflow] = splitForSlack(text);
  if (ctx.timings) ctx.timings.render_ms = Date.now() - rendered;
  const send = partSender(ctx, channelId);
  const root = resume ?? (await send(first, threadTs, 1));
  if (!resume) ctx.onRoot?.({ channelId, threadTs });
  const sent = resume?.sent ?? 0;
  await sendOverflow(ctx, send, { channelId, threadTs, root, overflow, sent });
  if (overflow.length > 0) {
    ctx.logger({
      event: "slack_delivery_split",
      status: "info",
      params: { channel: channelId },
      result: { parts: overflow.length + 1 },
    });
  }
  return root;
}
