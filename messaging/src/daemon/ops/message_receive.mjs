// message.receive is the provider-owned admission boundary for a message
// previously staged by an exact endpoint listener.  It deliberately does not
// share message.read's principal-wide semantics: only the stored presentation
// delivery may become read, and only that presentation's optional wait moves.

import { TightbeamError } from '../../protocol/envelope.mjs';
import { withTransaction } from '../db.mjs';
import { openOldestUnreadAdmission } from './delivery_admission.mjs';
import { markExactDeliveryRead } from './message_read.mjs';
import { refreshSessionWatermark } from './message_shared.mjs';
import { completeResumeRequestsForMessage } from './resume_shared.mjs';

function malformed(field) {
  throw new TightbeamError('malformed_request', `${field} is required and must be a non-empty string`, { field });
}

function request(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TightbeamError('malformed_request', 'message.receive payload must be an object', { field: 'payload' });
  }
  for (const field of ['message_id', 'endpoint_id', 'provider_session_id']) {
    if (typeof payload[field] !== 'string' || payload[field].length === 0) malformed(field);
  }
  if (!Number.isSafeInteger(payload.process_generation) || payload.process_generation <= 0) {
    throw new TightbeamError('malformed_request', 'process_generation is required and must be a positive integer', { field: 'process_generation' });
  }
  for (const field of Object.keys(payload)) {
    if (!['message_id', 'endpoint_id', 'process_generation', 'provider_session_id'].includes(field)) {
      throw new TightbeamError('malformed_request', `message.receive declares "${field}", which is not part of its request contract`, { field });
    }
  }
  return payload;
}

function exactPresentation(db, input, appId) {
  return db
    .prepare(
      `SELECT p.id AS presentation_id, p.message_id, p.target_delivery_id, p.reply_wait_id, p.admitted_at,
              m.conversation_id, m.body,
              e.id AS endpoint_id, e.process_generation, e.provider_session_id
         FROM listener_presentations p
         JOIN listeners l ON l.id = p.listener_id AND l.listener_generation = p.listener_generation
         JOIN endpoints e ON e.id = l.endpoint_id
         JOIN deliveries d ON d.id = p.target_delivery_id AND d.endpoint_id = e.id AND d.message_id = p.message_id
         JOIN messages m ON m.id = p.message_id
        WHERE p.message_id = ? AND p.state = 'acked'
          AND e.id = ? AND e.process_generation = ? AND e.provider_session_id = ? AND e.state = 'busy'
          AND l.process_generation = e.process_generation AND l.provider_session_id IS e.provider_session_id
          AND e.created_by_app_id = ?
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT 1`,
    )
    .get(input.message_id, input.endpoint_id, input.process_generation, input.provider_session_id, appId);
}

function exactCurrentOwnerReceipt(db, input, appId) {
  return db
    .prepare(
      `SELECT d.id AS delivery_id, d.read_at, d.admitted_at, m.id AS message_id, m.conversation_id, m.body,
              e.id AS endpoint_id, e.process_generation, e.provider_session_id, e.owner_epoch, e.owner_launch_token
         FROM deliveries d
         JOIN messages m ON m.id = d.message_id
         JOIN endpoints e ON e.id = d.endpoint_id
        WHERE d.message_id = ? AND d.state != 'failed'
          AND e.id = ? AND e.process_generation = ? AND e.provider_session_id = ?
          AND e.created_by_app_id = ? AND e.state IN ('idle', 'busy')
          AND d.admission_opened_at IS NOT NULL AND d.takeover_decided_at IS NULL
          AND d.admission_process_generation = e.process_generation
          AND d.admission_provider_session_id IS e.provider_session_id
          AND d.admission_owner_epoch = e.owner_epoch
          AND d.admission_owner_launch_token IS e.owner_launch_token
          AND (
            d.read_at IS NOT NULL
            OR (
              d.admitted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM deliveries earlier
                 WHERE earlier.endpoint_id = e.id AND earlier.state != 'failed'
                   AND earlier.read_at IS NULL
                   AND (
                     earlier.created_at < d.created_at
                     OR (earlier.created_at = d.created_at AND earlier.id < d.id)
                   )
              )
            )
          )
        ORDER BY d.created_at ASC, d.id ASC
        LIMIT 1`,
    )
    .get(input.message_id, input.endpoint_id, input.process_generation, input.provider_session_id, appId);
}

function admitCurrentOwnerReceipt(db, current, input, now) {
  const admitted = db
    .prepare(
      `UPDATE deliveries
          SET admitted_at = ?, read_at = ?, updated_at = ?
        WHERE id = ? AND read_at IS NULL AND admitted_at IS NULL AND takeover_decided_at IS NULL
          AND admission_process_generation = ? AND admission_provider_session_id IS ?
          AND admission_owner_epoch = ? AND admission_owner_launch_token IS ?
          AND NOT EXISTS (
            SELECT 1 FROM deliveries earlier
             WHERE earlier.endpoint_id = ? AND earlier.state != 'failed' AND earlier.read_at IS NULL
               AND (
                 earlier.created_at < (SELECT created_at FROM deliveries WHERE id = ?)
                 OR (earlier.created_at = (SELECT created_at FROM deliveries WHERE id = ?) AND earlier.id < ?)
               )
          )`,
    )
    .run(
      now, now, now, current.delivery_id,
      input.process_generation, input.provider_session_id, current.owner_epoch, current.owner_launch_token,
      current.endpoint_id, current.delivery_id, current.delivery_id, current.delivery_id,
    );
  return admitted.changes === 1;
}

function admitLinkedPresentation(db, current, input, now) {
  const presentation = db
    .prepare(
      `SELECT p.id AS presentation_id, p.reply_wait_id
         FROM listener_presentations p
         JOIN listeners l ON l.id = p.listener_id AND l.listener_generation = p.listener_generation
        WHERE p.target_delivery_id = ? AND p.message_id = ? AND p.state = 'acked'
          AND l.endpoint_id = ? AND l.process_generation = ? AND l.provider_session_id IS ?
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT 1`,
    )
    .get(current.delivery_id, current.message_id, current.endpoint_id, input.process_generation, input.provider_session_id);
  if (!presentation) return;
  db.prepare("UPDATE listener_presentations SET admitted_at = COALESCE(admitted_at, ?), updated_at = ? WHERE id = ? AND state = 'acked'")
    .run(now, now, presentation.presentation_id);
  if (presentation.reply_wait_id) {
    db.prepare(
      `UPDATE reply_waits SET state = 'satisfied', terminal_reason = 'provider_admission', updated_at = ?, closed_at = ?
        WHERE id = ? AND endpoint_id = ? AND process_generation = ? AND state IN ('eligible', 'pending_delivery')`,
    ).run(now, now, presentation.reply_wait_id, current.endpoint_id, input.process_generation);
  }
}

function openedNextDelivery(db, current) {
  return db.prepare(
    `SELECT id
       FROM deliveries
      WHERE endpoint_id = ? AND state != 'failed' AND read_at IS NULL AND admitted_at IS NULL
        AND admission_opened_at IS NOT NULL AND takeover_decided_at IS NULL
        AND admission_process_generation = ? AND admission_provider_session_id IS ?
        AND admission_owner_epoch = ? AND admission_owner_launch_token IS ?
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
  ).get(
    current.endpoint_id, current.process_generation, current.provider_session_id,
    current.owner_epoch, current.owner_launch_token,
  );
}

// The availability successor is the immediate, token-bound adoption of a
// delivery whose predecessor stopped receiving.  It is intentionally kept
// separate from retirement recovery: no process observation or retirement
// row is necessary to preserve the durable message contract.
function exactAvailabilitySuccessorReceipt(db, input, appId) {
  return db.prepare(
    `SELECT d.id AS delivery_id, d.read_at, m.id AS message_id, m.conversation_id, m.body,
            e.id AS endpoint_id, e.process_generation, e.provider_session_id, e.owner_epoch, e.owner_launch_token,
            r.id AS resume_request_id, r.state AS resume_request_state
       FROM endpoints e
       JOIN deliveries d ON d.endpoint_id = e.id AND d.message_id = ? AND d.state != 'failed'
       JOIN messages m ON m.id = d.message_id
       JOIN resume_requests r
         ON r.endpoint_id = e.id AND r.message_id = d.message_id
        AND r.reason = 'availability_takeover' AND r.session_id = e.provider_session_id
      WHERE e.id = ? AND e.process_generation = ? AND e.provider_session_id = ?
        AND e.launch_mode = 'non_interactive' AND e.state IN ('idle', 'busy')
        AND e.created_by_app_id = ?
        AND d.takeover_decided_at IS NOT NULL
        AND d.admission_process_generation = e.process_generation - 1
        AND d.admission_provider_session_id IS e.provider_session_id
        AND d.admission_owner_epoch = e.owner_epoch - 1
        AND d.admission_owner_launch_token IS NOT e.owner_launch_token
        AND ((d.read_at IS NULL AND r.state = 'claimed' AND EXISTS (
              SELECT 1 FROM claims c
               WHERE c.resource_type = 'resume_request' AND c.resource_id = r.id AND c.state = 'claimed'
            )) OR (d.read_at IS NOT NULL AND r.state = 'completed'
              AND r.admitted_process_generation = e.process_generation
              AND r.admitted_provider_session_id IS e.provider_session_id))
        AND NOT EXISTS (
          SELECT 1 FROM deliveries earlier
           WHERE earlier.endpoint_id = e.id AND earlier.state != 'failed' AND earlier.read_at IS NULL
             AND (earlier.created_at < d.created_at OR (earlier.created_at = d.created_at AND earlier.id < d.id))
        )
      LIMIT 1`,
  ).get(input.message_id, input.endpoint_id, input.process_generation, input.provider_session_id, appId);
}

// The current owner is a headless process: the session itself is
// non_interactive, or (item 42 C) the owner is the daemon's own headless
// resume of an interactive or unknown-mode session. That resume keeps the
// session's launch mode — relabelling it would mark an interactive session
// non_interactive forever — so the proof here is the launch token its
// registration stamped: only a daemon launch carries one, and a pane that
// reopens the session re-registers without it and takes ownership back.
const HEADLESS_OWNER = `(e.launch_mode = 'non_interactive' OR (e.owner_launch_token IS NOT NULL AND length(e.owner_launch_token) > 0))`;

// A successor has no live old listener to acknowledge: that listener belongs
// to the process whose exit the retirement executor already proved. Its
// replacement instead presents only the IDs in the bodyless exact-session
// brief. Receipt is admitted only when the current registered process is the
// immediate generation after that exact terminated retirement and a claimed
// (or already completed) exact-session resume request still names it.
//
// This is deliberately not a principal-wide fallback. It authorizes one
// endpoint delivery, one message id, and one currently registered provider
// session; a later owner/generation must establish its own listener path.
function exactSuccessorReceipt(db, input, appId) {
  return db
    .prepare(
      `SELECT d.id AS delivery_id, d.read_at, m.id AS message_id, m.conversation_id, m.body,
              e.id AS endpoint_id, e.process_generation,
              r.id AS resume_request_id
         FROM endpoints e
         JOIN deliveries d ON d.endpoint_id = e.id AND d.message_id = ? AND d.state != 'failed'
         JOIN messages m ON m.id = d.message_id
         JOIN endpoint_retirements retirement
           ON retirement.endpoint_id = e.id
          AND retirement.state = 'terminated'
          AND retirement.confirmed_exit_at IS NOT NULL
          AND retirement.confirmed_exit_reason IS NOT NULL
          AND e.process_generation = retirement.process_generation + 1
          AND e.provider_session_id = retirement.provider_session_id
         JOIN listeners retired_listener
           ON retired_listener.id = retirement.listener_id
          AND retired_listener.listener_generation = retirement.listener_generation
          AND retired_listener.endpoint_id = e.id
          AND retired_listener.process_generation = retirement.process_generation
          AND retired_listener.provider_session_id IS retirement.provider_session_id
          AND retired_listener.state = 'ended'
         JOIN resume_requests r
           ON r.endpoint_id = e.id
          AND r.session_id = e.provider_session_id
          AND r.state IN ('claimed', 'completed')
        WHERE e.id = ? AND e.process_generation = ? AND e.provider_session_id = ?
          AND ${HEADLESS_OWNER} AND e.state IN ('idle', 'busy')
          AND e.created_by_app_id = ?
          AND (
            d.read_at IS NOT NULL
            OR NOT EXISTS (
              SELECT 1 FROM deliveries earlier
               WHERE earlier.endpoint_id = e.id
                 AND earlier.state != 'failed' AND earlier.read_at IS NULL
                 AND (
                   earlier.created_at < d.created_at
                   OR (earlier.created_at = d.created_at AND earlier.id < d.id)
                 )
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM listeners newer_listener
             WHERE newer_listener.endpoint_id = e.id
               AND (newer_listener.process_generation > retirement.process_generation
                    OR (newer_listener.process_generation = retirement.process_generation
                        AND newer_listener.listener_generation > retirement.listener_generation))
          )
        ORDER BY CASE r.state WHEN 'claimed' THEN 0 ELSE 1 END, r.created_at ASC, r.id ASC
        LIMIT 1`,
    )
    .get(input.message_id, input.endpoint_id, input.process_generation, input.provider_session_id, appId);
}

// Ordinary daemon recovery uses the same bodyless exact-message brief as a
// terminated successor, but has no retired listener to prove. Its authority
// comes from the active recovery request instead: only the current
// non-interactive owner of that exact endpoint/session may receive the
// message that exact claimed (or already completed) request names.
//
// A cold spawn adopts a sessionless placeholder, so its durable request
// retains NULL in session_id. That is safe to accept only through this same
// endpoint's current, nonempty provider session; it is not a principal-wide
// fallback and it never authorizes a different placeholder or later owner.
function exactOrdinaryReceipt(db, input, appId) {
  return db
    .prepare(
      `SELECT d.id AS delivery_id, d.read_at, m.id AS message_id, m.conversation_id, m.body,
              e.id AS endpoint_id, e.process_generation, r.id AS resume_request_id
         FROM endpoints e
         JOIN deliveries d ON d.endpoint_id = e.id AND d.message_id = ? AND d.state != 'failed'
         JOIN messages m ON m.id = d.message_id
         JOIN resume_requests r
           ON r.endpoint_id = e.id
          AND r.message_id = d.message_id
          AND (r.session_id = e.provider_session_id OR r.session_id IS NULL)
        WHERE e.id = ? AND e.process_generation = ? AND e.provider_session_id = ?
          AND e.provider_session_id IS NOT NULL AND e.provider_session_id != ''
          AND ${HEADLESS_OWNER} AND e.state IN ('idle', 'busy')
          AND e.created_by_app_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM endpoint_retirements retirement
             WHERE retirement.endpoint_id = e.id
               AND retirement.state = 'terminated'
               AND retirement.process_generation + 1 = e.process_generation
               AND retirement.provider_session_id IS e.provider_session_id
          )
          AND (
            (d.read_at IS NULL AND r.state = 'claimed')
            OR (
              d.read_at IS NOT NULL AND r.state = 'completed'
              AND r.admitted_at IS NOT NULL
              AND r.admitted_process_generation = e.process_generation
              AND r.admitted_provider_session_id = e.provider_session_id
            )
          )
        ORDER BY CASE r.state WHEN 'claimed' THEN 0 ELSE 1 END, r.created_at ASC, r.id ASC
        LIMIT 1`,
    )
    .get(input.message_id, input.endpoint_id, input.process_generation, input.provider_session_id, appId);
}

export const messageReceiveOp = {
  name: 'message.receive',
  allowedScopes: ['agent'],
  permission: 'read_inbox',
  handler(context, payload, connection) {
    const input = request(payload);
    const outcome = withTransaction(context.db, () => {
      // v22 delivery admission is authoritative even when a parked Stop
      // presentation exists.  The presentation is transport compatibility,
      // updated only after the delivery CAS wins; legacy presentations with
      // no admission window retain their older branch below.
      const current = exactCurrentOwnerReceipt(context.db, input, connection.appId);
      const presentation = current ? null : exactPresentation(context.db, input, connection.appId);
      const availability = presentation || current ? null : exactAvailabilitySuccessorReceipt(context.db, input, connection.appId);
      const successor = presentation || current || availability ? null : exactSuccessorReceipt(context.db, input, connection.appId);
      const ordinary = presentation || current || availability || successor ? null : exactOrdinaryReceipt(context.db, input, connection.appId);
      if (!presentation && !current && !availability && !successor && !ordinary) {
        throw new TightbeamError('permission_denied', 'message.receive is not granted for this exact listener presentation');
      }
      if (current) {
        if (current.read_at) {
          // Receipt committed before its compatibility wake is recoverable:
          // an idempotent exact replay must repair the already-open next
          // notification without touching durable receipt timestamps.
          const next = openedNextDelivery(context.db, current);
          return {
            result: {
              message_id: current.message_id,
              conversation_id: current.conversation_id,
              body: current.body,
              idempotent_replay: true,
            },
            wake: next ? { deliveryId: next.id, sessionId: current.provider_session_id } : null,
          };
        }
        const now = new Date().toISOString();
        if (!admitCurrentOwnerReceipt(context.db, current, input, now)) {
          throw new TightbeamError('listener_conflict', 'current-owner delivery is no longer readable');
        }
        admitLinkedPresentation(context.db, current, input, now);
        completeResumeRequestsForMessage(context.db, {
          messageId: current.message_id,
          principalId: context.db.prepare('SELECT principal_id FROM endpoints WHERE id = ?').get(current.endpoint_id).principal_id,
          endpointId: current.endpoint_id,
          now,
        });
        const next = openOldestUnreadAdmission(context.db, {
          endpoint: {
            id: current.endpoint_id,
            process_generation: current.process_generation,
            provider_session_id: current.provider_session_id,
            owner_epoch: current.owner_epoch,
            owner_launch_token: current.owner_launch_token,
          },
          now,
        });
        return {
          result: {
            message_id: current.message_id,
            conversation_id: current.conversation_id,
            body: current.body,
            idempotent_replay: false,
          },
          wake: next ? { deliveryId: next.delivery_id, sessionId: current.provider_session_id } : null,
        };
      }
      if (availability) {
        const endpoint = {
          id: availability.endpoint_id,
          process_generation: availability.process_generation,
          provider_session_id: availability.provider_session_id,
          owner_epoch: availability.owner_epoch,
          owner_launch_token: availability.owner_launch_token,
        };
        if (availability.read_at) {
          const next = openOldestUnreadAdmission(context.db, { endpoint });
          return {
            result: {
              message_id: availability.message_id,
              conversation_id: availability.conversation_id,
              body: availability.body,
              idempotent_replay: true,
            },
            wake: next ? { deliveryId: next.delivery_id, sessionId: availability.provider_session_id } : null,
          };
        }
        const now = new Date().toISOString();
        const admitted = context.db.prepare(
          `UPDATE resume_requests
              SET admitted_at = ?, admitted_process_generation = ?, admitted_provider_session_id = ?, updated_at = ?
            WHERE id = ? AND reason = 'availability_takeover' AND state = 'claimed'
              AND admitted_at IS NULL AND admitted_process_generation IS NULL AND admitted_provider_session_id IS NULL`,
        ).run(now, availability.process_generation, availability.provider_session_id, now, availability.resume_request_id);
        if (admitted.changes !== 1) {
          throw new TightbeamError('listener_conflict', 'availability successor receipt was claimed by another owner');
        }
        if (!markExactDeliveryRead(context.db, {
          deliveryId: availability.delivery_id,
          endpointId: availability.endpoint_id,
          now,
          resumeRequestId: availability.resume_request_id,
        })) {
          throw new TightbeamError('listener_conflict', 'availability successor delivery is no longer readable');
        }
        const next = openOldestUnreadAdmission(context.db, { endpoint, now });
        return {
          result: {
            message_id: availability.message_id,
            conversation_id: availability.conversation_id,
            body: availability.body,
            idempotent_replay: false,
          },
          wake: next ? { deliveryId: next.delivery_id, sessionId: availability.provider_session_id } : null,
        };
      }
      if (successor) {
        if (successor.read_at) {
          return { result: {
            message_id: successor.message_id,
            conversation_id: successor.conversation_id,
            body: successor.body,
            idempotent_replay: true,
          }, wake: null };
        }
        const now = new Date().toISOString();
        if (!markExactDeliveryRead(context.db, {
          deliveryId: successor.delivery_id,
          endpointId: successor.endpoint_id,
          now,
          completeResumeRequests: true,
        })) {
          throw new TightbeamError('listener_conflict', 'successor delivery is no longer readable');
        }
        return { result: {
          message_id: successor.message_id,
          conversation_id: successor.conversation_id,
          body: successor.body,
          idempotent_replay: false,
        }, wake: null };
      }
      if (ordinary) {
        if (ordinary.read_at) {
          return { result: {
            message_id: ordinary.message_id,
            conversation_id: ordinary.conversation_id,
            body: ordinary.body,
            idempotent_replay: true,
          }, wake: null };
        }
        const now = new Date().toISOString();
        const admitted = context.db
          .prepare(
            `UPDATE resume_requests
                SET admitted_at = ?, admitted_process_generation = ?, admitted_provider_session_id = ?, updated_at = ?
              WHERE id = ? AND state = 'claimed'
                AND admitted_at IS NULL AND admitted_process_generation IS NULL AND admitted_provider_session_id IS NULL`,
          )
          .run(now, input.process_generation, input.provider_session_id, now, ordinary.resume_request_id);
        if (admitted.changes !== 1) {
          throw new TightbeamError('listener_conflict', 'ordinary recovery receipt was claimed by another owner');
        }
        if (!markExactDeliveryRead(context.db, {
          deliveryId: ordinary.delivery_id,
          endpointId: ordinary.endpoint_id,
          now,
          resumeRequestId: ordinary.resume_request_id,
        })) {
          throw new TightbeamError('listener_conflict', 'ordinary recovery delivery is no longer readable');
        }
        return { result: {
          message_id: ordinary.message_id,
          conversation_id: ordinary.conversation_id,
          body: ordinary.body,
          idempotent_replay: false,
        }, wake: null };
      }
      if (presentation.admitted_at) {
        return { result: {
          message_id: presentation.message_id,
          conversation_id: presentation.conversation_id,
          body: presentation.body,
          idempotent_replay: true,
        }, wake: null };
      }

      const now = new Date().toISOString();
      const admitted = context.db
        .prepare('UPDATE listener_presentations SET admitted_at = ?, updated_at = ? WHERE id = ? AND admitted_at IS NULL AND state = \'acked\'')
        .run(now, now, presentation.presentation_id);
      if (admitted.changes !== 1) {
        throw new TightbeamError('listener_conflict', 'listener presentation is no longer admitable');
      }
      if (!markExactDeliveryRead(context.db, {
        deliveryId: presentation.target_delivery_id,
        endpointId: presentation.endpoint_id,
        now,
        completeResumeRequests: false,
      })) {
        throw new TightbeamError('listener_conflict', 'target delivery is no longer readable by this listener presentation');
      }
      if (presentation.reply_wait_id) {
        context.db
          .prepare(
            `UPDATE reply_waits SET state = 'satisfied', terminal_reason = 'provider_admission', updated_at = ?, closed_at = ?
              WHERE id = ? AND endpoint_id = ? AND process_generation = ? AND state IN ('eligible', 'pending_delivery')`,
          )
          .run(now, now, presentation.reply_wait_id, presentation.endpoint_id, presentation.process_generation);
      }
      return { result: {
        message_id: presentation.message_id,
        conversation_id: presentation.conversation_id,
        body: presentation.body,
        idempotent_replay: false,
      }, wake: null };
    });
    if (outcome.wake) {
      refreshSessionWatermark({
        stateRoot: context.stateRoot,
        sessionId: outcome.wake.sessionId,
        deliveryId: outcome.wake.deliveryId,
        wake: 'next_unread',
        logger: context.logger,
      });
    }
    return { result: outcome.result };
  },
};
