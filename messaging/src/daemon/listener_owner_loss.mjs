// Listener endings tied to the loss of the endpoint's owner process (ac-jfv.155).
// A background-wait listener is shielded only while its current-generation owner lives;
// a parked or attached listener of a dead or exited owner never takes a presentation.

import { endUnsupportedTachyonListeners } from "./tachyon_arming.mjs";
// listener_operations <-> message_shared <-> this module is a cycle: use these only inside functions.
import {
  DEFAULT_RESUME_STALE_AFTER_MS,
  ELIGIBLE_SUCCESSOR_DELIVERY_SQL,
  RESUME_REASON_BY_ROUTE,
  maybeCreateResumeRequest,
  routeDelivery,
} from "./ops/message_shared.mjs";

// The one definition of "no process runs this generation": the endpoint is dead, or a headless
// owner exited (its exit leaves the endpoint idle). The exit marker alone proves nothing for an
// interactive endpoint: a managed app-server runs hosted turns on it until it is flipped to dead.
export function isEndpointOwnerGone({
  state,
  owner_process_exited_at: exitedAt,
  launch_mode: launchMode,
}) {
  return (
    state === "dead" || (Boolean(exitedAt) && launchMode === "non_interactive")
  );
}

// The same predicate for SQL over an `endpoints` alias; `IS` keeps a NULL launch_mode false, not NULL.
export function ownerGoneSql(alias = "e") {
  return `(${alias}.state = 'dead' OR (${alias}.owner_process_exited_at IS NOT NULL AND ${alias}.launch_mode IS 'non_interactive'))`;
}

// ac-jfv.155 successor branch (resumer.mjs successorEligiblePredicate; one `?`: the headless launch
// mode): a DEAD non_interactive endpoint with owner-exit proof. A headless run killed with a reply
// presented or acked (an orphaned stop-hold ACK, or a hook-ended listener) keeps unread work, no
// listener and no request, and no ingress route runs for it again.
export const DEAD_HEADLESS_EXIT_SQL = `e.state = 'dead' AND e.launch_mode = ?
  AND e.provider_session_id IS NOT NULL AND length(e.provider_session_id) > 0
  AND e.owner_process_exited_at IS NOT NULL AND e.owner_process_pid IS NOT NULL
  AND e.owner_process_generation = e.process_generation`;

// Which successorEligiblePredicate branch made the endpoint eligible, for the boundary log.
export function successorBranchFor(endpoint, headlessMode) {
  if (endpoint.launch_mode === headlessMode)
    return endpoint.state === "dead"
      ? "dead_headless_exit"
      : "idle_headless_exit";
  return endpoint.owner_process_exited_at
    ? "dead_interactive_exit"
    : "terminated_retirement";
}

// A wait whose listener's owner is gone (or whose park deadline passed) can no longer be satisfied.
export function expireReplyWait(db, { waitId, now, reason = "park_deadline" }) {
  db.prepare(
    "UPDATE reply_waits SET state = 'expired', terminal_reason = ?, updated_at = ?, closed_at = ? WHERE id = ? AND state IN ('pending_delivery', 'eligible')",
  ).run(reason, now, now, waitId);
}

export function isBackgroundWaitOwned(listener) {
  return (
    Boolean(listener.background_wait_at) &&
    listener.endpoint_process_generation === listener.process_generation &&
    listener.owner_process_exited_at === null
  );
}

// The endpoint's current-generation owner is gone: a listener of it in any active state can never
// take, or be read by, a presentation, armed or not. These are handled before the arming sweeps.
export function isOwnerGone(listener) {
  return (
    ["parked", "attached", "waking"].includes(listener.state) &&
    listener.endpoint_process_generation === listener.process_generation &&
    isEndpointOwnerGone({
      state: listener.endpoint_state,
      owner_process_exited_at: listener.owner_process_exited_at,
      launch_mode: listener.endpoint_launch_mode,
    })
  );
}

const ACTIVE_PENDING_PRESENTATIONS = `
  SELECT p.id, p.listener_id, p.message_id, p.target_delivery_id
    FROM listener_presentations p JOIN listeners l ON l.id = p.listener_id AND l.listener_generation = p.listener_generation
   WHERE l.endpoint_id = ? AND l.process_generation = ? AND l.state IN ('parked', 'attached', 'waking')
     AND p.state IN ('pending', 'acked') AND p.admitted_at IS NULL
   ORDER BY p.created_at ASC, p.id ASC`;

// One owner-gone step for an endpoint generation: miss what its listeners were presenting, end them
// (`owner_exited`), then route each missed delivery like fresh ingress under the item-44 guards.
export function endOwnerGoneListeners(context, listener, now) {
  const { db } = context;
  const pending = db
    .prepare(ACTIVE_PENDING_PRESENTATIONS)
    .all(listener.endpoint_id, listener.process_generation);
  const missed = pending.filter(
    (presentation) =>
      db
        .prepare(
          "UPDATE listener_presentations SET state = 'missed', missed_at = ?, fallback_reason = 'owner_exited', updated_at = ? WHERE id = ? AND state IN ('pending', 'acked') AND admitted_at IS NULL",
        )
        .run(now, now, presentation.id).changes === 1,
  );
  const waitIds = db
    .prepare(
      "SELECT DISTINCT reply_wait_id FROM listeners WHERE endpoint_id = ? AND process_generation = ? AND state IN ('parked', 'attached', 'waking') AND reply_wait_id IS NOT NULL",
    )
    .all(listener.endpoint_id, listener.process_generation);
  const ended = endUnsupportedTachyonListeners(db, {
    endpointId: listener.endpoint_id,
    processGeneration: listener.process_generation,
    now,
    reason: "owner_exited",
  });
  for (const { reply_wait_id: waitId } of waitIds)
    expireReplyWait(db, { waitId, now, reason: "owner_exited" });
  if (ended > 0) {
    context.logger?.info?.({
      event: "listener.owner_exited",
      params: {
        listener_id: listener.id,
        endpoint_id: listener.endpoint_id,
        process_generation: listener.process_generation,
      },
      result: {
        ended,
        missed_presentations: missed.length,
        endpoint_state: listener.endpoint_state,
        owner_exited: listener.owner_process_exited_at !== null,
      },
      status: "ended",
    });
  }
  for (const presentation of missed)
    resumeMissedForGoneOwner({ context, listener, presentation, now });
  return ended;
}

export function logBackgroundWaitOwnerLoss(context, listener) {
  context.logger?.info?.({
    event: "listener.background_wait_owner_lost",
    params: {
      listener_id: listener.id,
      endpoint_id: listener.endpoint_id,
      process_generation: listener.process_generation,
    },
    result: {
      endpoint_process_generation: listener.endpoint_process_generation,
      owner_exited: listener.owner_process_exited_at !== null,
    },
    status: "ended",
  });
}

// The wake a missed presentation of a gone owner calls for, or why none: routed like fresh ingress
// (dead -> endpoint_dead, headless idle -> endpoint_idle), then the item-44 guards
// materializeSuccessorRequests uses (unread, not failed, inside the stale window, no prior request
// for the message in any state, not read on another endpoint).
function goneOwnerWake({ context, listener, presentation, now }) {
  const { db } = context;
  const endpoint = db
    .prepare(
      `SELECT id, principal_id, provider_session_id AS session_id, authority_reference, state, launch_mode,
              owner_process_exited_at, process_generation
         FROM endpoints WHERE id = ?`,
    )
    .get(listener.endpoint_id);
  const gone =
    endpoint?.process_generation === listener.process_generation &&
    isEndpointOwnerGone(endpoint);
  const reason = gone
    ? RESUME_REASON_BY_ROUTE[
        routeDelivery({
          endpointState: endpoint.state,
          launchMode: endpoint.launch_mode,
        })
      ]
    : null;
  const conversationId = db
    .prepare("SELECT conversation_id FROM messages WHERE id = ?")
    .get(presentation.message_id)?.conversation_id;
  if (!reason || !conversationId) return null;
  const staleAfterMs =
    context.resumeStaleAfterMs ?? DEFAULT_RESUME_STALE_AFTER_MS;
  const eligible = db
    .prepare(
      `SELECT 1 FROM deliveries d WHERE d.id = ? AND d.endpoint_id = ? AND ${ELIGIBLE_SUCCESSOR_DELIVERY_SQL}`,
    )
    .get(
      presentation.target_delivery_id,
      endpoint.id,
      new Date(Date.parse(now) - staleAfterMs).toISOString(),
    );
  return { endpoint, reason, conversationId, eligible: Boolean(eligible) };
}

// A presentation missed while its owner is gone (the owner died before the ACK) has no live run to
// read it later, and nothing else wakes the endpoint. A miss while the run is alive is not this
// (ac-jfv.115) and never reaches here.
function resumeMissedForGoneOwner(args) {
  const { context, listener, presentation } = args;
  const wake = goneOwnerWake(args);
  if (!wake) return null;
  const params = {
    listener_id: listener.id,
    endpoint_id: wake.endpoint.id,
    message_id: presentation.message_id,
    delivery_id: presentation.target_delivery_id,
  };
  const requestId = wake.eligible
    ? maybeCreateResumeRequest(context.db, {
        endpoint: wake.endpoint,
        conversationId: wake.conversationId,
        messageId: presentation.message_id,
        reason: wake.reason,
        logger: context.logger,
      })
    : null;
  context.logger?.info?.({
    event: wake.eligible
      ? "listener.missed_presentation_resumed"
      : "listener.missed_presentation_not_resumed",
    params,
    result: wake.eligible
      ? { reason: wake.reason, resume_request_id: requestId }
      : { reason: wake.reason, skipped: "delivery_not_eligible" },
    status: wake.eligible ? "ok" : "skipped",
  });
  return requestId;
}
