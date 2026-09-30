// inbox.list — docs/protocol.md "Conversations and messages". Isolation
// is by principal ownership, not authority scope: allowed_authorities
// only scopes register_endpoints/send_as_principal
// (the state ownership contract §1), so read_inbox is gated by
// `principals.created_by_app_id === connection.appId`. A principal that
// does not exist and a principal owned by a different application return
// the identical permission_denied error (docs/security-model.md Threat
// table "Cross-app inbox read": "an unauthorized target and a nonexistent
// target return the same error").

import { TightbeamError } from '../../protocol/envelope.mjs';
import { withTransaction } from '../db.mjs';
import { reapExpired } from './claims_shared.mjs';

// F1: an inbox with enough large-body messages could otherwise produce a
// result too large to encode into one frame (MAX_FRAME_BYTES,
// src/protocol/envelope.mjs), which used to destroy the connection
// (server.mjs safeWrite). Stop appending once accumulated body bytes
// approach this budget and report `truncated: true` instead — a well
// under MAX_FRAME_BYTES budget leaves headroom for the rest of the
// envelope and every non-body field of every included message.
const BODY_BYTE_BUDGET = 768 * 1024;

function computeDeliveryState(row) {
  if (row.acknowledged_at) return 'acknowledged';
  if (row.read_at) return 'read';
  return row.state;
}

function conversationSubject(metadata) {
  try {
    const subject = JSON.parse(metadata ?? '{}')?.subject;
    return typeof subject === 'string' && subject.trim().length > 0 ? subject : null;
  } catch {
    // Historical rows remain readable without manufacturing a subject.
    return null;
  }
}

/**
 * The hook must stage this before its subsequent message.read.  Keep the
 * lifecycle projection in the daemon, where message/effect ancestry and
 * custody remain canonical rather than becoming a transport decision.
 */
function rootProjection(db, messageId) {
  return (
    db
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
         SELECT root.id AS root_obligation_id,
                root.accountable_principal_id AS accountable_principal_id,
                root.ack_due_at AS ack_due_at,
                root.ack_accepted_at AS ack_accepted_at,
                (
                  SELECT attempt.custodian_endpoint_id
                    FROM obligations attempt
                   WHERE attempt.parent_id = root.id
                     AND attempt.role = 'attempt'
                     AND attempt.status = 'open'
                   ORDER BY attempt.generation DESC
                   LIMIT 1
                ) AS custody_endpoint_id
           FROM obligation_lineage lineage
           JOIN obligations root ON root.id = lineage.id
          WHERE root.parent_id IS NULL
          LIMIT 1`,
      )
      .get(messageId) ?? null
  );
}

export const inboxListOp = {
  name: 'inbox.list',
  allowedScopes: ['agent'],
  permission: 'read_inbox',
  handler(context, payload, connection) {
    // F6: proactively return an abandoned claimed delivery to 'pending' if
    // its lease expired without a reclaim, so a state-filtered inbox poll
    // sees it right away rather than only after the next delivery.claim.
    withTransaction(context.db, () => reapExpired(context.db, 'delivery', new Date()));

    const principalId = payload && payload.principal_id;
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
        throw new TightbeamError('malformed_request', 'endpoint_id does not belong to principal_id', { field: 'endpoint_id' });
      }
    }

    const since = payload.since;
    if (since !== undefined && since !== null && typeof since !== 'string') {
      throw new TightbeamError('malformed_request', 'since must be a string when present', { field: 'since' });
    }

    const limit = payload.limit ?? 50;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new TightbeamError('malformed_request', 'limit must be a positive integer when present', { field: 'limit' });
    }

    const unreadOnly = Boolean(payload.unread_only);

    const rows = context.db
      .prepare(
        `SELECT m.id AS message_id, m.conversation_id AS conversation_id, m.sender_principal_id AS sender_principal_id,
                m.in_reply_to_message_id AS in_reply_to_message_id,
                m.body AS body, m.metadata AS metadata, m.created_at AS created_at, m.origin AS origin,
                c.metadata AS conversation_metadata,
                sender.display_name AS sender_display_name,
                origin_route.selector AS origin_channel_selector,
                d.state AS state, d.read_at AS read_at, d.acknowledged_at AS acknowledged_at
           FROM deliveries d
           JOIN endpoints e ON e.id = d.endpoint_id
      JOIN messages m ON m.id = d.message_id
      LEFT JOIN conversations c ON c.id = m.conversation_id
      LEFT JOIN principals sender ON sender.id = m.sender_principal_id
      LEFT JOIN channel_routes origin_route ON origin_route.id = m.origin_channel_route_id
          WHERE e.principal_id = ?
            AND (? IS NULL OR d.endpoint_id = ?)
            AND (? IS NULL OR m.created_at > ?)
          ORDER BY m.created_at ASC`,
      )
      .all(principalId, endpointId ?? null, endpointId ?? null, since ?? null, since ?? null);

    // Aggregate mode (no endpoint_id filter) may see the same message once
    // per one of the principal's endpoints; collapse to one entry per
    // message, preferring the most-complete delivery_state observed.
    const rank = { pending: 0, claimed: 1, delivered: 2, failed: 2, expired: 2, read: 3, acknowledged: 4 };
    const byMessage = new Map();
    for (const row of rows) {
      const state = computeDeliveryState(row);
      const existing = byMessage.get(row.message_id);
      if (!existing || rank[state] > rank[existing.delivery_state]) {
        const message = {
          message_id: row.message_id,
          conversation_id: row.conversation_id,
          sender_principal_id: row.sender_principal_id,
          in_reply_to_message_id: row.in_reply_to_message_id ?? null,
          // The author-origin axis (harbor) plus the sender's optional
          // registration display name — enrichment only, never a gate; a
          // principal without one (or no longer present) projects null.
          origin: row.origin,
          sender_display_name: row.sender_display_name ?? null,
          conversation_subject: conversationSubject(row.conversation_metadata),
          body: row.body,
          metadata: JSON.parse(row.metadata ?? '{}'),
          created_at: row.created_at,
          delivery_state: state,
        };
        if (row.origin === 'inbound' && typeof row.origin_channel_selector === 'string') {
          message.origin_channel_selector = row.origin_channel_selector;
        }
        const root = rootProjection(context.db, row.message_id);
        if (root) {
          message.root_obligation_id = root.root_obligation_id;
          message.accountable_principal_id = root.accountable_principal_id;
          message.custody_endpoint_id = root.custody_endpoint_id;
          message.reply_policy = 'required';
          message.ack_due_at = root.ack_due_at;
          message.ack_accepted_at = root.ack_accepted_at;
        } else {
          message.reply_policy = 'not_required';
        }
        byMessage.set(row.message_id, message);
      }
    }

    let messages = [...byMessage.values()].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
    if (unreadOnly) messages = messages.filter((m) => m.delivery_state !== 'read' && m.delivery_state !== 'acknowledged');
    messages = messages.slice(0, limit);

    let bodyBytes = 0;
    let truncated = false;
    const budgeted = [];
    for (const message of messages) {
      bodyBytes += Buffer.byteLength(message.body ?? '', 'utf8');
      if (bodyBytes > BODY_BYTE_BUDGET) {
        truncated = true;
        break;
      }
      budgeted.push(message);
    }

    const result = { messages: budgeted };
    if (truncated) result.truncated = true;
    return { result };
  },
};
