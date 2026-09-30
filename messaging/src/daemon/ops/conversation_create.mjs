// conversation.create — docs/protocol.md "Conversations and messages".
// Requires send_as_principal; since the payload names participants rather
// than a single "acting as" principal, the scope check is: at least one
// listed participant's authority must be inside the caller's
// send_as_principal allowed_authorities — the caller is establishing a
// conversation on behalf of (at least) one principal it is actually
// authorized to represent, not an arbitrary pairing of principals it has
// no relationship to. owner_principal_id is intentionally left NULL here:
// the state ownership contract §4 stamps it "on the first accepted send", which
// is message.commit's job, not this op's.

import { TightbeamError } from '../../protocol/envelope.mjs';
import { generateId } from '../../protocol/ids.mjs';
import { withTransaction } from '../db.mjs';
import { validateMetadata } from './message_shared.mjs';

export function validateConversationMetadata(metadata, fieldPrefix = 'metadata') {
  validateMetadata(metadata);
  for (const field of ['subject', 'reason']) {
    if (typeof metadata?.[field] !== 'string' || metadata[field].trim().length === 0) {
      throw new TightbeamError('malformed_request', `${fieldPrefix}.${field} is required and must be a nonblank string`, {
        field: `${fieldPrefix}.${field}`,
      });
    }
  }
}

export const conversationCreateOp = {
  name: 'conversation.create',
  allowedScopes: ['agent'],
  permission: 'send_as_principal',
  handler(context, payload, connection) {
    const ids = payload && payload.participant_principal_ids;
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'string' && id.length > 0)) {
      throw new TightbeamError('malformed_request', 'participant_principal_ids is required and must be a non-empty array of strings', {
        field: 'participant_principal_ids',
      });
    }
    const metadata = payload.metadata;
    validateConversationMetadata(metadata);

    const uniqueIds = [...new Set(ids)];
    const participants = uniqueIds.map((id) => {
      const row = context.db.prepare('SELECT id, authority_name, created_by_app_id FROM principals WHERE id = ?').get(id);
      if (!row) {
        throw new TightbeamError('malformed_request', `no principal registered with id "${id}"`, { field: 'participant_principal_ids' });
      }
      return row;
    });

    // F3: the caller must both hold send_as_principal for the authority
    // AND own the specific participant it represents — sharing an
    // authority scope with another application must not be enough to
    // create a conversation on that other application's principal's
    // behalf.
    const grant = connection.permissions.get('send_as_principal');
    const allowedAuthorities = (grant && grant.allowed_authorities) || [];
    const callerRepresentsAParticipant = participants.some(
      (p) => allowedAuthorities.includes(p.authority_name) && p.created_by_app_id === connection.appId,
    );
    if (!callerRepresentsAParticipant) {
      throw new TightbeamError('permission_denied', 'send_as_principal is not granted for any listed participant\'s authority');
    }

    const conversationId = generateId('conversation');
    const now = new Date().toISOString();
    withTransaction(context.db, () => {
      context.db
        .prepare("INSERT INTO conversations (id, created_by_app_id, binding_kind, owner_principal_id, metadata, created_at) VALUES (?, ?, 'direct', NULL, ?, ?)")
        .run(conversationId, connection.appId, JSON.stringify(metadata), now);
      const insertParticipant = context.db.prepare(
        'INSERT INTO conversation_participants (conversation_id, principal_id, role, added_at) VALUES (?, ?, NULL, ?)',
      );
      for (const principal of participants) {
        insertParticipant.run(conversationId, principal.id, now);
      }
    });

    return { result: { conversation_id: conversationId } };
  },
};
