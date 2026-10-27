// The tool-boundary notification surface intentionally returns no message
// content.  Exact message.receive is the only body/read/admission boundary.

import { TightbeamError } from '../../protocol/envelope.mjs';
import { withTransaction } from '../db.mjs';
import { openOldestUnreadAdmission } from './delivery_admission.mjs';
import { notificationContext } from './notification_context.mjs';
import { pendingReplyGuard } from '../agent_wait_context.mjs';

function validateRequestIdentity(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TightbeamError('malformed_request', 'message.notification.next payload must be an object', { field: 'payload' });
  }
  for (const field of ['endpoint_id', 'provider_session_id']) {
    if (typeof payload[field] !== 'string' || payload[field].length === 0) {
      throw new TightbeamError('malformed_request', `${field} is required and must be a non-empty string`, { field });
    }
  }
  if (!Number.isSafeInteger(payload.process_generation) || payload.process_generation < 1) {
    throw new TightbeamError('malformed_request', 'process_generation is required and must be a positive integer', { field: 'process_generation' });
  }
}

function validateRequestOptions(payload) {
  for (const field of Object.keys(payload)) {
    if (
      ![
        'endpoint_id',
        'process_generation',
        'provider_session_id',
        'include_pending_reply_guard',
        'wait_action_id',
      ].includes(field)
    ) {
      throw new TightbeamError('malformed_request', `message.notification.next declares "${field}", which is not part of its request contract`, { field });
    }
  }
  if (
    payload.include_pending_reply_guard !== undefined &&
    typeof payload.include_pending_reply_guard !== 'boolean'
  ) {
    throw new TightbeamError('malformed_request', 'include_pending_reply_guard must be a boolean', { field: 'include_pending_reply_guard' });
  }
  if (
    payload.wait_action_id !== undefined &&
    (typeof payload.wait_action_id !== 'string' ||
      !payload.wait_action_id ||
      payload.wait_action_id.length > 512)
  ) {
    throw new TightbeamError('malformed_request', 'wait_action_id must be a non-empty string of at most 512 characters', { field: 'wait_action_id' });
  }
  if (payload.include_pending_reply_guard === true && !payload.wait_action_id) {
    throw new TightbeamError('malformed_request', 'wait_action_id is required when capturing a pending reply guard', { field: 'wait_action_id' });
  }
  if (payload.include_pending_reply_guard !== true && payload.wait_action_id !== undefined) {
    throw new TightbeamError('malformed_request', 'wait_action_id requires include_pending_reply_guard', { field: 'wait_action_id' });
  }
}

function request(payload) {
  validateRequestIdentity(payload);
  validateRequestOptions(payload);
  return payload;
}

export const messageNotificationNextOp = {
  name: 'message.notification.next',
  allowedScopes: ['agent'],
  permission: 'read_inbox',
  handler(context, payload, connection) {
    const input = request(payload);
    const notification = withTransaction(context.db, () => {
      const endpoint = context.db
        .prepare(
          `SELECT id, principal_id, process_generation, provider_session_id, owner_epoch, owner_launch_token
             FROM endpoints
            WHERE id = ? AND process_generation = ? AND provider_session_id = ?
              AND created_by_app_id = ? AND state IN ('idle', 'busy')`,
        )
        .get(input.endpoint_id, input.process_generation, input.provider_session_id, connection.appId);
      if (!endpoint) {
        throw new TightbeamError('permission_denied', 'message.notification.next is not granted for this exact endpoint owner');
      }
      const next = openOldestUnreadAdmission(context.db, { endpoint });
      const pendingReplyGuardResult = input.include_pending_reply_guard
        ? pendingReplyGuard(context.db, {
            appId: connection.appId,
            endpointId: endpoint.id,
            providerSessionId: endpoint.provider_session_id,
            processGeneration: endpoint.process_generation,
            actionId: input.wait_action_id,
          })
        : null;
      if (!next && !input.include_pending_reply_guard) return null;
      return {
        ...(next
          ? {
              message_id: next.message_id,
              attempt: next.attempt,
              has_external_origin: next.has_external_origin,
              ...notificationContext(context.db, next.message_id, {
                deliveryId: next.delivery_id,
              }),
            }
          : {}),
        ...(input.include_pending_reply_guard ? { pending_reply_guard: pendingReplyGuardResult } : {}),
      };
    });
    return { result: notification };
  },
};
