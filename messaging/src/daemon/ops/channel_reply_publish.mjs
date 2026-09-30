// channel.reply.publish — opaque channel ingress with daemon-derived
// authority. This is deliberately separate from message.commit: routes are
// transport descriptors, not conversation participants, so admitting a
// route principal through the generic writer would weaken participant checks.

import { createHash } from 'node:crypto';

import { TightbeamError } from '../../protocol/envelope.mjs';
import { withTransaction } from '../db.mjs';
import { createDerivedInboundDelivery, insertMessage, payloadHash, pushLiveDeliveryEvents, refreshSessionWatermark, validateBody } from './message_shared.mjs';
import { activeListenerForEndpoint, createPendingPresentation, pendingReplyWaitForBinding, publishPresentation } from './listener_operations.mjs';
import { replyContinuityDiagnostic } from '../reply_continuity_diagnostics.mjs';
import { applyOpen } from '../lifecycle_transition.mjs';

export const CHANNEL_REPLY_PUBLISH_FIELDS = Object.freeze(['reply_binding', 'body', 'external_event_id', 'provider_metadata']);
const MAX_PROVIDER_METADATA_BYTES = 16 * 1024;
const FORBIDDEN_METADATA_KEYS = new Set([
  'conversation_id',
  'origin_channel_route_id',
  'sender_principal_id',
  'in_reply_to_message_id',
  'inbound_target_endpoint_id',
  'destination_principal_id',
  'channel_selectors',
  'obligation_effect',
]);

function malformed(field, message) {
  throw new TightbeamError('malformed_request', message, { field });
}

function containsForbiddenMetadataKey(value) {
  if (Array.isArray(value)) return value.some(containsForbiddenMetadataKey);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => FORBIDDEN_METADATA_KEYS.has(key) || containsForbiddenMetadataKey(child));
}

export function validateBoundReplyRequest(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    malformed('payload', 'channel.reply.publish payload must be an object');
  }
  for (const field of Object.keys(payload)) {
    if (!CHANNEL_REPLY_PUBLISH_FIELDS.includes(field)) {
      malformed(field, `channel.reply.publish declares "${field}", which is not part of its four-field request contract`);
    }
  }
  for (const field of ['reply_binding', 'external_event_id']) {
    if (typeof payload[field] !== 'string' || payload[field].length === 0) {
      malformed(field, `${field} is required and must be a non-empty string`);
    }
  }
  validateBody(payload.body);
  if (!payload.provider_metadata || typeof payload.provider_metadata !== 'object' || Array.isArray(payload.provider_metadata)) {
    malformed('provider_metadata', 'provider_metadata is required and must be an object');
  }
  const serialized = JSON.stringify(payload.provider_metadata);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PROVIDER_METADATA_BYTES) {
    malformed('provider_metadata', `provider_metadata exceeds ${MAX_PROVIDER_METADATA_BYTES} bytes`);
  }
  if (containsForbiddenMetadataKey(payload.provider_metadata)) {
    malformed('provider_metadata', 'provider_metadata must not declare canonical routing or lifecycle authority');
  }
  return {
    reply_binding: payload.reply_binding,
    body: payload.body,
    external_event_id: payload.external_event_id,
    provider_metadata: payload.provider_metadata,
    payload_hash: payloadHash({ body: payload.body, provider_metadata: payload.provider_metadata }),
  };
}

function digestToken(token) {
  return `sha256:${createHash('sha256').update(token, 'utf8').digest('hex')}`;
}

function resolveBinding(db, { tokenDigest, appId }) {
  const row = db.prepare(
    `SELECT b.id, b.app_id, b.channel_route_id, b.conversation_id, b.source_message_id, b.source_delivery_id,
            b.target_endpoint_id, b.expires_at, b.state AS binding_state,
            r.principal_id AS route_principal_id, r.state AS route_state, r.app_id AS route_app_id,
            a.status AS app_status,
            target.id AS target_id, target.principal_id AS target_principal_id, target.created_by_app_id AS target_app_id, target.state AS target_state,
            target.provider_session_id AS target_session_id, target.process_generation AS target_process_generation,
            target.launch_mode AS target_launch_mode, target.authority_reference AS target_authority_reference,
            conversation.closed_at AS conversation_closed_at,
            source.conversation_id AS source_conversation_id, source.sender_principal_id AS source_sender_principal_id,
            source_delivery.message_id AS source_delivery_message_id, source_delivery.channel_route_id AS source_delivery_route_id
       FROM reply_binding_tokens token
       JOIN reply_bindings b ON b.id = token.binding_id
       JOIN channel_routes r ON r.id = b.channel_route_id
       JOIN applications a ON a.id = b.app_id
       JOIN endpoints target ON target.id = b.target_endpoint_id
       JOIN conversations conversation ON conversation.id = b.conversation_id
       JOIN messages source ON source.id = b.source_message_id
       JOIN deliveries source_delivery ON source_delivery.id = b.source_delivery_id
      WHERE token.token_digest = ? AND b.app_id = ? AND r.app_id = ?`,
  ).get(tokenDigest, appId, appId);
  if (!row) {
    throw new TightbeamError('permission_denied', 'reply binding is not granted for this authenticated application');
  }
  return row;
}

function findReplay(db, { bindingId, externalEventId, payloadHashValue }) {
  const row = db
    .prepare('SELECT payload_hash, result_payload FROM reply_binding_events WHERE binding_id = ? AND external_event_id = ?')
    .get(bindingId, externalEventId);
  if (!row) return null;
  if (row.payload_hash !== payloadHashValue) {
    throw new TightbeamError('idempotency_collision', `external_event_id "${externalEventId}" was already used with a different payload`, {
      field: 'external_event_id',
    });
  }
  return JSON.parse(row.result_payload);
}

function retireBinding(db, binding, reason, now) {
  db.prepare(
    `UPDATE reply_bindings
        SET state = 'retired', retired_at = COALESCE(retired_at, ?), retired_reason = COALESCE(retired_reason, ?)
      WHERE id = ? AND state = 'active'`,
  ).run(now.toISOString(), reason, binding.id);
}

function requireNewEventBinding(db, binding, now) {
  if (binding.binding_state !== 'active' || Date.parse(binding.expires_at) <= now.getTime()) {
    throw new TightbeamError('permission_denied', 'reply binding is retired or expired');
  }
  if (binding.route_state !== 'active') {
    retireBinding(db, binding, 'channel_route_retired', now);
    throw new TightbeamError('permission_denied', 'reply binding route is no longer active');
  }
  if (binding.app_status !== 'active') {
    retireBinding(db, binding, 'application_disabled', now);
    throw new TightbeamError('permission_denied', 'reply binding application is no longer active');
  }
  if (binding.conversation_closed_at !== null) {
    retireBinding(db, binding, 'conversation_closed', now);
    throw new TightbeamError('permission_denied', 'reply binding conversation is closed');
  }
  if (binding.source_conversation_id !== binding.conversation_id || binding.source_delivery_message_id !== binding.source_message_id || binding.source_delivery_route_id !== binding.channel_route_id) {
    retireBinding(db, binding, 'lineage_invalid', now);
    throw new TightbeamError('permission_denied', 'reply binding lineage is no longer canonical');
  }
  const participant = db
    .prepare('SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND principal_id = ?')
    .get(binding.conversation_id, binding.target_principal_id);
  if (!participant || binding.target_state === 'closed') {
    retireBinding(db, binding, 'target_endpoint_closed', now);
    throw new TightbeamError('permission_denied', 'reply binding target is no longer routable');
  }
}

export const channelReplyPublishOp = {
  name: 'channel.reply.publish',
  allowedScopes: ['agent'],
  permission: 'publish_inbound_messages',
  handler(context, payload, connection) {
    const request = validateBoundReplyRequest(payload);
    const tokenDigest = digestToken(request.reply_binding);
    const startedAt = Date.now();
    const outcome = withTransaction(context.db, () => {
      const binding = resolveBinding(context.db, { tokenDigest, appId: connection.appId });
      const replay = findReplay(context.db, {
        bindingId: binding.id,
        externalEventId: request.external_event_id,
        payloadHashValue: request.payload_hash,
      });
      if (replay) {
        return { result: { ...replay, idempotent_replay: true }, presentation: null, live: false };
      }

      requireNewEventBinding(context.db, binding, new Date());
      const messageId = insertMessage(context.db, {
        conversationId: binding.conversation_id,
        appId: connection.appId,
        senderPrincipalId: binding.route_principal_id,
        kind: 'commit',
        body: request.body,
        metadata: { provider_metadata: request.provider_metadata },
        idempotencyKey: `reply-binding:${binding.id}:${request.external_event_id}`,
        hash: request.payload_hash,
        origin: 'inbound',
        originChannelRouteId: binding.channel_route_id,
        inReplyToMessageId: binding.source_message_id,
      });
      const now = new Date().toISOString();
      const opened = applyOpen(context.db, {
        appId: binding.target_app_id,
        conversationId: binding.conversation_id,
        messageId,
        effect: {
          type: 'open',
          target_principal_id: binding.target_principal_id,
          target_endpoint_id: binding.target_id,
          completion_mode: 'delivery_confirmed',
        },
        now,
      });
      const listener = activeListenerForEndpoint(context.db, {
        endpointId: binding.target_id,
        processGeneration: binding.target_process_generation,
        providerSessionId: binding.target_session_id,
      });
      const delivery = createDerivedInboundDelivery(context.db, {
        conversationId: binding.conversation_id,
        messageId,
        endpoint: {
          id: binding.target_id,
          principal_id: binding.target_principal_id,
          state: binding.target_state,
          session_id: binding.target_session_id,
          process_generation: binding.target_process_generation,
          launch_mode: binding.target_launch_mode,
          authority_reference: binding.target_authority_reference,
        },
        listener,
      });
      const replyWait = pendingReplyWaitForBinding(context.db, {
        bindingId: binding.id,
        endpointId: binding.target_id,
        processGeneration: binding.target_process_generation,
        providerSessionId: binding.target_session_id,
      });
      const presentation = listener
        ? createPendingPresentation(context.db, { listener, messageId, deliveryId: delivery.delivery_id, replyWaitId: replyWait?.id ?? null })
        : null;
      if (listener) {
        context.db.prepare("UPDATE listeners SET state = 'waking', updated_at = ? WHERE id = ? AND state IN ('parked', 'attached')").run(new Date().toISOString(), listener.id);
      }
      context.db.prepare(
        'UPDATE obligations SET ack_due_at = ?, ack_message_id = ?, ack_delivery_id = ? WHERE id = ?',
      ).run(new Date(Date.parse(now) + 120_000).toISOString(), messageId, delivery.delivery_id, opened.created.root_id);
      if (delivery.route_outcome === 'enqueue_only') {
        refreshSessionWatermark({
          stateRoot: context.stateRoot,
          sessionId: binding.target_session_id,
          deliveryId: delivery.delivery_id,
          logger: context.logger,
        });
      }
      const result = {
        message_id: messageId,
        conversation_id: binding.conversation_id,
        delivery_id: delivery.delivery_id,
        route_outcome: delivery.route_outcome,
        idempotent_replay: false,
      };
      context.db.prepare(
        `INSERT INTO reply_binding_events
          (binding_id, external_event_id, payload_hash, committed_message_id, result_payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(binding.id, request.external_event_id, request.payload_hash, messageId, JSON.stringify(result), now, now);
      return {
        result,
        presentation,
        live: Boolean(listener),
        liveDeliveries: [{ principal_id: binding.target_principal_id, endpoint_id: binding.target_id, message_id: messageId }],
      };
    });
    if (!outcome.result.idempotent_replay) {
      replyContinuityDiagnostic(context.logger, 'reply_delivered', { latency_ms: Date.now() - startedAt, live: outcome.live });
      replyContinuityDiagnostic(context.logger, outcome.live ? 'reply_presented' : 'fallback');
    }
    if (outcome.presentation) publishPresentation(context, outcome.presentation);
    if (!outcome.result.idempotent_replay) {
      pushLiveDeliveryEvents(context, { conversationId: outcome.result.conversation_id, liveDeliveries: outcome.liveDeliveries });
    }
    return { result: outcome.result };
  },
};
