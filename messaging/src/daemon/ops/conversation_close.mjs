// conversation.close — explicit per-thread closure. Conversation closure is
// intentionally separate from endpoint liveness and lifecycle work: it
// consumes no listener, Stop, retirement, or resume state.

import { TightbeamError } from '../../protocol/envelope.mjs';
import { generateId } from '../../protocol/ids.mjs';
import { withTransaction } from '../db.mjs';
import { payloadHash, validateIdempotencyKey } from './message_shared.mjs';

const CONVERSATION_CLOSE_OPERATION = 'conversation.close';
const CONVERSATION_CLOSE_FIELDS = ['conversation_id', 'sender_endpoint_id', 'process_generation', 'idempotency_key'];

function requireString(request, field) {
  const value = request?.[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TightbeamError('malformed_request', `${field} is required and must be a non-empty string`, { field });
  }
  return value;
}

function requirePositiveInteger(request, field) {
  const value = request?.[field];
  if (!Number.isInteger(value) || value < 1) {
    throw new TightbeamError('malformed_request', `${field} is required and must be a positive integer`, { field });
  }
  return value;
}

function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TightbeamError('malformed_request', 'conversation.close payload must be an object');
  }
  for (const field of Object.keys(request)) {
    if (!CONVERSATION_CLOSE_FIELDS.includes(field)) {
      throw new TightbeamError('malformed_request', `conversation.close declares "${field}", which is not part of its four-field request contract`, { field });
    }
  }
  const idempotencyKey = requireString(request, 'idempotency_key');
  validateIdempotencyKey(idempotencyKey);
  return {
    conversation_id: requireString(request, 'conversation_id'),
    sender_endpoint_id: requireString(request, 'sender_endpoint_id'),
    process_generation: requirePositiveInteger(request, 'process_generation'),
    idempotency_key: idempotencyKey,
  };
}

function findReplay(db, { appId, idempotencyKey, hash }) {
  const existing = db
    .prepare('SELECT payload_hash, result_payload FROM lifecycle_commands WHERE app_id = ? AND operation = ? AND idempotency_key = ?')
    .get(appId, CONVERSATION_CLOSE_OPERATION, idempotencyKey);
  if (!existing) return null;
  if (existing.payload_hash !== hash) {
    throw new TightbeamError('idempotency_collision', `idempotency_key "${idempotencyKey}" was already used with different conversation.close semantics`, {
      field: 'idempotency_key',
    });
  }
  return JSON.parse(existing.result_payload);
}

function requireAuthorizedClose(db, { appId, request }) {
  const endpoint = db.prepare('SELECT id, principal_id, created_by_app_id, process_generation, state FROM endpoints WHERE id = ?').get(request.sender_endpoint_id);
  const conversation = db.prepare('SELECT id, created_by_app_id, owner_principal_id, closed_at FROM conversations WHERE id = ?').get(request.conversation_id);
  if (
    !endpoint ||
    !conversation ||
    endpoint.created_by_app_id !== appId ||
    conversation.created_by_app_id !== appId ||
    endpoint.principal_id !== conversation.owner_principal_id ||
    endpoint.process_generation !== request.process_generation ||
    endpoint.state === 'closed'
  ) {
    throw new TightbeamError('permission_denied', 'conversation closure is not authorized');
  }
  return conversation;
}

export const conversationCloseOp = {
  name: CONVERSATION_CLOSE_OPERATION,
  allowedScopes: ['agent'],
  permission: 'register_endpoints',
  handler(context, payload, connection) {
    const request = validateRequest(payload);
    const hash = payloadHash({
      operation: CONVERSATION_CLOSE_OPERATION,
      conversation_id: request.conversation_id,
      sender_endpoint_id: request.sender_endpoint_id,
      process_generation: request.process_generation,
    });
    const replay = findReplay(context.db, { appId: connection.appId, idempotencyKey: request.idempotency_key, hash });
    if (replay) return { result: { ...replay, idempotent_replay: true } };

    const result = withTransaction(context.db, () => {
      const conversation = requireAuthorizedClose(context.db, { appId: connection.appId, request });
      if (conversation.closed_at !== null) {
        throw new TightbeamError('conversation_closed', 'conversation is already closed');
      }
      const closedAt = new Date().toISOString();
      context.db
        .prepare(
          `UPDATE reply_waits
              SET state = 'cancelled', terminal_reason = 'conversation_closed', updated_at = ?, closed_at = ?
            WHERE binding_id IN (
              SELECT id FROM reply_bindings WHERE conversation_id = ? AND state = 'active'
            ) AND state IN ('pending_delivery', 'eligible')`,
        )
        .run(closedAt, closedAt, conversation.id);
      context.db
        .prepare(
          `UPDATE reply_bindings
              SET state = 'retired', retired_at = ?, retired_reason = 'conversation_closed'
            WHERE conversation_id = ? AND state = 'active'`,
        )
        .run(closedAt, conversation.id);
      context.db.prepare('UPDATE conversations SET closed_at = ? WHERE id = ? AND closed_at IS NULL').run(closedAt, conversation.id);

      const resultPayload = { conversation_id: conversation.id, closed_at: closedAt };
      context.db
        .prepare(
          `INSERT INTO lifecycle_commands (id, app_id, operation, idempotency_key, payload_hash, root_obligation_id, result_payload, created_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(generateId('lifecycle_command'), connection.appId, CONVERSATION_CLOSE_OPERATION, request.idempotency_key, hash, JSON.stringify(resultPayload), closedAt);
      return resultPayload;
    });
    return { result: { ...result, idempotent_replay: false } };
  },
};
