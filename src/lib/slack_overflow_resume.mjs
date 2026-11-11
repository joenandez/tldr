import { messageText, timed } from "./slack_delivery_claim.mjs";
import {
  noteAt,
  priorOutboundAttempt,
  setPartsSent,
} from "./slack_outbound_attempt.mjs";
import { postInParts } from "./slack_post_parts.mjs";
import { withThreadLock } from "./slack_thread_lock.mjs";

// A delivery re-offered after its root posted but before every part did: send the rest. Parts
// already out stay out (a part Slack may hold is looked for first), and progress is kept.
export async function resumeParts(base, claim, receipt) {
  const { home } = base;
  const { channelId, threadTs } = receipt;
  const prior = priorOutboundAttempt(home, claim.delivery_id);
  // shortcut: a pruned attempt row looks back a day, not to the exact first try.
  const priorAttemptAt = prior?.startedAt ?? Date.now() / 1000 - 86_400;
  const ctx = { ...base, priorAttemptAt };
  const { message } = claim;
  // The first try's text: a recreated channel's note went before it, and moved the cut points.
  const note = noteAt(prior, { channelId, threadTs });
  const text = note + (threadTs ? message.body : messageText(message));
  const resume = { ts: receipt.ts, sent: receipt.sent };
  return withThreadLock({ home, channelId, threadTs }, async () => {
    try {
      await timed(ctx, "slack_ms", () =>
        postInParts(ctx, { channelId, threadTs, resume }, text),
      );
    } catch (error) {
      if (error.partial)
        setPartsSent(home, claim.delivery_id, error.partial.sent);
      throw error;
    }
    setPartsSent(home, claim.delivery_id, null);
  });
}
