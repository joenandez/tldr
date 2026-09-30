// message.read — docs/protocol.md "Conversations and messages". Its
// error list is permission_denied ONLY (no message-not-found code): an
// unowned principal, a nonexistent message, a message the principal never
// received, and an endpoint_id that is not this principal's all collapse
// to the same permission_denied, matching inbox.list's non-leaking rule
// (docs/security-model.md Threat table). Marks the matching delivery rows
// read, idempotently — a second read of an already-read message is not an
// error and does not move its read_at.
//
// `endpoint_id` is optional and scopes ONLY the read_at UPDATE to that
// endpoint's delivery row. Without it every delivery row of the principal
// is marked read, which is what a principal-level reader means. It remains
// deliberately broader than message.receive, whose exact owner tuple is the
// provider-admission boundary for resumed and listener-delivered work.
//
// Generic reads retain their historic transport completion projection.
// Daemon-managed ordinary recovery instead completes only through exact
// message.receive, which stamps a process/session admission tuple first.
//
// R5a: and only THAT session's read. Completion is scoped to the verified
// `endpoint_id`, so a sibling window cannot suppress or falsely confirm
// another endpoint's recovery, and a principal-level read (no
// endpoint_id) completes nothing at all.

import { TightbeamError } from '../../protocol/envelope.mjs';
import { withTransaction } from '../db.mjs';
import { completeResumeRequestsForMessage } from './resume_shared.mjs';

/**
 * Marks exactly one already-authorized endpoint delivery read. Listener ACK
 * uses this same transport transition after it proves the listener fence;
 * it must never broaden into a principal-scoped read.
 */
export function markExactDeliveryRead(db, { deliveryId, endpointId, now, completeResumeRequests = true, resumeRequestId = null }) {
  const delivery = db
    .prepare(
      `SELECT d.id, d.message_id, e.principal_id
         FROM deliveries d
         JOIN endpoints e ON e.id = d.endpoint_id
        WHERE d.id = ? AND d.endpoint_id = ? AND d.state != 'failed'`,
    )
    .get(deliveryId, endpointId);
  if (!delivery) return null;
  db.prepare("UPDATE deliveries SET read_at = COALESCE(read_at, ?), updated_at = ? WHERE id = ? AND state != 'failed'").run(now, now, delivery.id);
  const completedResumeRequests = completeResumeRequests
    ? completeResumeRequestsForMessage(db, {
      messageId: delivery.message_id,
      principalId: delivery.principal_id,
      endpointId,
      now,
      resumeRequestId,
    })
    : [];
  return { message_id: delivery.message_id, completed_resume_request_ids: completedResumeRequests };
}

export const messageReadOp = {
  name: 'message.read',
  allowedScopes: ['agent'],
  permission: 'read_inbox',
  handler(context, payload, connection) {
    const messageId = payload && payload.message_id;
    const principalId = payload && payload.principal_id;
    if (typeof messageId !== 'string' || messageId.length === 0) {
      throw new TightbeamError('malformed_request', 'message_id is required and must be a string', { field: 'message_id' });
    }
    if (typeof principalId !== 'string' || principalId.length === 0) {
      throw new TightbeamError('malformed_request', 'principal_id is required and must be a string', { field: 'principal_id' });
    }

    const principal = context.db.prepare('SELECT id, created_by_app_id FROM principals WHERE id = ?').get(principalId);
    if (!principal || principal.created_by_app_id !== connection.appId) {
      throw new TightbeamError('permission_denied', 'read_inbox is not granted for this principal');
    }

    const endpointId = payload.endpoint_id;
    if (endpointId !== undefined && endpointId !== null) {
      if (typeof endpointId !== 'string' || endpointId.length === 0) {
        throw new TightbeamError('malformed_request', 'endpoint_id must be a string when present', { field: 'endpoint_id' });
      }
      const endpoint = context.db.prepare('SELECT id FROM endpoints WHERE id = ? AND principal_id = ?').get(endpointId, principalId);
      if (!endpoint) {
        throw new TightbeamError('permission_denied', 'read_inbox is not granted for this endpoint');
      }
    }

    const message = context.db
      .prepare(
        `SELECT m.id AS id, m.conversation_id AS conversation_id, m.sender_principal_id AS sender_principal_id,
                m.in_reply_to_message_id AS in_reply_to_message_id,
                m.body AS body, m.metadata AS metadata, m.created_at AS created_at, m.origin AS origin,
                c.metadata AS conversation_metadata,
                sender.display_name AS sender_display_name,
                origin_route.selector AS origin_channel_selector
           FROM messages m
      LEFT JOIN conversations c ON c.id = m.conversation_id
      LEFT JOIN principals sender ON sender.id = m.sender_principal_id
      LEFT JOIN channel_routes origin_route ON origin_route.id = m.origin_channel_route_id
          WHERE m.id = ?`,
      )
      .get(messageId);

    // The permission gate stays per PRINCIPAL: "this principal never
    // received this message" is the non-leaking test, and a scoped read
    // through an endpoint that holds no row for the message is a real
    // case — a Case D(b) session reads through the endpoint it registered
    // itself while the delivery row sits on the placeholder.
    const receivedByPrincipal = message
      ? context.db
          .prepare('SELECT 1 FROM deliveries d JOIN endpoints e ON e.id = d.endpoint_id WHERE d.message_id = ? AND e.principal_id = ? LIMIT 1')
          .get(messageId, principalId)
      : null;

    if (!message || !receivedByPrincipal) {
      throw new TightbeamError('permission_denied', 'read_inbox is not granted for this message');
    }

    const deliveryIds = context.db
      .prepare(
        `SELECT d.id AS id
           FROM deliveries d
           JOIN endpoints e ON e.id = d.endpoint_id
          WHERE d.message_id = ? AND e.principal_id = ? AND (? IS NULL OR d.endpoint_id = ?)`,
      )
      .all(messageId, principalId, endpointId ?? null, endpointId ?? null)
      .map((r) => r.id);

    const now = new Date().toISOString();
    const completedResumeRequests = withTransaction(context.db, () => {
      const update = context.db.prepare("UPDATE deliveries SET read_at = ?, updated_at = ? WHERE id = ? AND read_at IS NULL AND state != 'failed'");
      for (const deliveryId of deliveryIds) update.run(now, now, deliveryId);
      // Only the verified target endpoint's read satisfies its reply wait.
      // A principal-wide or sibling read must not claim live presentation.
      if (endpointId) {
        context.db.prepare(
          `UPDATE reply_waits SET state = 'satisfied', terminal_reason = 'reply_read', updated_at = ?, closed_at = ?
            WHERE endpoint_id = ? AND state IN ('pending_delivery', 'eligible')
              AND process_generation = (SELECT process_generation FROM endpoints WHERE id = ?)
              AND binding_id IN (
                SELECT event.binding_id FROM reply_binding_events event
                JOIN deliveries d ON d.message_id = event.committed_message_id
                WHERE event.committed_message_id = ? AND d.endpoint_id = ?
                  AND d.read_at IS NOT NULL AND d.state != 'failed'
              )`,
        ).run(now, now, endpointId, endpointId, messageId, endpointId);
      }
      // A read advances TRANSPORT facts only. The legacy natural-
      // advancement write it used to perform satisfied the implicit
      // `read` obligation row; those rows ceased at the lifecycle cutover,
      // and plan Out-of-Bounds 7 forbids treating a read as work
      // completion in the forward graph — only a message.commit close
      // effect closes forward work.
      //
      // Resume completion IS still transport (R5a). It is scoped to the
      // same verified endpoint, because "this session came back and read
      // its message" is the whole meaning of a completed request; a
      // sibling window under the same principal reading the message says
      // nothing about the session the daemon is trying to recover. Case
      // D(b) keeps working because the spawned session adopts the
      // placeholder that holds the request, so the reader and the target
      // are one endpoint.
      return completeResumeRequestsForMessage(context.db, { messageId: message.id, principalId, endpointId: endpointId ?? null, now });
    });

    if (completedResumeRequests.length > 0) {
      context.logger?.info({
        event: 'resume_request_completed',
        message_id: message.id,
        principal_id: principalId,
        resume_request_ids: completedResumeRequests,
      });
    }

    let conversationSubject = null;
    try {
      const subject = JSON.parse(message.conversation_metadata ?? '{}')?.subject;
      if (typeof subject === 'string' && subject.trim().length > 0) conversationSubject = subject;
    } catch {
      // Historical conversation metadata stays readable without inventing a subject.
    }
    const root = context.db
      .prepare(
        `WITH RECURSIVE message_lineage(id, in_reply_to_message_id) AS (
           SELECT id, in_reply_to_message_id FROM messages WHERE id = ?
           UNION ALL
           SELECT m.id, m.in_reply_to_message_id
             FROM messages m JOIN message_lineage ml ON ml.in_reply_to_message_id = m.id
         ), obligation_lineage(id, parent_id) AS (
           SELECT o.id, o.parent_id
             FROM message_lineage ml
             JOIN message_effects me ON me.message_id = ml.id
             JOIN obligations o ON o.id = me.obligation_id
           UNION ALL
           SELECT parent.id, parent.parent_id
             FROM obligations parent JOIN obligation_lineage child ON child.parent_id = parent.id
         )
         SELECT id FROM obligation_lineage WHERE parent_id IS NULL LIMIT 1`,
      )
      .get(message.id);
    const result = {
      message_id: message.id,
      conversation_id: message.conversation_id,
      conversation_subject: conversationSubject,
      sender_principal_id: message.sender_principal_id,
      in_reply_to_message_id: message.in_reply_to_message_id ?? null,
      // Same projection as inbox.list (harbor): author-origin axis plus the
      // optional registration display name, null when absent.
      origin: message.origin,
      sender_display_name: message.sender_display_name ?? null,
      body: message.body,
      metadata: JSON.parse(message.metadata ?? '{}'),
      created_at: message.created_at,
    };
    if (root?.id) result.root_obligation_id = root.id;
    if (message.origin === 'inbound' && typeof message.origin_channel_selector === 'string') {
      result.origin_channel_selector = message.origin_channel_selector;
    }
    // Present only when this read resolved a pending resume request, so a
    // caller can tell "the session came back" from an ordinary read.
    if (completedResumeRequests.length > 0) result.resumed_request_completed = completedResumeRequests[0];
    return { result };
  },
};
