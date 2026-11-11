import { WORKING_STATUS, setThreadStatus } from "./slack_api.mjs";
import { hasProcessedEvent } from "./slack_channel_map.mjs";

// A redelivery of an event inbound already processed (its inbox has rotated away) must
// show nothing: inbound skips it, so nothing would clean the indicator up. Inbound's key.
export const processedBefore = (home, event, eventId) =>
  hasProcessedEvent(home, eventId ?? `slack:${event.channel}:${event.ts}`);

// The "working" indicator, fired as soon as the line is safely in the inbox.
// Fire-and-forget: a Slack failure is logged and dropped, never retried here
// (the daemon's sweep re-sets the status) and never touches the append. The caller
// does not wait; the promise settles when the call did (tests await it). A call
// still in flight when the daemon clears is undone by the sweep's delayed clear.
export function showWorking(event, { slackOpts, log }) {
  const threadTs = event.thread_ts ?? event.ts;
  return setThreadStatus(
    { channel: event.channel, thread_ts: threadTs, status: WORKING_STATUS },
    slackOpts,
  ).catch((error) =>
    log({
      event: "slack_working_set_failed",
      status: "warn",
      params: { channel: event.channel, ts: event.ts },
      result: { slack_error: error.slackError ?? null },
    }),
  );
}
