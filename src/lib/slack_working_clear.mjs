import { clearThreadWorking } from "./slack_working.mjs";

// The post is out: a thread's working indicator is done. Never fails the delivery.
// postedTs: a replay passes its receipt's post ts, so a newer owner message is spared.
// A busy line is not the agent's answer: the thread stays "working". A resume-failure notice ends the wait, so it clears.
export const clearWorking = (
  ctx,
  { metadata },
  { channelId, threadTs, postedTs },
) =>
  threadTs && metadata.notice !== "busy"
    ? clearThreadWorking(
        ctx.slackOpts,
        { channelId, threadTs, postedTs },
        "replied",
      )
    : null;
