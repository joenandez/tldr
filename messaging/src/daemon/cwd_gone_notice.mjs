// Tells the sending agent when a wake was refused because the target's folder
// is gone (ac-jfv.90). Kept out of lifecycle_transition.mjs, whose line count
// is ratcheted; it only reads from that module, never the other way round.
import path from "node:path";

import {
  insertEffectRow,
  senderEndpointOfMessage,
} from "./lifecycle_transition.mjs";
import {
  createDeliveriesForRecipients,
  insertMessage,
  newestLineageEndpointId,
  payloadHash,
  withIdempotency,
} from "./ops/message_shared.mjs";

// Daemon-written marker on this notice's effect row. A client cannot forge it:
// commits build the payload from their validated declaration, never from it.
// Every daemon notice carries one (any value), and none is ever noticed.
const NOTICE_MARKER = "cwd_gone";

// The sender's endpoint as the notice must reach it: the newest lineage
// replacement of the one the effect audit names, or null when none is recorded.
function senderEndpointNow(db, messageId) {
  const sent = senderEndpointOfMessage(db, messageId);
  if (!sent) return null;
  return (
    db
      .prepare("SELECT id, principal_id, state FROM endpoints WHERE id = ?")
      .get(newestLineageEndpointId(db, sent.endpoint_id)) ?? null
  );
}

// Why no notice is staged (null: stage it). Daemon notices, mail with no
// recorded or no open sender endpoint, and mail from the refused endpoint's
// own principal are never noticed.
function skipReason(db, request, recipient) {
  const isNotice = db
    .prepare(
      "SELECT 1 AS yes FROM message_effects WHERE message_id = ? AND json_extract(effect_payload, '$.notice') IS NOT NULL",
    )
    .get(request.message_id);
  const toTarget =
    recipient?.id === request.endpoint_id ||
    recipient?.principal_id === request.principal_id;
  const reasons = [
    [isNotice, "message_is_a_notice"],
    [!recipient, "no_sender_endpoint"],
    [recipient?.state === "closed", "sender_endpoint_closed"],
    [toTarget, "sender_is_target"],
  ];
  return reasons.find(([hit]) => hit)?.[1] ?? null;
}

// The body names the folder only when the recorded path is absolute.
function noticeBody(authorityReference) {
  const where =
    typeof authorityReference === "string" &&
    path.isAbsolute(authorityReference)
      ? ` to the agent session in ${authorityReference}: that folder no longer exists`
      : ": the agent session's folder no longer exists";
  return `Your message was not delivered${where}. Nothing was started. Send to the agent's live session instead.`;
}

/**
 * Stages the one notice an agent sender gets when its message could not wake
 * the target because the target's folder (the request's authority_reference)
 * is gone. Only a message with a sender endpoint recorded in its effect audit
 * qualifies (scheduled wakes and other daemon-authored mail have none), and
 * the sender endpoint must still be open. The
 * notice is authored by the unreachable target and answers the lost message in
 * its conversation, delivered like the scheduled-wake notice to an agent
 * requester: to that one endpoint (its newest lineage replacement), never to
 * the target's principal or any other participant, since a row there would
 * wake the dead folder again. Once per message, and never about a notice.
 * Returns `{ skipped: reason }` when it stages nothing.
 */
export function stageCwdGoneSenderNotice(context, { requestId }) {
  const { db } = context;
  const request = db
    .prepare(
      `SELECT r.id, r.endpoint_id, r.principal_id, r.conversation_id, r.message_id, r.authority_reference, m.app_id
       FROM resume_requests r JOIN messages m ON m.id = r.message_id
      WHERE r.id = ? AND r.state = 'failed' AND m.origin = 'agent' AND m.origin_channel_route_id IS NULL`,
    )
    .get(requestId);
  if (!request) return { skipped: "not_an_agent_message" };
  const recipient = senderEndpointNow(db, request.message_id);
  const skipped = skipReason(db, request, recipient);
  if (skipped) return { skipped };
  const recipientEndpointId = recipient.id;

  const body = noticeBody(request.authority_reference);
  const key = `resume-failure:${request.message_id}`;
  const hash = payloadHash({
    body,
    in_reply_to_message_id: request.message_id,
    cwd_gone: true,
  });
  return withIdempotency(
    db,
    { appId: request.app_id, idempotencyKey: key, hash },
    () => {
      const messageId = insertMessage(db, {
        conversationId: request.conversation_id,
        appId: request.app_id,
        senderPrincipalId: request.principal_id,
        kind: "commit",
        body,
        metadata: {},
        idempotencyKey: key,
        hash,
        origin: "agent",
        inReplyToMessageId: request.message_id,
      });
      insertEffectRow(db, {
        messageId,
        effect: { type: "none", sender_endpoint_id: request.endpoint_id },
        obligationId: null,
        obligationGeneration: null,
        notice: NOTICE_MARKER,
        now: new Date().toISOString(),
      });
      const { liveDeliveries, presentations } = createDeliveriesForRecipients(
        db,
        {
          conversationId: request.conversation_id,
          messageId,
          senderPrincipalId: request.principal_id,
          senderEndpointId: request.endpoint_id,
          recipientEndpointId,
          stateRoot: context.stateRoot,
          logger: context.logger,
        },
      );
      return {
        message_id: messageId,
        conversation_id: request.conversation_id,
        delivery_count: liveDeliveries.length,
        liveDeliveries,
        presentations,
      };
    },
  );
}
