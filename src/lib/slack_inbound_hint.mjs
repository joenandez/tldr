import { postMessage } from "./slack_api.mjs";
import { markEventProcessed } from "./slack_channel_map.mjs";
import { noticeAbandoned, noticeSettled } from "./slack_notice_retry.mjs";
import { clearThreadWorking } from "./slack_working.mjs";

const HINT_TEXT =
  "I can't route this. Reply in an agent's thread, or post in an agent's channel.";

// Null when the hint posted, else the error.
async function postHint(ctx, entry, text) {
  const { home, credentials, fetchImpl, logger, signal } = ctx;
  try {
    await postMessage(
      {
        channel: entry.channel,
        text,
        thread_ts: entry.thread_ts ?? entry.ts,
      },
      { home, credentials, fetchImpl, logger, signal },
    );
    return null;
  } catch (error) {
    logger?.({
      event: "slack_inbound_hint_failed",
      status: "error",
      params: { channel: entry.channel, ts: entry.ts },
      result: { slack_error: error.slackError ?? null },
    });
    return error;
  }
}

// A hint is the only word the sender gets for an undelivered line: unless it was
// posted the line stays unhandled and the thread keeps its working indicator, and
// the next drain says it again. Bounded: a permanent Slack error, or a transient
// one past NOTICE_RETRY_MS, marks the line with an error log, as no notice will come.
export async function hintAndMark({ ctx, entry, eventId }, text = HINT_TEXT) {
  const error = await postHint(ctx, entry, text);
  const threadTs = entry.thread_ts ?? entry.ts;
  const params = {
    event_id: eventId,
    channel: entry.channel,
    thread_ts: threadTs,
  };
  if (error && !noticeAbandoned({ ctx, key: eventId, error, params }))
    return "retry";
  if (!error) noticeSettled(ctx.home, eventId);
  const { home, credentials, fetchImpl, logger, signal } = ctx;
  // Answered, or nothing more will be: either way the thread stops waiting.
  await clearThreadWorking(
    { home, credentials, fetchImpl, logger, signal },
    { channelId: entry.channel, threadTs, postedTs: entry.ts },
    "hinted",
  );
  markEventProcessed(home, eventId);
  return "hinted";
}
