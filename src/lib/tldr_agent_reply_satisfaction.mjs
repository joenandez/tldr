import { hasReadInboxMessage } from "./substrate/blocked_unread.mjs";

function timestampAfter(candidate, boundary) {
  const candidateMs = Date.parse(candidate || "");
  const boundaryMs = Date.parse(boundary || "");
  return (
    !Number.isNaN(candidateMs) &&
    !Number.isNaN(boundaryMs) &&
    candidateMs > boundaryMs
  );
}

export function findTldrAgentSatisfyingReply({
  obligation,
  listMessagesForThread,
  getTransportStateForMessage,
  isInboundRead = hasReadInboxMessage,
  scope,
  threadLimit = 200,
} = {}) {
  if (!obligation?.thread_id) return null;
  const rows = listMessagesForThread(scope, obligation.thread_id, threadLimit);
  for (const row of rows) {
    if (row?.thread_id !== obligation.thread_id) continue;
    if (row?.message_id === obligation.message_id) continue;
    if (row?.metadata?.source === "inbound_webhook") continue;
    if (row?.kind !== "reply") continue;
    const replyOwner =
      row?.metadata?.originator_session_id || row?.metadata?.session_id || null;
    if (replyOwner !== obligation.owner_session_id) continue;
    const replyTimestamp = row.created_at || row.scheduled_for;
    if (
      !isInboundRead({
        sessionId: obligation.owner_session_id,
        messageId: obligation.message_id,
        atOrBefore: replyTimestamp,
      })
    ) {
      continue;
    }
    if (!timestampAfter(replyTimestamp, obligation.inbound_created_at)) {
      continue;
    }
    const transportState = getTransportStateForMessage(scope, row.message_id);
    if (["sent", "delivered"].includes(transportState?.delivery_state)) {
      return { row, transportState };
    }
  }
  return null;
}
