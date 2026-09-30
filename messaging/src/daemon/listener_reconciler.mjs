// Durable recovery for listener.v1. The event bus only carries a live hint;
// these rows decide whether a committed reply is handed to its hook or one
// existing resume request exactly once.

import { withTransaction } from './db.mjs';
import { randomBytes } from 'node:crypto';
import { generateId } from '../protocol/ids.mjs';
import { REPLY_BINDING_POLICY } from './reply_listener_policy.mjs';
import { replyContinuityDiagnostic } from './reply_continuity_diagnostics.mjs';
import { admitParkExpiryRetirement, admitProviderAdmissionTimeoutRetirement } from './endpoint_retirement.mjs';
import { refreshSessionWatermark } from './ops/message_shared.mjs';
import { runEndpointRetirementExecutor, runOwnerProcessReconciliation } from './retirement_executor.mjs';
import { endUnsupportedTachyonListeners, isTachyonArmedForGeneration } from './tachyon_arming.mjs';
import { liveResumeChildFor } from './resumer.mjs';

export const LISTENER_RECONCILE_TICK_MS = 1000;

// Item 42 B/C: how often recorded owner processes are checked for exit.
// One `ps` snapshot per pass, and only when some endpoint is watched. Ten
// seconds bounds how long a stopped `codex exec` stays busy, or a closed
// pane's work waits, without polling the process table every tick.
export const OWNER_RECONCILE_INTERVAL_MS = 10_000;
function endListener(db, listener, reason, now) {
  return db
    .prepare("UPDATE listeners SET state = 'ended', terminal_reason = ?, updated_at = ?, ended_at = ? WHERE id = ? AND state IN ('parked', 'attached', 'waking')")
    .run(reason, now, now, listener.id).changes === 1;
}

function expireReplyWait(db, waitId, now) {
  db.prepare("UPDATE reply_waits SET state = 'expired', terminal_reason = 'park_deadline', updated_at = ?, closed_at = ? WHERE id = ? AND state IN ('pending_delivery', 'eligible')").run(now, now, waitId);
}

function reparkListener(db, listener, now) {
  const leaseExpiresAt = new Date(Math.min(Date.parse(now) + REPLY_BINDING_POLICY.listenerLeaseMs, Date.parse(listener.park_deadline_at))).toISOString();
  const parked = db
    .prepare("UPDATE listeners SET state = 'parked', lease_expires_at = ?, terminal_reason = NULL, updated_at = ? WHERE id = ? AND state IN ('parked', 'attached', 'waking')")
    .run(leaseExpiresAt, now, listener.id);
  if (parked.changes !== 1) return false;
  return true;
}

function missPresentation(context, listener, presentation, reason, now) {
  const { db } = context;
  const missed = db
    .prepare("UPDATE listener_presentations SET state = 'missed', missed_at = ?, fallback_reason = ?, updated_at = ? WHERE id = ? AND state IN ('pending', 'acked') AND admitted_at IS NULL")
    .run(now, reason, now, presentation.id);
  if (missed.changes !== 1) return { missed: false, retirement: null };
  const retirement = admitProviderAdmissionTimeoutRetirement(db, {
    listenerId: presentation.listener_id,
    listenerGeneration: presentation.listener_generation,
    presentationId: presentation.id,
    now: new Date(now),
  });
  // The reply stays unread. Ring the session's tool-boundary doorbell so a
  // busy session drains it at its next tool call instead of only at Stop,
  // but only while that same session can still drain: a retiring or
  // taken-over endpoint refuses message.notification.next at every call.
  const endpoint = db.prepare('SELECT state, provider_session_id, process_generation FROM endpoints WHERE id = ?').get(listener.endpoint_id);
  if (
    (endpoint?.state === 'idle' || endpoint?.state === 'busy')
    && endpoint.provider_session_id === listener.provider_session_id
    && endpoint.process_generation === listener.process_generation
  ) {
    refreshSessionWatermark({ stateRoot: context.stateRoot, sessionId: endpoint.provider_session_id, deliveryId: presentation.target_delivery_id, logger: context.logger });
  }
  return { missed: true, retirement };
}

function restoreSameOwnerAvailability(db, presentation, now) {
  db.prepare(
    `UPDATE endpoints
        SET state = 'idle', updated_at = ?
      WHERE id = (
        SELECT endpoint_id FROM listeners WHERE id = ? AND listener_generation = ?
      )
        AND process_generation = (
          SELECT process_generation FROM listeners WHERE id = ? AND listener_generation = ?
        )
        AND provider_session_id IS (
          SELECT provider_session_id FROM listeners WHERE id = ? AND listener_generation = ?
        )
        AND state = 'busy'`,
  ).run(
    now,
    presentation.listener_id,
    presentation.listener_generation,
    presentation.listener_id,
    presentation.listener_generation,
    presentation.listener_id,
    presentation.listener_generation,
  );
}

function presentationRows(db, listenerId) {
  return db
    .prepare("SELECT id, listener_id, listener_generation, message_id, target_delivery_id, state, ack_deadline_at FROM listener_presentations WHERE listener_id = ? ORDER BY created_at ASC, id ASC")
    .all(listenerId);
}

function admissionCandidates(db) {
  return db.prepare(
    `SELECT d.id AS delivery_id, d.message_id, d.admission_opened_at, d.retry_armed_at,
            d.admission_process_generation, d.admission_provider_session_id,
            d.admission_owner_epoch, d.admission_owner_launch_token,
            e.id AS endpoint_id, e.principal_id, e.provider_session_id, e.process_generation,
            e.owner_epoch, e.owner_launch_token, e.authority_reference, m.conversation_id
       FROM deliveries d
       JOIN endpoints e ON e.id = d.endpoint_id
       JOIN messages m ON m.id = d.message_id
      WHERE d.state != 'failed' AND d.read_at IS NULL AND d.admitted_at IS NULL
        AND d.admission_opened_at IS NOT NULL AND d.takeover_decided_at IS NULL
        AND e.state IN ('idle', 'busy')
        AND d.admission_process_generation = e.process_generation
        AND d.admission_provider_session_id IS e.provider_session_id
        AND d.admission_owner_epoch = e.owner_epoch
        AND d.admission_owner_launch_token IS e.owner_launch_token
        AND NOT EXISTS (
          SELECT 1 FROM deliveries earlier
           WHERE earlier.endpoint_id = d.endpoint_id AND earlier.state != 'failed'
             AND earlier.read_at IS NULL
             AND (
               earlier.created_at < d.created_at
               OR (earlier.created_at = d.created_at AND earlier.id < d.id)
             )
        )
      ORDER BY d.admission_opened_at ASC, d.endpoint_id ASC, d.created_at ASC, d.id ASC`,
  ).all();
}

function armAdmissionRetry(context, delivery, timestamp) {
  const armed = context.db.prepare(
    `UPDATE deliveries SET retry_armed_at = ?, updated_at = ?
      WHERE id = ? AND read_at IS NULL AND admitted_at IS NULL AND retry_armed_at IS NULL AND takeover_decided_at IS NULL
        AND admission_process_generation = ? AND admission_provider_session_id IS ?
        AND admission_owner_epoch = ? AND admission_owner_launch_token IS ?`,
  ).run(
    timestamp, timestamp, delivery.delivery_id, delivery.process_generation, delivery.provider_session_id,
    delivery.owner_epoch, delivery.owner_launch_token,
  );
  if (armed.changes !== 1) return false;
  refreshSessionWatermark({
    stateRoot: context.stateRoot,
    sessionId: delivery.provider_session_id,
    deliveryId: delivery.delivery_id,
    wake: 'retry',
    logger: context.logger,
  });
  return true;
}

function decideAvailabilityTakeover(db, delivery, timestamp) {
  if (db.prepare("SELECT 1 FROM resume_requests WHERE endpoint_id = ? AND message_id = ? AND reason = 'availability_takeover'")
    .get(delivery.endpoint_id, delivery.message_id)) return false;
  const token = randomBytes(32).toString('hex');
  const endpoint = db.prepare(
    `UPDATE endpoints
        SET state = 'takeover_pending', owner_epoch = owner_epoch + 1, owner_launch_token = ?, updated_at = ?
      WHERE id = ? AND state IN ('idle', 'busy') AND process_generation = ? AND provider_session_id IS ?
        AND owner_epoch = ? AND owner_launch_token IS ?
        AND EXISTS (
          SELECT 1 FROM deliveries
           WHERE id = ? AND read_at IS NULL AND admitted_at IS NULL AND takeover_decided_at IS NULL
             AND admission_process_generation = ? AND admission_provider_session_id IS ?
             AND admission_owner_epoch = ? AND admission_owner_launch_token IS ?
        )`,
  ).run(
    token, timestamp, delivery.endpoint_id, delivery.process_generation, delivery.provider_session_id,
    delivery.owner_epoch, delivery.owner_launch_token, delivery.delivery_id,
    delivery.process_generation, delivery.provider_session_id, delivery.owner_epoch, delivery.owner_launch_token,
  );
  if (endpoint.changes !== 1) return false;
  const decided = db.prepare(
    `UPDATE deliveries SET takeover_decided_at = ?, updated_at = ?
      WHERE id = ? AND read_at IS NULL AND admitted_at IS NULL AND takeover_decided_at IS NULL
        AND admission_process_generation = ? AND admission_provider_session_id IS ?
        AND admission_owner_epoch = ? AND admission_owner_launch_token IS ?`,
  ).run(
    timestamp, timestamp, delivery.delivery_id, delivery.process_generation, delivery.provider_session_id,
    delivery.owner_epoch, delivery.owner_launch_token,
  );
  if (decided.changes !== 1) return false;
  db.prepare(
    `INSERT INTO resume_requests
      (id, endpoint_id, principal_id, session_id, conversation_id, message_id, reason, authority_reference, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'availability_takeover', ?, 'pending', ?, ?)`,
  ).run(
    generateId('resume_request'), delivery.endpoint_id, delivery.principal_id, delivery.provider_session_id,
    delivery.conversation_id, delivery.message_id, delivery.authority_reference, timestamp, timestamp,
  );
  return true;
}

// Item 48: a delivery whose admission owner has not received it within 60 s
// is not taken over while a resume child this daemon launched for the
// endpoint is still running. That child is the owner (a resumed `codex
// exec` first finishes a killed turn, W4: 104 s) or will re-register as it;
// a takeover beside it would resume the same session twice. Once it exits,
// the next pass decides as before. The last deferral logged per delivery is
// kept so a deferral spanning many 1 s passes logs once.
const loggedAdmissionDeferrals = new WeakMap();

function deferAvailabilityTakeover(context, delivery, inFlight, nowMs) {
  let logged = loggedAdmissionDeferrals.get(context);
  if (!logged) {
    logged = new Map();
    loggedAdmissionDeferrals.set(context, logged);
  }
  if (logged.get(delivery.delivery_id) === inFlight) return;
  logged.set(delivery.delivery_id, inFlight);
  context.logger?.info({
    event: 'availability_takeover_decision',
    params: { delivery_id: delivery.delivery_id, endpoint_id: delivery.endpoint_id, message_id: delivery.message_id },
    result: {
      decision: 'deferred_in_flight',
      in_flight_request_id: inFlight.requestId,
      in_flight_pid: inFlight.pid,
      admission_age_ms: nowMs - Date.parse(delivery.admission_opened_at),
    },
    status: 'ok',
  });
}

function logAvailabilityTakeoverDecided(context, delivery, nowMs) {
  const deferred = loggedAdmissionDeferrals.get(context)?.has(delivery.delivery_id) ?? false;
  context.logger?.info({
    event: 'availability_takeover_decision',
    params: { delivery_id: delivery.delivery_id, endpoint_id: delivery.endpoint_id, message_id: delivery.message_id },
    result: { decision: 'decided', was_deferred: deferred, admission_age_ms: nowMs - Date.parse(delivery.admission_opened_at) },
    status: 'ok',
  });
}

// Deliveries that left the candidate set (received, or decided) no longer
// need their deferral remembered.
function pruneAdmissionDeferrals(context, candidateIds) {
  const logged = loggedAdmissionDeferrals.get(context);
  if (!logged || logged.size === 0) return;
  for (const deliveryId of logged.keys()) if (!candidateIds.has(deliveryId)) logged.delete(deliveryId);
}

/**
 * Reconcile one bounded snapshot. Startup treats every active listener as
 * socketless. Runtime only changes rows whose durable deadline has elapsed
 * (or whose connection was reported by the event bus).
 */
export function runListenerReconciliation(context, { now = new Date(), startup = false, disconnected = [] } = {}) {
  const timestamp = now.toISOString();
  const nowMs = now.getTime();
  const disconnectedKeys = new Set(disconnected.map(({ listenerId, listenerGeneration }) => `${listenerId}\u0000${listenerGeneration}`));
  const summary = { ended: 0, missed: 0, retirements: 0, reparks: 0, retries: 0, takeovers: 0, takeover_deferrals: 0 };

  withTransaction(context.db, () => {
    const listeners = context.db
      .prepare(`SELECT l.*, rw.state AS reply_wait_state, e.tachyon_armed_process_generation
                  FROM listeners l JOIN endpoints e ON e.id = l.endpoint_id
                  LEFT JOIN reply_waits rw ON rw.id = l.reply_wait_id
                 WHERE l.state IN ('parked', 'attached', 'waking') ORDER BY l.created_at ASC, l.id ASC`)
      .all();
    for (const listener of listeners) {
      if (!isTachyonArmedForGeneration(listener, listener.process_generation)) {
        summary.ended += endUnsupportedTachyonListeners(context.db, {
          endpointId: listener.endpoint_id, processGeneration: listener.process_generation, now: timestamp,
        });
        continue;
      }
      const connectionLost = startup || disconnectedKeys.has(`${listener.id}\u0000${listener.listener_generation}`);
      const parkExpired = Date.parse(listener.park_deadline_at) <= nowMs;
      const leaseExpired = listener.lease_expires_at !== null && Date.parse(listener.lease_expires_at) <= nowMs;
      const presentations = presentationRows(context.db, listener.id);
      const pending = presentations.filter((presentation) => presentation.state === 'pending');
      const shouldMiss = pending.length > 0 && pending.some((p) => Date.parse(p.ack_deadline_at) <= nowMs);
      if (shouldMiss) {
        const reason = connectionLost ? 'connection_lost' : 'ack_deadline';
        for (const presentation of pending) {
          if (connectionLost || Date.parse(presentation.ack_deadline_at) <= nowMs) {
            const outcome = missPresentation(context, listener, presentation, reason, timestamp);
            if (outcome.missed) {
              summary.missed += 1;
              if (outcome.retirement?.admitted) summary.retirements += 1;
              if (outcome.retirement?.recoverable) restoreSameOwnerAvailability(context.db, presentation, timestamp);
              replyContinuityDiagnostic(context.logger, reason === 'connection_lost' ? 'disconnect' : 'deadline');
              replyContinuityDiagnostic(context.logger, 'fallback');
            }
          }
        }
        if (endListener(context.db, listener, 'presentation_missed', timestamp)) summary.ended += 1;
        continue;
      }

      if (parkExpired) {
        expireReplyWait(context.db, listener.reply_wait_id, timestamp);
        const retirement = admitParkExpiryRetirement(context.db, {
          listenerId: listener.id,
          listenerGeneration: listener.listener_generation,
          now,
        });
        if (retirement.ended) {
          summary.ended += 1;
          replyContinuityDiagnostic(context.logger, 'deadline');
        }
        continue;
      }

      // A disconnected/expired lease can be reattached by the same owner,
      // but it never gets a fresh presentation deadline. The durable
      // presentation row therefore reaches the miss path above, where its
      // historical retry count bounds recovery and eventually permits early
      // retirement. Empty listeners retain the ordinary four-hour park path.
      if (connectionLost || leaseExpired) {
        if (reparkListener(context.db, listener, timestamp)) summary.reparks += 1;
        continue;
      }

    }

    // Delivery admission owns provider-receive timing.  An ACKed Stop
    // presentation remains transport evidence and never enters retirement
    // merely because exact receipt has not yet happened.
    const candidateIds = new Set();
    for (const delivery of admissionCandidates(context.db)) {
      candidateIds.add(delivery.delivery_id);
      const openedAt = Date.parse(delivery.admission_opened_at);
      if (nowMs >= openedAt + 60_000) {
        const inFlight = liveResumeChildFor(context, delivery.endpoint_id);
        if (inFlight) {
          deferAvailabilityTakeover(context, delivery, inFlight, nowMs);
          summary.takeover_deferrals += 1;
        } else if (decideAvailabilityTakeover(context.db, delivery, timestamp)) {
          summary.takeovers += 1;
          logAvailabilityTakeoverDecided(context, delivery, nowMs);
          candidateIds.delete(delivery.delivery_id);
        }
      } else if (nowMs >= openedAt + 30_000 && !delivery.retry_armed_at) {
        if (armAdmissionRetry(context, delivery, timestamp)) summary.retries += 1;
      }
    }
    pruneAdmissionDeferrals(context, candidateIds);
  });
  return summary;
}

export function startListenerReconciler(context) {
  runListenerReconciliation(context, { startup: true });
  let running = false;
  let retirementRunning = false;
  let stopped = false;
  let retirementPromise = Promise.resolve();
  const runRetirements = () => {
    if (stopped || retirementRunning) return;
    retirementRunning = true;
    retirementPromise = (context.runEndpointRetirementExecutor ?? runEndpointRetirementExecutor)(context)
      .catch((err) => context.logger?.error({ event: 'retirement_executor_failed', message: err.message, stack: err.stack }))
      .finally(() => { retirementRunning = false; });
  };
  runRetirements();
  let lastOwnerReconcileMs = 0;
  const runOwnerReconciliation = () => {
    const nowMs = Date.now();
    if (nowMs - lastOwnerReconcileMs < OWNER_RECONCILE_INTERVAL_MS) return;
    lastOwnerReconcileMs = nowMs;
    try {
      (context.runOwnerProcessReconciliation ?? runOwnerProcessReconciliation)(context);
    } catch (err) {
      context.logger?.error({ event: 'owner_process_reconcile_failed', message: err.message, stack: err.stack, status: 'error' });
    }
  };
  runOwnerReconciliation();
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    try {
      const disconnected = context.eventBus?.takeDisconnectedListeners?.() ?? [];
      runListenerReconciliation(context, { disconnected });
      runRetirements();
      runOwnerReconciliation();
    } catch (err) {
      context.logger?.error({ event: 'listener_reconcile_failed', message: err.message, stack: err.stack });
    } finally {
      running = false;
    }
  }, LISTENER_RECONCILE_TICK_MS);
  timer.unref?.();
  context.logger?.info({ event: 'listener_reconciler_started', tick_ms: LISTENER_RECONCILE_TICK_MS, policy: REPLY_BINDING_POLICY.listenerLeaseMs });
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await retirementPromise;
    },
  };
}
