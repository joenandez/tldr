// Session-host push (session_hosts.v1, docs/protocol.md «Session hosts»).
//
// A hosted session that is idle but whose process is alive cannot be resumed
// (Tightbeam never starts a second process on a live session), so its waiting
// mail would sit. This module asks the session's host application to prompt
// it instead. It only ever publishes one event frame: it spawns nothing,
// changes no row, and the existing resume, enqueue, listener and park paths
// run unchanged. Every caller runs AFTER its transaction commits.

import { closedWorkNoticeSql } from './lifecycle_transition.mjs';

export const HOST_WAKE_PROMPT = 'You have new Tightbeam messages. Check your inbox.';

const HOST_SESSIONS_PERMISSION = 'host_sessions';

// The F33 rule (an unread, non-failed delivery that is not a closed-work
// notice) plus the informational opt-out: a message whose whole effect is a
// bare `none` (`agent send --no-reply`) asks nothing of the session, so it
// never prompts a host. The resumer still launches for it today; only the
// host push is narrower.
const hostWakingDeliverySql = (alias) => `${alias}.state != 'failed' AND ${alias}.read_at IS NULL
  AND NOT ${closedWorkNoticeSql(alias)}
  AND NOT EXISTS (SELECT 1 FROM message_effects info_me WHERE info_me.message_id = ${alias}.message_id AND info_me.effect = 'none')`;

// Sent wake ids (-> host name) and already-logged skips, in memory per
// context like the Codex host cache: one send per wake_id per daemon
// lifetime, and one debug line per (wake_id, reason) so a 1 s resumer tick
// never repeats itself.
const sentWakes = new WeakMap();
const loggedSkips = new WeakMap();

function perContext(registry, context, create) {
  let value = registry.get(context);
  if (!value) {
    value = create();
    registry.set(context, value);
  }
  return value;
}

function logSkip(context, { wakeId, endpointId, hostName, reason }) {
  const logged = perContext(loggedSkips, context, () => new Set());
  const key = `${wakeId}\u0000${reason}`;
  if (logged.has(key)) return;
  logged.add(key);
  context.logger?.debug?.({
    event: 'host.wake_skipped',
    params: { wake_id: wakeId, endpoint_id: endpointId, host_name: hostName },
    result: { reason },
    status: 'ok',
  });
}

/**
 * Pushes one host.wake_requested for `endpointId` when its session is
 * unreachable (all five conditions of the protocol hold). Returns true when a
 * frame was published. Never throws into a post-commit caller for a push
 * failure: the event bus logs and swallows it.
 *
 * "Owner not observed gone" is the cheap `owner_process_exited_at IS NULL`
 * plus `state = 'idle'`; no `ps` runs here because this is reached from the
 * 1 s resumer tick and every delivery fan-out. The resumer trigger has just
 * proven the owner alive through its launch fence.
 */
export function maybeRequestHostWake(context, request) {
  // Always post-commit: a failure here must never reach the committed write.
  try {
    return requestWake(context, request);
  } catch (err) {
    context.logger?.warn?.({ event: 'host.wake_failed', params: { wake_id: request.wakeId, endpoint_id: request.endpointId }, error: { message: err.message, stack: err.stack }, status: 'error' });
    return false;
  }
}

// The resumer evaluates only an endpoint's oldest pending request, so once that
// request's wake is sent, a later waking message's request would never be
// pushed. Re-point to the oldest live request whose message is still waking
// and unwoken (each message prompts once; plan Review Feedback 3). A wakeId
// that is not one of the endpoint's resume requests (a delivery id) is kept.
function unsentResumeWakeId(context, sent, endpointId, wakeId) {
  if (!sent.has(wakeId)) return wakeId;
  const requests = context.db
    .prepare(
      `SELECT r.id FROM resume_requests r
         JOIN deliveries d ON d.endpoint_id = r.endpoint_id AND d.message_id = r.message_id AND ${hostWakingDeliverySql('d')}
        WHERE r.endpoint_id = ?1 AND r.state IN ('pending', 'claimed')
          AND EXISTS (SELECT 1 FROM resume_requests self WHERE self.id = ?2 AND self.endpoint_id = r.endpoint_id)
        ORDER BY r.created_at ASC, r.id ASC`,
    )
    .all(endpointId, wakeId);
  return requests.find((request) => !sent.has(request.id))?.id ?? wakeId;
}

function requestWake(context, { endpointId, wakeId: requestedWakeId, now = new Date(), interactiveOnly = false }) {
  const sent = perContext(sentWakes, context, () => new Map());
  const wakeId = unsentResumeWakeId(context, sent, endpointId, requestedWakeId);
  if (sent.has(wakeId)) {
    logSkip(context, { wakeId, endpointId, hostName: sent.get(wakeId), reason: 'already_sent' });
    return false;
  }
  const endpoint = context.db
    .prepare(
      `SELECT e.id AS endpoint_id, e.provider_session_id, e.runtime, e.authority_reference, e.host_name, e.host_ref
         FROM endpoints e
        WHERE e.id = ?1 AND e.state = 'idle' AND e.host_name IS NOT NULL AND e.owner_process_exited_at IS NULL
          AND (?2 = 0 OR e.launch_mode IS NOT 'non_interactive')
          AND EXISTS (SELECT 1 FROM deliveries waking WHERE waking.endpoint_id = e.id AND ${hostWakingDeliverySql('waking')})
          -- Routing's exact-listener test, plus 'waking': post-commit, the delivery that
          -- just staged a presentation has already moved its listener to 'waking'.
          AND NOT EXISTS (
            SELECT 1 FROM listeners l
             WHERE l.endpoint_id = e.id AND l.process_generation IS e.process_generation AND l.provider_session_id IS e.provider_session_id
               AND l.state IN ('parked', 'attached', 'waking') AND l.lease_expires_at > ?3 AND l.park_deadline_at > ?3)`,
    )
    .get(endpointId, interactiveOnly ? 1 : 0, now.toISOString());
  if (!endpoint) return false;

  const skip = (reason) => logSkip(context, { wakeId, endpointId, hostName: endpoint.host_name, reason }) ?? false;
  const host = context.db
    .prepare(
      `SELECT a.id FROM applications a
         JOIN application_permissions p ON p.app_id = a.id AND p.permission = ?
        WHERE a.name = ? AND a.status = 'active' AND a.disabled_at IS NULL`,
    )
    .get(HOST_SESSIONS_PERMISSION, endpoint.host_name);
  if (!host) return skip('host_not_registered');
  if (!context.eventBus?.hasHost(host.id)) return skip('host_not_connected');

  const delivered = context.eventBus.publishHost(
    host.id,
    'host.wake_requested',
    {
      wake_id: wakeId,
      endpoint_id: endpointId,
      provider_session_id: endpoint.provider_session_id,
      runtime: endpoint.runtime,
      authority_reference: endpoint.authority_reference,
      host_ref: endpoint.host_ref ?? null,
      prompt: HOST_WAKE_PROMPT,
    },
    context.logger,
  );
  sent.set(wakeId, endpoint.host_name);
  context.logger?.info?.({
    event: 'host.wake_requested',
    params: { wake_id: wakeId, endpoint_id: endpointId, host_name: endpoint.host_name },
    result: { sent: delivered > 0 },
    status: 'ok',
  });
  return delivered > 0;
}

/**
 * Trigger (b), called from the post-commit delivery fan-out. A non-interactive
 * endpoint is woken through its resume request (trigger a), so only
 * interactive or unknown-interactivity endpoints are considered here.
 */
export function requestHostWakesForDeliveries(context, liveDeliveries) {
  for (const delivery of liveDeliveries) {
    if (!delivery.delivery_id) continue;
    maybeRequestHostWake(context, { endpointId: delivery.endpoint_id, wakeId: delivery.delivery_id, interactiveOnly: true });
  }
}

/**
 * Trigger (c), called right after host.subscribe: one wake for each
 * unreachable endpoint bound to the subscribing application, keyed by the
 * endpoint's oldest waking unread delivery that has not already been woken
 * in this daemon lifetime (an earlier prompted-but-unread delivery must not
 * shadow mail that arrived while the host was away).
 */
export function requestHostCatchUpWakes(context, appId) {
  let rows;
  try {
    rows = catchUpCandidates(context, appId);
  } catch (err) {
    context.logger?.warn?.({ event: 'host.wake_catch_up_failed', params: { app_id: appId }, error: { message: err.message, stack: err.stack }, status: 'error' });
    return;
  }
  const sent = perContext(sentWakes, context, () => new Map());
  const woken = new Set();
  for (const row of rows) {
    if (woken.has(row.endpoint_id) || sent.has(row.wake_id)) continue;
    woken.add(row.endpoint_id);
    maybeRequestHostWake(context, { endpointId: row.endpoint_id, wakeId: row.wake_id });
  }
}

function catchUpCandidates(context, appId) {
  return context.db
    .prepare(
      `SELECT e.id AS endpoint_id, d.id AS wake_id
         FROM endpoints e
         JOIN deliveries d ON d.endpoint_id = e.id AND ${hostWakingDeliverySql('d')}
        WHERE e.host_name = (SELECT name FROM applications WHERE id = ?)
          AND e.state = 'idle' AND e.owner_process_exited_at IS NULL
          -- A non-interactive endpoint with a live request is woken by the resumer trigger on its next tick.
          AND NOT (e.launch_mode = 'non_interactive'
                   AND EXISTS (SELECT 1 FROM resume_requests r WHERE r.endpoint_id = e.id AND r.state IN ('pending', 'claimed')))
        ORDER BY e.id, d.created_at ASC, d.id ASC`,
    )
    .all(appId);
}
