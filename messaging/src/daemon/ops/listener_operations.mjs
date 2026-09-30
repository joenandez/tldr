import {
  LISTENER_ACK_OPERATION,
  LISTENER_ATTACH_OPERATION,
  LISTENER_END_OPERATION,
  LISTENER_HEARTBEAT_OPERATION,
  TightbeamError,
} from '../../protocol/envelope.mjs';
import { generateId } from '../../protocol/ids.mjs';
import { withTransaction } from '../db.mjs';
import { REPLY_BINDING_POLICY } from '../reply_listener_policy.mjs';
import { replyContinuityDiagnostic } from '../reply_continuity_diagnostics.mjs';
import { admitParkExpiryRetirement } from '../endpoint_retirement.mjs';
import { openOldestUnreadAdmission } from './delivery_admission.mjs';
import { refreshSessionWatermark } from './message_shared.mjs';

const FENCE_FIELDS = ['endpoint_id', 'process_generation', 'listener_id', 'listener_generation'];
const REQUEST_FIELDS = Object.freeze({
  [LISTENER_ATTACH_OPERATION]: FENCE_FIELDS,
  [LISTENER_HEARTBEAT_OPERATION]: FENCE_FIELDS,
  [LISTENER_ACK_OPERATION]: [...FENCE_FIELDS, 'presentation_id'],
  [LISTENER_END_OPERATION]: [...FENCE_FIELDS, 'terminal_reason'],
});

function conflict(message) {
  throw new TightbeamError('listener_conflict', message);
}

function validate(name, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TightbeamError('malformed_request', `${name} payload must be an object`, { field: 'payload' });
  }
  const fields = REQUEST_FIELDS[name];
  for (const field of Object.keys(payload)) {
    if (!fields.includes(field)) throw new TightbeamError('malformed_request', `${name} declares "${field}", which is not part of its request contract`, { field });
  }
  for (const field of ['endpoint_id', 'listener_id']) {
    if (typeof payload[field] !== 'string' || payload[field].length === 0) throw new TightbeamError('malformed_request', `${field} is required and must be a non-empty string`, { field });
  }
  for (const field of ['process_generation', 'listener_generation']) {
    if (!Number.isSafeInteger(payload[field]) || payload[field] <= 0) throw new TightbeamError('malformed_request', `${field} is required and must be a positive integer`, { field });
  }
  for (const field of ['presentation_id', 'terminal_reason']) {
    if (fields.includes(field) && (typeof payload[field] !== 'string' || payload[field].length === 0)) {
      throw new TightbeamError('malformed_request', `${field} is required and must be a non-empty string`, { field });
    }
  }
  return payload;
}

function exactListener(db, connection, request, { activeOnly = true } = {}) {
  const listener = db
    .prepare(
      `SELECT l.*, e.created_by_app_id, e.state AS endpoint_state, e.process_generation AS endpoint_process_generation,
              e.provider_session_id AS endpoint_provider_session_id, e.owner_epoch, e.owner_launch_token
         FROM listeners l
         JOIN endpoints e ON e.id = l.endpoint_id
        WHERE l.id = ? AND l.endpoint_id = ? AND l.process_generation = ? AND l.listener_generation = ?
          AND e.process_generation = ?
          AND (l.provider_session_id IS e.provider_session_id)`)
    .get(request.listener_id, request.endpoint_id, request.process_generation, request.listener_generation, request.process_generation);
  if (!listener || listener.created_by_app_id !== connection.appId || listener.endpoint_state === 'takeover_pending') {
    conflict('listener fence does not name an app-owned operable current listener');
  }
  if (activeOnly && !['parked', 'attached', 'waking'].includes(listener.state)) conflict('listener is no longer active');
  return listener;
}

function isUnexpired(listener, nowMs) {
  return Date.parse(listener.lease_expires_at) > nowMs && Date.parse(listener.park_deadline_at) > nowMs;
}

function presentationPayload(row) {
  return { presentation_id: row.id, message_id: row.message_id, delivery_id: row.target_delivery_id, has_external_origin: Boolean(row.has_external_origin) };
}

function pendingPresentations(db, listener) {
  return db
    .prepare(
      `SELECT p.id, p.message_id, p.target_delivery_id,
              m.origin = 'inbound' AND m.origin_channel_route_id IS NOT NULL AS has_external_origin
         FROM listener_presentations p
         JOIN messages m ON m.id = p.message_id
        WHERE p.listener_id = ? AND p.listener_generation = ? AND p.state = 'pending'
        ORDER BY p.created_at ASC, p.id ASC`,
    )
    .all(listener.id, listener.listener_generation);
}

function requireAttachedConnection(context, listener, connection) {
  if (!context.eventBus?.hasListener?.(listener.id, listener.listener_generation, connection)) {
    conflict('listener is not attached to this connection');
  }
}

// Listener custody is an endpoint/process/session fence. A reply binding can
// authorize ingress, but it cannot nominate which live process may consume a
// newly durable message: a later listener cycle can legitimately own the same
// endpoint after the original binding was made.
export function activeListenerForEndpoint(db, { endpointId, processGeneration, providerSessionId, nowMs = Date.now() }) {
  const listener = db
    .prepare(
        `SELECT l.*
         FROM listeners l
         JOIN endpoints e ON e.id = l.endpoint_id
        WHERE l.endpoint_id = ? AND l.process_generation = ?
          AND l.provider_session_id IS ?
          AND e.process_generation = ? AND e.provider_session_id IS ?
          AND l.state IN ('parked', 'attached')
        ORDER BY l.listener_generation DESC
        LIMIT 1`,
    )
    .get(endpointId, processGeneration, providerSessionId, processGeneration, providerSessionId);
  return listener && isUnexpired(listener, nowMs) ? listener : null;
}

/**
 * A listener exists only to wake an idle session. Once the session is busy
 * again (UserPromptSubmit), the Stop hook that held it is gone even when its
 * lease is still live, so a reply routed to it could only be missed. Ends
 * the current generation's listener, misses what it was presenting, and
 * rings the session watermark so the next tool boundary drains those
 * replies. Not a provider admission timeout: no retirement, no idle restore.
 */
export function releaseListenersForBusySession(context, { endpointId, processGeneration, now }) {
  // The doorbell belongs to the endpoint's current session, the one that is
  // busy now, even when a stale listener recorded an older one.
  const listeners = context.db
    .prepare(
      `SELECT l.id, l.listener_generation, e.provider_session_id AS session_id
         FROM listeners l JOIN endpoints e ON e.id = l.endpoint_id
        WHERE l.endpoint_id = ? AND l.process_generation = ? AND l.state IN ('parked', 'attached', 'waking')`,
    )
    .all(endpointId, processGeneration);
  for (const listener of listeners) {
    const missed = context.db
      .prepare(
        `SELECT id, target_delivery_id FROM listener_presentations
          WHERE listener_id = ? AND listener_generation = ? AND state = 'pending' AND admitted_at IS NULL
          ORDER BY created_at ASC, id ASC`,
      )
      .all(listener.id, listener.listener_generation);
    context.db
      .prepare("UPDATE listener_presentations SET state = 'missed', missed_at = ?, fallback_reason = 'session_busy', updated_at = ? WHERE listener_id = ? AND listener_generation = ? AND state = 'pending' AND admitted_at IS NULL")
      .run(now, now, listener.id, listener.listener_generation);
    context.db
      .prepare("UPDATE listeners SET state = 'ended', terminal_reason = 'session_busy', updated_at = ?, ended_at = ? WHERE id = ? AND state IN ('parked', 'attached', 'waking')")
      .run(now, now, listener.id);
    for (const presentation of missed) {
      refreshSessionWatermark({ stateRoot: context.stateRoot, sessionId: listener.session_id, deliveryId: presentation.target_delivery_id, logger: context.logger });
    }
    context.logger?.info({ event: 'listener_released_for_busy_session', endpoint_id: endpointId, listener_id: listener.id, missed_presentations: missed.length });
  }
  return listeners.length;
}

export function pendingReplyWaitForBinding(db, { bindingId, endpointId, processGeneration, providerSessionId }) {
  return db
    .prepare(
      `SELECT rw.id
         FROM reply_waits rw
         JOIN reply_bindings binding ON binding.id = rw.binding_id
        WHERE binding.id = ? AND rw.endpoint_id = ? AND rw.process_generation = ?
          AND binding.target_endpoint_id = ?
          AND rw.state IN ('pending_delivery', 'eligible')
          AND EXISTS (
            SELECT 1 FROM endpoints endpoint
             WHERE endpoint.id = rw.endpoint_id
               AND endpoint.process_generation = ?
               AND endpoint.provider_session_id IS ?
          )
        ORDER BY rw.created_at ASC, rw.id ASC
        LIMIT 1`,
    )
    .get(bindingId, endpointId, processGeneration, endpointId, processGeneration, providerSessionId) ?? null;
}

export function createPendingPresentation(db, { listener, messageId, deliveryId, replyWaitId = null, now = new Date().toISOString() }) {
  const deadline = new Date(Date.parse(now) + REPLY_BINDING_POLICY.presentationAckDeadlineMs).toISOString();
  const id = generateId('listener_presentation');
  db.prepare(
    `INSERT INTO listener_presentations
       (id, listener_id, listener_generation, message_id, target_delivery_id, state, ack_deadline_at, acked_at, missed_at,
        reply_wait_id, staged_at, admitted_at, fallback_resume_request_id, fallback_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, ?, NULL, NULL, NULL, ?, ?)`,
  ).run(id, listener.id, listener.listener_generation, messageId, deliveryId, deadline, replyWaitId, now, now, now);
  const message = db.prepare("SELECT origin = 'inbound' AND origin_channel_route_id IS NOT NULL AS has_external_origin FROM messages WHERE id = ?").get(messageId);
  return { id, listener_id: listener.id, listener_generation: listener.listener_generation, message_id: messageId, target_delivery_id: deliveryId, reply_wait_id: replyWaitId, has_external_origin: Boolean(message?.has_external_origin) };
}

export function publishPresentation(context, presentation) {
  return context.eventBus?.publishListener?.(
    presentation.listener_id,
    presentation.listener_generation,
    'listener.presentation',
    presentationPayload(presentation),
    context.logger,
  ) ?? 0;
}

function operation(name, handler) {
  return {
    name,
    allowedScopes: ['agent'],
    permission: 'register_endpoints',
    handler(context, payload, connection) {
      return handler(context, validate(name, payload), connection);
    },
  };
}

export const listenerAttachOp = operation(LISTENER_ATTACH_OPERATION, (context, request, connection) => {
  if (!context.eventBus) conflict('listener connection registry is unavailable');
  if (!context.eventBus?.canAttachListener?.(request.listener_id, request.listener_generation, connection)) {
    conflict('listener is already attached to a different connection');
  }
  const outcome = withTransaction(context.db, () => {
    const listener = exactListener(context.db, connection, request);
    if (!isUnexpired(listener, Date.now())) conflict('listener lease or park deadline has expired');
    if (listener.state === 'parked') {
      context.db.prepare("UPDATE listeners SET state = 'attached', updated_at = ? WHERE id = ? AND state = 'parked'").run(new Date().toISOString(), listener.id);
      listener.state = 'attached';
    }
    const presentations = pendingPresentations(context.db, listener);
    if (presentations.length > 0) {
      context.db.prepare("UPDATE listeners SET state = 'waking', updated_at = ? WHERE id = ? AND state = 'attached'").run(new Date().toISOString(), listener.id);
      listener.state = 'waking';
    }
    return { listener, presentations };
  });
  if (context.eventBus && !context.eventBus.attachListener?.(outcome.listener.id, outcome.listener.listener_generation, connection)) {
    conflict('listener is already attached to a different connection');
  }
  for (const presentation of outcome.presentations) publishPresentation(context, { ...presentation, listener_id: outcome.listener.id, listener_generation: outcome.listener.listener_generation });
  return { result: { attached: true, listener_id: outcome.listener.id, listener_generation: outcome.listener.listener_generation } };
});

export const listenerHeartbeatOp = operation(LISTENER_HEARTBEAT_OPERATION, (context, request, connection) => {
  const leaseExpiresAt = withTransaction(context.db, () => {
    const listener = exactListener(context.db, connection, request);
    requireAttachedConnection(context, listener, connection);
    const nowMs = Date.now();
    if (!isUnexpired(listener, nowMs)) conflict('listener lease or park deadline has expired');
    const next = new Date(Math.min(nowMs + REPLY_BINDING_POLICY.listenerLeaseMs, Date.parse(listener.park_deadline_at))).toISOString();
    const updated = context.db.prepare("UPDATE listeners SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND state IN ('attached', 'waking') AND listener_generation = ?").run(next, new Date(nowMs).toISOString(), listener.id, listener.listener_generation);
    if (updated.changes !== 1) conflict('listener is no longer renewable');
    return next;
  });
  return { result: { listener_id: request.listener_id, listener_generation: request.listener_generation, lease_expires_at: leaseExpiresAt } };
});

export const listenerAcknowledgeOp = operation(LISTENER_ACK_OPERATION, (context, request, connection) => {
  const outcome = withTransaction(context.db, () => {
    const listener = exactListener(context.db, connection, request, { activeOnly: false });
    requireAttachedConnection(context, listener, connection);
    const presentation = context.db
      .prepare(
        `SELECT p.*, m.conversation_id
           FROM listener_presentations p
           JOIN messages m ON m.id = p.message_id
          WHERE p.id = ? AND p.listener_id = ? AND p.listener_generation = ?`,
      )
      .get(request.presentation_id, listener.id, listener.listener_generation);
    if (!presentation) conflict('presentation does not belong to this listener generation');
    if (presentation.state === 'acked') return { message_id: presentation.message_id, delivery_id: presentation.target_delivery_id, idempotent_replay: true };
    if (presentation.state !== 'pending' || listener.state !== 'waking' && listener.state !== 'attached') conflict('presentation is no longer acknowledgeable');
    const nowMs = Date.now();
    if (!isUnexpired(listener, nowMs) || Date.parse(presentation.ack_deadline_at) <= nowMs) conflict('presentation acknowledgement has expired');
    const now = new Date(nowMs).toISOString();
    const admissionDeadline = new Date(nowMs + REPLY_BINDING_POLICY.providerAcceptanceGraceMs).toISOString();
    const updated = context.db.prepare("UPDATE listener_presentations SET state = 'acked', acked_at = ?, ack_deadline_at = ?, updated_at = ? WHERE id = ? AND state = 'pending'").run(now, admissionDeadline, now, presentation.id);
    if (updated.changes !== 1) conflict('presentation was claimed by another terminal transition');
    context.db.prepare("UPDATE listeners SET state = 'ended', terminal_reason = 'acknowledged', updated_at = ?, ended_at = ? WHERE id = ? AND state IN ('attached', 'waking')").run(now, now, listener.id);
    context.db.prepare("UPDATE endpoints SET state = 'busy', updated_at = ? WHERE id = ? AND process_generation = ? AND state NOT IN ('retiring', 'closed', 'dead', 'takeover_pending')").run(now, listener.endpoint_id, listener.process_generation);
    openOldestUnreadAdmission(context.db, {
      endpoint: {
        id: listener.endpoint_id,
        process_generation: listener.endpoint_process_generation,
        provider_session_id: listener.endpoint_provider_session_id,
        owner_epoch: listener.owner_epoch,
        owner_launch_token: listener.owner_launch_token,
      },
      now,
    });
    return { message_id: presentation.message_id, delivery_id: presentation.target_delivery_id, idempotent_replay: false };
  });
  if (!outcome.idempotent_replay) replyContinuityDiagnostic(context.logger, 'acked');
  return { result: outcome };
});

export const listenerEndOp = operation(LISTENER_END_OPERATION, (context, request, connection) => {
  const outcome = withTransaction(context.db, () => {
    const listener = exactListener(context.db, connection, request, { activeOnly: false });
    requireAttachedConnection(context, listener, connection);
    if (listener.state === 'ended') return true;
    const now = new Date().toISOString();
    if (request.terminal_reason === 'park_expired') {
      if (Date.parse(listener.park_deadline_at) > Date.parse(now)) conflict('listener park deadline has not expired');
      const retirement = admitParkExpiryRetirement(context.db, {
        listenerId: listener.id,
        listenerGeneration: listener.listener_generation,
        now: new Date(now),
      });
      if (!retirement.ended) conflict('listener is no longer endable');
      context.db.prepare("UPDATE reply_waits SET state = 'expired', terminal_reason = 'park_deadline', updated_at = ?, closed_at = ? WHERE id = ? AND state IN ('pending_delivery', 'eligible')").run(now, now, listener.reply_wait_id);
      return false;
    }
    const updated = context.db.prepare("UPDATE listeners SET state = 'ended', terminal_reason = ?, updated_at = ?, ended_at = ? WHERE id = ? AND state IN ('parked', 'attached', 'waking')").run(request.terminal_reason, now, now, listener.id);
    if (updated.changes !== 1) conflict('listener is no longer endable');
    context.db.prepare(
      "UPDATE listener_presentations SET state = 'missed', missed_at = ?, fallback_reason = ?, updated_at = ? WHERE listener_id = ? AND listener_generation = ? AND state = 'pending' AND admitted_at IS NULL",
    ).run(now, request.terminal_reason, now, listener.id, listener.listener_generation);
    if (Date.parse(listener.park_deadline_at) <= Date.parse(now)) {
      context.db.prepare("UPDATE reply_waits SET state = 'expired', terminal_reason = 'park_deadline', updated_at = ?, closed_at = ? WHERE id = ? AND state IN ('pending_delivery', 'eligible')").run(now, now, listener.reply_wait_id);
    }
    return false;
  });
  return { result: { ended: true, idempotent_replay: outcome } };
});
