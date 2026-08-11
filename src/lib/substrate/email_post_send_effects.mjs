import { recordAriadneOutboundForDelivery } from "../tldr_agent_ariadne.mjs";
import {
  clearReplyWaitingEmail,
  recordReplyWaitingEmail,
} from "../tachyon_eligibility.mjs";

const ISOLATED_LIFECYCLE_PURPOSES = new Set([
  "beacon_confirmation",
  "beacon_terminal",
]);

export function recordAcceptedEmailPostSendEffects({
  row,
  sessionId,
  tldrAgentReplyCandidate = false,
}) {
  if (ISOLATED_LIFECYCLE_PURPOSES.has(row.metadata?.purpose)) {
    return { recorded: false, reason: "beacon_lifecycle_delivery" };
  }
  const replyWaiting = tldrAgentReplyCandidate
    ? clearReplyWaitingEmail({ sessionId, threadId: row.thread_id })
    : recordReplyWaitingEmail({
        sessionId,
        threadId: row.thread_id,
        messageId: row.message_id,
      });
  const ariadne = recordAriadneOutboundForDelivery({
    sessionId,
    row,
    tldrAgentReplyCandidate,
  });
  return { recorded: true, replyWaiting, ariadne };
}
