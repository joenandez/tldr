/**
 * The channel route a reply should go back out through.  A message that
 * arrived over a channel carries its own immutable origin route.  The
 * agent's own outbound messages carry none, so replying to one falls back to
 * the conversation's earliest inbound route (the user thread it belongs to).
 * In an agent-started user thread no user has answered yet, it is the route
 * the replied-to message itself went out on (521.13). Returns null when the
 * replied-to message is not in the conversation or the conversation never
 * came through or went out on a channel.
 */
export function resolveOriginRouteId(
  db,
  { conversationId, inReplyToMessageId },
) {
  const target = db
    .prepare(
      "SELECT origin_channel_route_id FROM messages WHERE id = ? AND conversation_id = ?",
    )
    .get(inReplyToMessageId, conversationId);
  if (!target) return null;
  const inbound = () =>
    db
      .prepare(
        "SELECT origin_channel_route_id FROM messages WHERE conversation_id = ? AND origin_channel_route_id IS NOT NULL ORDER BY rowid ASC LIMIT 1",
      )
      .get(conversationId)?.origin_channel_route_id;
  const outbound = () =>
    db
      .prepare(
        "SELECT channel_route_id FROM deliveries WHERE message_id = ? AND channel_route_id IS NOT NULL ORDER BY rowid ASC LIMIT 1",
      )
      .get(inReplyToMessageId)?.channel_route_id;
  return target.origin_channel_route_id ?? inbound() ?? outbound() ?? null;
}
