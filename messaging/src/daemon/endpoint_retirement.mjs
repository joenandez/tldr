// Retirement admission is deliberately narrower than retirement execution.
// It records that one exact listener owner needs custody review; it never
// treats expiry or a missing provider admission as process-death or resume
// authority.

import { generateId } from '../protocol/ids.mjs';
import { ownerProcessTupleIsAbsent, ownerProcessTupleIssue } from './owner_process_contract.mjs';

const ACTIVE_LISTENER_STATES = "('parked', 'attached', 'waking')";
const OWNER_UNVERIFIED = 'owner_process_unverified';
const PARK_EXPIRY = 'park_expired';
const ADMISSION_TIMEOUT = 'provider_admission_timeout';

function statusFor(row) {
  if (!row) return { status: 'none', failure_reason: null };
  if (row.state === 'pending') return { status: 'pending', failure_reason: null };
  if (row.state === 'failed') return { status: 'failed', failure_reason: row.failure_reason ?? 'failed' };
  return { status: row.state, failure_reason: row.failure_reason ?? null };
}

function currentListener(db, { listenerId, listenerGeneration }) {
  return db
    .prepare(
      `SELECT l.*, e.state AS endpoint_state, e.runtime, e.launch_mode, e.provider_session_id AS endpoint_provider_session_id,
              e.process_generation AS endpoint_process_generation,
              e.owner_epoch, e.owner_launch_token,
              e.owner_process_pid, e.owner_process_start_identity, e.owner_process_group_id,
              e.owner_process_capture_source, e.owner_process_generation
         FROM listeners l
         JOIN endpoints e ON e.id = l.endpoint_id
        WHERE l.id = ? AND l.listener_generation = ?`,
    )
    .get(listenerId, listenerGeneration);
}

function retirementForListener(db, listener) {
  return db
    .prepare(
      `SELECT state, failure_reason
         FROM endpoint_retirements
        WHERE endpoint_id = ? AND process_generation = ? AND listener_generation = ?`,
    )
    .get(listener.endpoint_id, listener.process_generation, listener.listener_generation) ?? null;
}

function retirementAdmission(db, { listenerId, listenerGeneration, cause, now = new Date() }) {
  const listener = currentListener(db, { listenerId, listenerGeneration });
  if (!listener) return { admitted: false, ended: false, ...statusFor(null) };
  if (cause === ADMISSION_TIMEOUT) {
    const newerActive = db
      .prepare(
        `SELECT 1
           FROM listeners
          WHERE endpoint_id = ? AND process_generation = ? AND listener_generation > ?
            AND state IN ${ACTIVE_LISTENER_STATES}
          LIMIT 1`,
      )
      .get(listener.endpoint_id, listener.process_generation, listener.listener_generation);
    if (newerActive) return { admitted: false, ended: false, ...statusFor(null) };
  }
  const timestamp = now.toISOString();
  const terminalReason = cause === PARK_EXPIRY ? PARK_EXPIRY : ADMISSION_TIMEOUT;
  const eligibleStates = cause === PARK_EXPIRY ? ['idle'] : ['idle', 'busy'];
  const eligibleStateSql = cause === PARK_EXPIRY ? "= 'idle'" : "IN ('idle', 'busy')";
  const ended = db
    .prepare(
      `UPDATE listeners
          SET state = 'ended', terminal_reason = ?, updated_at = ?, ended_at = ?
        WHERE id = ? AND listener_generation = ? AND state IN ${ACTIVE_LISTENER_STATES}`,
    )
    .run(terminalReason, timestamp, timestamp, listener.id, listener.listener_generation).changes === 1;

  const existing = retirementForListener(db, listener);
  if (existing) return { admitted: true, ended, ...statusFor(existing) };

  // A stale listener is still ended, but it cannot name current custody.
  // Retirement therefore never changes a newer endpoint generation/session.
  if (
    listener.endpoint_process_generation !== listener.process_generation ||
    listener.endpoint_provider_session_id !== listener.provider_session_id ||
    !eligibleStates.includes(listener.endpoint_state) ||
    listener.launch_mode === 'non_interactive'
  ) {
    return { admitted: false, ended, ...statusFor(null) };
  }

  const issue = ownerProcessTupleIssue(listener, { runtime: listener.runtime, processGeneration: listener.process_generation });
  const verifiedOwner = issue === null && !ownerProcessTupleIsAbsent(listener);
  // Item 42 C: only a verified owner moves behind the retirement fence,
  // where the executor re-observes it (gone -> dead, alive -> idle again).
  // Without one nothing can ever decide the retirement, and `retiring`
  // would refuse every later hook state write for a session that may still
  // be open; the endpoint keeps its ordinary custody (work stays enqueued)
  // and the failed row below records why no retirement ran.
  const endpointUpdated = verifiedOwner
    ? db
        .prepare(
          `UPDATE endpoints
              SET state = 'retiring', updated_at = ?
            WHERE id = ? AND process_generation = ? AND state ${eligibleStateSql} AND launch_mode IS NOT 'non_interactive'`,
        )
        .run(timestamp, listener.endpoint_id, listener.process_generation).changes === 1
    : db
        .prepare(`SELECT 1 FROM endpoints WHERE id = ? AND process_generation = ? AND state ${eligibleStateSql} AND launch_mode IS NOT 'non_interactive'`)
        .get(listener.endpoint_id, listener.process_generation) !== undefined;
  if (!endpointUpdated) return { admitted: false, ended, ...statusFor(null) };

  const state = verifiedOwner ? 'pending' : 'failed';
  const failureReason = verifiedOwner ? null : OWNER_UNVERIFIED;
  const owner = verifiedOwner
    ? [
        listener.owner_process_pid,
        listener.owner_process_start_identity,
        listener.owner_process_group_id,
        listener.owner_process_capture_source,
        listener.owner_process_generation,
      ]
    : [null, null, null, null, null];
  db.prepare(
    `INSERT INTO endpoint_retirements
       (id, endpoint_id, process_generation, listener_id, listener_generation, state, cause,
        owner_process_pid, owner_process_start_identity, owner_process_group_id, owner_process_capture_source, owner_process_generation,
        owner_epoch, owner_launch_token, provider_session_id,
        failure_reason, confirmed_exit_at, confirmed_exit_reason, created_at, updated_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
  ).run(
    generateId('endpoint_retirement'),
    listener.endpoint_id,
    listener.process_generation,
    listener.id,
    listener.listener_generation,
    state,
    cause,
    ...owner,
    listener.owner_epoch,
    listener.owner_launch_token,
    listener.provider_session_id,
    failureReason,
    timestamp,
    timestamp,
    state === 'failed' ? timestamp : null,
  );
  return { admitted: true, ended, ...statusFor({ state, failure_reason: failureReason }) };
}

/**
 * Ends one past-deadline listener and records the only safe retirement
 * outcome for its exact endpoint/process/listener generation. Callers must
 * hold the surrounding database transaction so listener end, endpoint fence,
 * and retirement row commit (or roll back) together.
 */
export function admitParkExpiryRetirement(db, { listenerId, listenerGeneration, now = new Date() }) {
  const listener = currentListener(db, { listenerId, listenerGeneration });
  if (!listener || Date.parse(listener.park_deadline_at) > now.getTime()) {
    return { expired: false, ended: false, ...statusFor(null) };
  }
  const admitted = retirementAdmission(db, { listenerId, listenerGeneration, cause: PARK_EXPIRY, now });
  return { expired: true, ...admitted };
}

/**
 * A presentation with no exact provider admission remains unread, but after
 * its bounded admission deadline the same exact owner must move behind the
 * retirement fence rather than create a competing resume request.
 */
export function admitProviderAdmissionTimeoutRetirement(db, { listenerId, listenerGeneration, presentationId, now = new Date() }) {
  const presentation = db
    .prepare(
      `SELECT id, target_delivery_id
         FROM listener_presentations
        WHERE id = ? AND listener_id = ? AND listener_generation = ?
          AND state IN ('acked', 'missed') AND admitted_at IS NULL AND ack_deadline_at <= ?`,
    )
    .get(presentationId, listenerId, listenerGeneration, now.toISOString());
  if (!presentation) return { timed_out: false, ended: false, ...statusFor(null) };
  // The first unadmitted presentation is recoverable: it records a durable
  // missed attempt and leaves the same endpoint/process available for the
  // next Stop cycle to present that exact unread delivery again. Only a
  // second missed presentation for that same owner can cross the destructive
  // retirement fence. Historical presentation rows are the durable counter;
  // no volatile timer or connection fact gets to authorize retirement.
  const earlierMiss = db
    .prepare(
      `SELECT 1
         FROM listener_presentations prior
         JOIN listeners prior_listener
           ON prior_listener.id = prior.listener_id
          AND prior_listener.listener_generation = prior.listener_generation
         JOIN listeners current_listener
           ON current_listener.id = ?
          AND current_listener.listener_generation = ?
        WHERE prior.target_delivery_id = ?
          AND prior.id != ?
          AND prior.state = 'missed'
          AND prior.admitted_at IS NULL
          AND prior_listener.endpoint_id = current_listener.endpoint_id
          AND prior_listener.process_generation = current_listener.process_generation
        LIMIT 1`,
    )
    .get(listenerId, listenerGeneration, presentation.target_delivery_id, presentation.id);
  if (!earlierMiss) return { timed_out: true, recoverable: true, ended: false, ...statusFor(null) };
  const newerPresentation = db
    .prepare(
      `SELECT 1
         FROM listener_presentations newer
         JOIN listeners newer_listener ON newer_listener.id = newer.listener_id AND newer_listener.listener_generation = newer.listener_generation
         JOIN listeners current_listener ON current_listener.id = ? AND current_listener.listener_generation = ?
        WHERE newer.target_delivery_id = ?
          AND newer.listener_generation > ?
          AND newer_listener.endpoint_id = current_listener.endpoint_id
          AND newer_listener.process_generation = current_listener.process_generation
        LIMIT 1`,
    )
    .get(listenerId, listenerGeneration, presentation.target_delivery_id, listenerGeneration);
  if (newerPresentation) return { timed_out: false, ended: false, ...statusFor(null) };
  const admitted = retirementAdmission(db, { listenerId, listenerGeneration, cause: ADMISSION_TIMEOUT, now });
  return { timed_out: true, ...admitted };
}

export function endpointRetirementStatus(db, endpointId) {
  const endpoint = db.prepare('SELECT id, state, process_generation FROM endpoints WHERE id = ?').get(endpointId);
  if (!endpoint) return null;
  const retirement = db
    .prepare(
      `SELECT state, failure_reason
         FROM endpoint_retirements
        WHERE endpoint_id = ? AND process_generation = ?
        ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(endpoint.id, endpoint.process_generation) ?? null;
  return { endpoint_id: endpoint.id, endpoint_state: endpoint.state, ...statusFor(retirement) };
}
