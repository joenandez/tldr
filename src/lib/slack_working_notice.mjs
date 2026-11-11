import { postMessage } from "./slack_api.mjs";
import { lookupChannelAgent, readOne } from "./slack_channel_map.mjs";
import { noticeAbandoned, noticeSettled } from "./slack_notice_retry.mjs";
import { keyOf, paramsOf } from "./slack_working.mjs";
import { withThreadLock } from "./slack_thread_lock.mjs";
import { lookupWorking } from "./slack_working_store.mjs";

// The longest the resumer can keep a launch pending on purpose, with slack: eight
// 180 s spawn leases plus a rate-limit backoff of 1 + 5 + 15 + 4 x 60 min
// (resumer.mjs AUTH_RETRY_DELAYS_MS, failSupervisedAttempt). Past it a delivery
// nothing resolved (a runtime no daemon strategy owns waits for an external
// claim forever) ends the wait, with the notice first.
export const STARTING_MAX_AGE_MS = 6 * 3_600_000;

// Where a committed row's recipients stand in the endpoint list. A placeholder
// (registered, no provider session yet) is "starting": only its delivery going
// terminal, a reply or the bound ends the wait. "unknown" (an exact lookup could
// not tell) waits too. launch: a recipient is a real placeholder. unread: a
// recipient is a confirmed terminal endpoint (a real placeholder, or an adopted
// session, from the list or the exact lookup, that is closed or dead) and has not
// read the message: positive evidence it was not received. unreadAny: any
// recipient has not read it (the notice may lack evidence, the record may not).
// unknown: a recipient cannot be told.
const TERMINAL = new Set(["closed", "dead"]);
const isUnread = (d) => !d.read_at && !d.acknowledged_at;
export function launchState(deliveries, list) {
  if (!list) return { unknown: true };
  const states = deliveries.map((d) => list.placeholders.get(d.endpoint_id));
  const adopted = (d) =>
    list.rows.some(
      (s) => s.endpoint_id === d.endpoint_id && TERMINAL.has(s.state),
    );
  const real = deliveries.filter(
    (d, i) => states[i] && states[i] !== "unknown",
  );
  return {
    launch: real.length > 0,
    starting: states.some((state) => state && state !== "closed"),
    unread: [...real, ...deliveries.filter(adopted)].some(isUnread),
    unreadAny: deliveries.some(isUnread),
    unknown: states.includes("unknown"),
  };
}

// The reason an aged wait ends, else null: a wait that may still be starting (or
// cannot be told) lasts to the durable bound; any other ends at the age cap.
export function agedReason(age, state, maxAgeMs) {
  if (age < maxAgeMs) return null;
  const waiting = state.starting || state.unknown;
  return waiting && age < STARTING_MAX_AGE_MS ? null : "age_cap";
}

// The row as it stands now, if it is still the same message and not cleared: inbound
// may have tracked a newer message, and a clear (a reply) may have run, since the
// caller read its snapshot. Callers act on it before their first await.
export function stillWaiting(ctx, row) {
  const current = lookupWorking(ctx.home, keyOf(row));
  return current && current.ts === row.ts && !current.clearedAt
    ? current
    : null;
}

// Whether this thread started a by-name launch, from the durable thread_launch row
// (keyed by the launching post: this message, or the thread root).
function launchRecorded(ctx, row) {
  try {
    return Boolean(
      readOne(
        ctx.home,
        "SELECT 1 AS hit FROM thread_launch WHERE channel_id = ? AND root_ts IN (?, ?)",
        row.channelId,
        row.ts,
        row.threadTs,
      ),
    );
  } catch {
    return false; // an old table: no launch recorded
  }
}

// A "could not receive" notice needs positive evidence the message was not
// received: its delivery failed or expired, or its recipient is a placeholder or
// closed (read from the list or by an exact lookup, never inferred from absence)
// and the delivery is unread. A wait that merely ran out (an unreadable list or
// delivery, a read message) clears without one: a false "post again" makes
// duplicate work. The thread must be a by-name launch, from the durable row.
const DELIVERY_FAILED = new Set(["delivery_failed", "delivery_expired"]);
export const noticeDue = (ctx, row, state) =>
  (state.launch || launchRecorded(ctx, row)) &&
  (DELIVERY_FAILED.has(state.reason) || Boolean(state.unread));

// A recorded launch that ended with no notice and no proof either way is cleared
// on the record: the wait ran out at the bound (nothing told), or the message was
// never read and nothing confirmed the endpoint terminal (gone from a complete
// list, still live). A read message clears plain: it was received.
export function logUnconfirmed(ctx, row, state) {
  const waiting = state.starting || state.unknown || state.launch;
  const ranOut = state.reason === "age_cap" && waiting;
  if (noticeDue(ctx, row, state)) return;
  if (!ranOut && !(state.unreadAny && launchRecorded(ctx, row))) return;
  ctx.logger?.({
    event: "slack_working_cleared_unconfirmed",
    status: "error",
    params: { ...paramsOf(row), reason: state.reason },
    result: {
      unknown: Boolean(state.unknown),
      read: state.unreadAny === false,
    },
  });
}

// The post itself.
async function sendNotice(ctx, row) {
  const name = lookupChannelAgent(ctx.home, row.channelId)?.agentName;
  const key = `notice:${row.channelId}:${row.threadTs}:${row.ts}`;
  try {
    await postMessage(
      {
        channel: row.channelId,
        thread_ts: row.threadTs,
        text: `${name ?? "The agent"} could not receive this message. Post again to retry.`,
      },
      ctx,
    );
    noticeSettled(ctx.home, key);
    return true;
  } catch (error) {
    ctx.logger?.({
      event: "slack_working_notice_failed",
      status: "warn",
      params: paramsOf(row),
      result: { slack_error: error.slackError ?? null },
    });
    return noticeAbandoned({ ctx, key, error, params: paramsOf(row) });
  }
}

// A clear that has evidence (noticeDue, as state.notice) says so in the thread
// first, unless the agent replied (or a newer message came) before our turn in the
// thread (false: the row is not ours to clear any more). False too when the post
// failed: the status stays and the next tick tries again, until Slack says it
// never can (permanent) or NOTICE_RETRY_MS passes: then the loss is logged and the
// clear goes ahead. The 6 h bound alone does not cover it: it only ends the wait,
// the notice still runs before the clear.
export async function noticePosted(ctx, row, state) {
  if (!state.notice) return true;
  // The decision and the post take their turn with an agent reply in this thread.
  return withThreadLock({ ...keyOf(row), home: ctx.home }, () =>
    stillWaiting(ctx, row) ? sendNotice(ctx, row) : false,
  );
}
