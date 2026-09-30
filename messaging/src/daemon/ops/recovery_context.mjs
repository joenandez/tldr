// recovery.context — the replacement session's one read-only recovery
// projection.  It deliberately rebuilds context from current canonical rows:
// no transcript snapshot, route address, credential, or reply capability is
// copied into recovery lineage.

import { TightbeamError } from '../../protocol/envelope.mjs';
import { withTransaction } from '../db.mjs';
import { buildLifecycleView } from './lifecycle_view.mjs';

function requestFields(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TightbeamError('malformed_request', 'request is required and must be an object');
  }
  const allowed = new Set(['resume_request_id', 'endpoint_id']);
  for (const field of Object.keys(payload)) {
    if (!allowed.has(field)) throw new TightbeamError('malformed_request', `recovery.context declares "${field}", which is not part of its request contract`, { field });
  }
  for (const field of allowed) {
    if (typeof payload[field] !== 'string' || payload[field].length === 0) {
      throw new TightbeamError('malformed_request', `${field} is required and must be a non-empty string`, { field });
    }
  }
  return payload;
}

function refuse() {
  // Unknown requests, foreign endpoints, and incorrectly linked endpoints
  // all return this identical response.  Recovery must not become a queue
  // or session-existence oracle.
  throw new TightbeamError('permission_denied', 'recovery context is not granted for this replacement');
}

function linkedReplacement(db, appId, { resume_request_id: requestId, endpoint_id: endpointId }) {
  const row = db
    .prepare(
      `SELECT replacement.id AS replacement_request_id,
              replacement.endpoint_id AS replacement_endpoint_id,
              replacement.session_id AS replacement_request_session_id,
              original.id AS original_request_id,
              original.endpoint_id AS original_endpoint_id,
              original.session_id AS original_session_id,
              original.replacement_endpoint_id AS admitted_replacement_endpoint_id,
              original.replacement_session_id AS replacement_session_id,
              original.replacement_failure_reason AS failure_reason,
              original.conversation_id AS conversation_id,
              original.message_id AS message_id
         FROM resume_requests replacement
         JOIN resume_requests original ON original.id = replacement.replacement_for_request_id
         JOIN endpoints replacement_endpoint ON replacement_endpoint.id = replacement.endpoint_id
        WHERE replacement.id = ?
          AND replacement.endpoint_id = ?
          AND replacement.recovery_mode = 'replacement'
          AND replacement.state IN ('pending', 'claimed')
          AND original.recovery_mode = 'exact_resume'
          AND replacement_endpoint.created_by_app_id = ?`,
    )
    .get(requestId, endpointId, appId);
  if (!row || row.admitted_replacement_endpoint_id !== endpointId) refuse();
  return row;
}

// Every recovery render and custody switch depends on this canonical shape.
// Keep validation here, rather than separately relaxing allocation/read paths.
export function validateRecoveryContextState(db, appId, row, { allowUnboundReplacement = false } = {}) {
  const root = db
    .prepare(
      `SELECT root.*
         FROM obligations root
         JOIN principals owner ON owner.id = root.accountable_principal_id
         JOIN message_effects opening ON opening.obligation_id = root.id AND opening.effect = 'open'
        WHERE root.role = 'root'
          AND root.conversation_id = ?
          AND opening.message_id = ?
          AND owner.created_by_app_id = ?
        ORDER BY root.created_at ASC, root.id ASC
        LIMIT 1`,
    )
    .get(row.conversation_id, row.message_id, appId);
  const incompleteLineage =
    typeof row.original_session_id !== 'string' ||
    (!allowUnboundReplacement && typeof row.replacement_session_id !== 'string') ||
    row.failure_reason !== 'exact_session_unavailable';
  if (!root || root.status !== 'open' || !Number.isInteger(root.generation) || root.generation <= 0 || incompleteLineage) {
    // This operation is intentionally read-only.  Admission records an
    // auditable failure when it cannot construct this shape; a later read
    // merely refuses to turn incomplete records into an action prompt.
    throw new TightbeamError('obligation_conflict', 'replacement recovery context is incomplete; re-read operator recovery evidence');
  }
  let subject = null;
  try { subject = JSON.parse(db.prepare('SELECT metadata FROM conversations WHERE id = ?').get(root.conversation_id)?.metadata ?? '{}').subject; } catch { subject = null; }
  const participants = db.prepare('SELECT COUNT(*) AS n FROM conversation_participants WHERE conversation_id = ?').get(root.conversation_id).n;
  const messages = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(root.conversation_id).n;
  if (typeof subject !== 'string' || subject.trim().length === 0 || participants === 0 || messages === 0) {
    throw new TightbeamError('obligation_conflict', 'replacement recovery context is incomplete; re-read operator recovery evidence');
  }
  const activeCustody = db.prepare(
    "SELECT 1 FROM obligations WHERE parent_id = ? AND status = 'open' AND custodian_endpoint_id IS NOT NULL LIMIT 1",
  ).get(root.id);
  const attention = db.prepare('SELECT 1 FROM root_attention WHERE root_obligation_id = ? LIMIT 1').get(root.id);
  const brokenWatch = db.prepare(
    `WITH RECURSIVE chain(id) AS (
       SELECT id FROM obligations WHERE id = ?
       UNION ALL SELECT child.id FROM obligations child JOIN chain parent ON child.parent_id = parent.id
     )
     SELECT 1 FROM obligations delegation
      LEFT JOIN handoff_watches watch ON watch.delegation_id = delegation.id
      WHERE delegation.id IN (SELECT id FROM chain) AND delegation.role = 'delegation' AND delegation.status = 'open'
        AND (watch.id IS NULL OR watch.state = 'closed') LIMIT 1`,
  ).get(root.id);
  const badAck = db.prepare(
    `SELECT 1 WHERE (? IS NOT NULL AND (? IS NULL OR ? IS NULL))
       OR (? IS NOT NULL AND NOT EXISTS (SELECT 1 FROM deliveries WHERE id = ?))`,
  ).get(root.ack_accepted_at, root.ack_message_id, root.ack_delivery_id, root.ack_delivery_id, root.ack_delivery_id);
  if ((!activeCustody && !attention) || brokenWatch || badAck) {
    throw new TightbeamError('obligation_conflict', 'replacement recovery context is incomplete; re-read operator recovery evidence');
  }
  return root.id;
}

function messagesForRecovery(db, conversationId) {
  return db
    .prepare(
      `SELECT id AS message_id, sender_principal_id, body, created_at
         FROM messages
        WHERE conversation_id = ?
        ORDER BY created_at ASC, id ASC`,
    )
    .all(conversationId);
}

function unreadForRecovery(db, endpointId) {
  return db
    .prepare(
      `SELECT d.message_id AS message_id
         FROM deliveries d
        WHERE d.endpoint_id = ?
          AND d.state != 'failed'
          AND d.read_at IS NULL
          AND d.acknowledged_at IS NULL
        ORDER BY d.created_at ASC, d.id ASC`,
    )
    .all(endpointId);
}

export const recoveryContextOp = {
  name: 'recovery.context',
  allowedScopes: ['agent'],
  permission: 'manage_obligations',
  handler(context, payload, connection) {
    return withTransaction(context.db, () => {
      const request = requestFields(payload);
      const lineage = linkedReplacement(context.db, connection.appId, request);
      const rootId = validateRecoveryContextState(context.db, connection.appId, lineage);
      const chain = buildLifecycleView(context.db, connection.appId, { root_obligation_id: rootId }).chains[0];
      if (!chain) refuse();
      const participants = context.db
      .prepare(
        `SELECT p.id AS principal_id, p.display_name AS display_name
           FROM conversation_participants cp
           JOIN principals p ON p.id = cp.principal_id
          WHERE cp.conversation_id = ?
          ORDER BY cp.added_at ASC, p.id ASC`,
      )
      .all(lineage.conversation_id)
      .map((row) => ({ principal_id: row.principal_id, display_name: row.display_name ?? null }));
      if (participants.length === 0 || chain.subject === null) {
        throw new TightbeamError('obligation_conflict', 'replacement recovery context is incomplete; re-read operator recovery evidence');
      }
      return {
        result: {
        conversation_id: lineage.conversation_id,
        subject: chain.subject,
        participants,
        messages: messagesForRecovery(context.db, lineage.conversation_id),
        unread: { message_ids: unreadForRecovery(context.db, request.endpoint_id).map((row) => row.message_id) },
        root: chain,
        lineage: {
          original_request_id: lineage.original_request_id,
          original_endpoint_id: lineage.original_endpoint_id,
          original_session_id: lineage.original_session_id,
          replacement_request_id: lineage.replacement_request_id,
          replacement_endpoint_id: lineage.replacement_endpoint_id,
          replacement_session_id: lineage.replacement_session_id,
          failure_reason: lineage.failure_reason,
        },
        },
      };
    });
  },
};
