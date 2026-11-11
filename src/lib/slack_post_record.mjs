import {
  lookupThreadRoot,
  lookupThreadRootByConversation,
  recordStandingConversation,
  recordThreadRoot,
} from "./slack_channel_map.mjs";

// Maps the posted root to its reply binding and the channel to its standing
// conversation; idempotent, so a replay re-applies it.
// late: the root was posted earlier (a replay, or a root a lookup recovered). Its replies
// route, but a newer root of the conversation stays the conversation's thread.
export function recordPosted(
  ctx,
  claim,
  { channelId, ts, threadTs, late = false },
) {
  const { home } = ctx;
  const conversationId = claim.message.conversation_id;
  const newer = late
    ? lookupThreadRootByConversation(home, conversationId)
    : null;
  const rootTs = threadTs ?? ts;
  recordThreadRoot(home, {
    channelId,
    rootTs,
    replyBinding: claim.reply_binding,
    messageId: claim.message_id,
    conversationId,
    deliveryId: claim.delivery_id,
  });
  if (newer && (newer.channelId !== channelId || newer.threadTs !== rootTs)) {
    // The newest row wins a conversation lookup: record the newer root again to keep it so.
    const row = lookupThreadRoot(home, {
      channelId: newer.channelId,
      rootTs: newer.threadTs,
    });
    if (row) recordThreadRoot(home, row);
  }
  recordStandingConversation(home, { channelId, conversationId });
  return { channel: channelId, ts, thread_ts: threadTs ?? null };
}
