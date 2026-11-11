// Scheduled-wake pass (thread-followups plan C3), run by the resumer tick.
//
// A due wake is a typed internal message plus an exact delivery to the
// holding endpoint, so the ordinary resume_requests path resumes that exact
// session. One hour later, if the attempt reported nothing (an update or
// complete cancels the row), or if the wake's launch failed for good, the
// session is woken once more and the requester is told, once per silence (an
// update or complete starts a new one). The pass never goes through
// applyUpdate: that would cancel its own row.

import { withTransaction } from "./db.mjs";
import {
  createDeliveriesForChannelRoutes,
  createDeliveriesForRecipients,
  insertMessage,
  newestLineageEndpointId,
  payloadHash,
  pushLiveDeliveryEvents,
  withIdempotency,
} from "./ops/message_shared.mjs";
import { insertEffectRow } from "./lifecycle_transition.mjs";
import { publishPresentation } from "./ops/listener_operations.mjs";
import { resolveOriginRouteId } from "./origin_route_resolution.mjs";
import {
  cancelWakesForAttempt,
  dueRewakes,
  dueWakes,
  launchFailed,
  markFired,
  markNotified,
  toldThisSilence,
  wakeMessageKey,
} from "./scheduled_wakes.mjs";

export const SCHEDULED_WAKE_ROUTE_REASON = "scheduled.wake";
export const REWAKE_AFTER_MS = 60 * 60 * 1000;

const RULE =
  "answer, or say what you're doing and when you'll report back; `reply` keeps the request open; only `complete` closes it; `delegate --at` parks it.";
const USER_NOTICE =
  "The agent holding your request was woken to continue it an hour ago and has not reported back. Your request remains open.";
const USER_LAUNCH_NOTICE =
  "tldr could not wake the agent holding your request at its scheduled time. Your request remains open.";
const AGENT_LAUNCH_NOTICE =
  "The scheduled wake for the request you opened could not launch its holder. The request remains open.";
const AGENT_NOTICE =
  "No update on the request you opened since the scheduled wake an hour ago. The holder was woken again; the request remains open.";

const rootOf = (db, attempt) => {
  let node = attempt;
  while (node && node.role !== "root" && node.parent_id) {
    node = db
      .prepare("SELECT * FROM obligations WHERE id = ?")
      .get(node.parent_id);
  }
  return node?.role === "root" ? node : null;
};

// Custody-loss recovery closes the held attempt failed after the wake fired;
// the rewake phase still owes the holder one launch and the requester a notice.
const failedSinceFire = (attempt, firedAt) =>
  attempt.status === "closed" &&
  attempt.resolution === "failed" &&
  attempt.updated_at >= firedAt;

function stillHeld(attempt, root, wake) {
  if (attempt?.custodian_endpoint_id !== wake.endpoint_id) return false;
  if (attempt.status === "open") return true;
  // Unfired wakes (null fired_at) stay in the strict fire phase.
  return (
    !!wake.fired_at &&
    root?.status === "open" &&
    failedSinceFire(attempt, wake.fired_at)
  );
}

// The held attempt, its root, and the message that opened the root; null when
// the wake no longer applies (attempt closed or handed to another endpoint).
function loadWork(db, wake) {
  const attempt = db
    .prepare("SELECT * FROM obligations WHERE id = ?")
    .get(wake.attempt_id);
  const root = attempt ? rootOf(db, attempt) : null;
  const held = stillHeld(attempt, root, wake);
  const opening =
    held && root
      ? db
          .prepare(
            `SELECT m.id, m.app_id, m.sender_principal_id, me.effect_payload
               FROM message_effects me JOIN messages m ON m.id = me.message_id
              WHERE me.obligation_id = ? AND me.effect = 'open' ORDER BY m.rowid LIMIT 1`,
          )
          .get(root.id)
      : null;
  if (!opening) return null;
  let requesterEndpointId = null;
  try {
    requesterEndpointId =
      JSON.parse(opening.effect_payload)?.declaration?.sender_endpoint_id ??
      null;
  } catch {
    // An unreadable audit leaves the requester unknown; the wake still goes out.
  }
  return { root, opening, requesterEndpointId };
}

function wakeBody(rootId, rewake) {
  const head = rewake
    ? `No update arrived after your scheduled wake. You are being woken again for your held request ${rootId}.`
    : `You were woken for your held request ${rootId}.`;
  return `${head} Please ${RULE}`;
}

function deliverWake(context, wake, work) {
  const { db } = context;
  const { root, opening, rewake } = work;
  const key = rewake
    ? `scheduled-rewake:${wake.wake_id}`
    : wakeMessageKey(wake.wake_id);
  const body = wakeBody(root.id, rewake);
  const messageId = insertMessage(db, {
    conversationId: root.conversation_id,
    appId: opening.app_id,
    senderPrincipalId: opening.sender_principal_id,
    kind: "commit",
    body,
    metadata: { notice: "scheduled_wake" },
    idempotencyKey: key,
    hash: payloadHash({ key, body }),
    origin: "agent",
    inReplyToMessageId: opening.id,
  });
  return createDeliveriesForRecipients(db, {
    conversationId: root.conversation_id,
    messageId,
    senderPrincipalId: opening.sender_principal_id,
    senderEndpointId: work.requesterEndpointId,
    recipientEndpointId: wake.endpoint_id,
    routeReason: SCHEDULED_WAKE_ROUTE_REASON,
    sourceObligationId: root.id,
    routeReasonEndpointIds: new Set([wake.endpoint_id]),
    stateRoot: context.stateRoot,
    logger: context.logger,
  });
}

function userRoute(db, work) {
  const routeId = resolveOriginRouteId(db, {
    conversationId: work.root.conversation_id,
    inReplyToMessageId: work.opening.id,
  });
  if (!routeId) return null;
  const route = db
    .prepare(
      `SELECT r.id, r.app_id, r.principal_id, r.endpoint_id, r.capabilities
         FROM channel_routes r JOIN applications a ON a.id = r.app_id
         JOIN endpoints e ON e.id = r.endpoint_id
        WHERE r.id = ? AND r.state = 'active' AND a.status = 'active' AND e.state IN ('idle', 'busy')`,
    )
    .get(routeId);
  return route?.capabilities.includes('"send"') ? route : { unavailable: true };
}

// The requester hears it through the channel the request came in on.
function noticeUser(db, wake, work) {
  const { root, opening, route } = work;
  const text = work.launchFailed ? USER_LAUNCH_NOTICE : USER_NOTICE;
  const key = `scheduled-wake-notice:${wake.wake_id}`;
  const hash = payloadHash({ body: text, key });
  return withIdempotency(
    db,
    { appId: opening.app_id, idempotencyKey: key, hash },
    () => {
      const messageId = insertMessage(db, {
        conversationId: root.conversation_id,
        appId: opening.app_id,
        senderPrincipalId: opening.sender_principal_id,
        kind: "commit",
        body: text,
        metadata: {},
        idempotencyKey: key,
        hash,
        origin: "agent",
        inReplyToMessageId: opening.id,
      });
      const { liveDeliveries } = createDeliveriesForChannelRoutes(db, {
        conversationId: root.conversation_id,
        messageId,
        routes: [route],
        replyTargetEndpointId: wake.endpoint_id,
        replyTargetMustBeSender: false,
      });
      return { liveDeliveries };
    },
  );
}

// An agent requester gets an ordinary message from the holder.
function noticeAgent(context, wake, work) {
  const { db } = context;
  const { root, opening } = work;
  const requester = newestLineageEndpointId(db, work.requesterEndpointId);
  const holder = db
    .prepare(
      "SELECT principal_id, process_generation FROM endpoints WHERE id = ?",
    )
    .get(wake.endpoint_id);
  const text = work.launchFailed ? AGENT_LAUNCH_NOTICE : AGENT_NOTICE;
  const key = `scheduled-wake-notice:${wake.wake_id}`;
  const declaration = {
    type: "none",
    sender_endpoint_id: wake.endpoint_id,
    process_generation: holder.process_generation,
  };
  const messageId = insertMessage(db, {
    conversationId: root.conversation_id,
    appId: opening.app_id,
    senderPrincipalId: holder.principal_id,
    kind: "commit",
    body: text,
    metadata: {},
    idempotencyKey: key,
    hash: payloadHash({ key, body: text }),
    origin: "agent",
    inReplyToMessageId: opening.id,
  });
  insertEffectRow(db, {
    messageId,
    effect: declaration,
    obligationId: null,
    obligationGeneration: null,
    now: new Date().toISOString(),
  });
  return createDeliveriesForRecipients(db, {
    conversationId: root.conversation_id,
    messageId,
    senderPrincipalId: holder.principal_id,
    senderEndpointId: wake.endpoint_id,
    recipientEndpointId: requester,
    stateRoot: context.stateRoot,
    logger: context.logger,
  });
}

function noticeRequester(context, wake, work) {
  const route = userRoute(context.db, work);
  const toAgent = !route && work.requesterEndpointId;
  if (toAgent) return { to: "agent", sent: noticeAgent(context, wake, work) };
  if (!route || route.unavailable)
    return { to: route ? "user_unavailable" : "none", sent: {} };
  const sent = noticeUser(context.db, wake, { ...work, route });
  return { to: "user", sent };
}

// After commit: inbox events, and every presentation staged for a parked
// listener (unpublished, it is missed at its ack deadline and the wake lost).
function publish(context, conversationId, sent) {
  pushLiveDeliveryEvents(context, {
    conversationId,
    liveDeliveries: sent.liveDeliveries ?? [],
  });
  for (const presentation of sent.presentations ?? [])
    publishPresentation(context, presentation);
}

function skipWake(context, wake, { nowIso, phase }) {
  cancelWakesForAttempt(context.db, wake.attempt_id, nowIso);
  context.logger?.info?.({
    event: "scheduled_wake_skipped",
    params: { wake_id: wake.wake_id, attempt_id: wake.attempt_id, phase },
    result: { reason: "attempt_closed_or_moved" },
    status: "skipped",
  });
}

function decide(step, apply) {
  const { context, wake } = step;
  const outcome = withTransaction(context.db, () => {
    const work = loadWork(context.db, wake);
    if (!work) return { skipped: true };
    return apply(work);
  });
  if (outcome.skipped) skipWake(context, wake, step);
  return outcome;
}

function fireOne(context, wake, now) {
  const nowIso = now.toISOString();
  const outcome = decide({ context, wake, nowIso, phase: "fire" }, (work) => {
    const sent = deliverWake(context, wake, work);
    markFired(context.db, wake.wake_id, {
      firedAt: nowIso,
      rewakeAt: new Date(now.getTime() + REWAKE_AFTER_MS).toISOString(),
    });
    return { sent, conversationId: work.root.conversation_id };
  });
  if (outcome.skipped) return false;
  publish(context, outcome.conversationId, outcome.sent);
  context.logger?.info?.({
    event: "scheduled_wake_fired",
    params: {
      wake_id: wake.wake_id,
      attempt_id: wake.attempt_id,
      reason: wake.reason,
    },
    result: {
      deliveries: outcome.sent.liveDeliveries.length,
      presentations: outcome.sent.presentations.length,
    },
    status: "ok",
  });
  return true;
}

function rewakeOne(context, wake, { now, wakeFiringNow }) {
  const nowIso = now.toISOString();
  const outcome = decide({ context, wake, nowIso, phase: "rewake" }, (work) => {
    const wakeSent = wakeFiringNow
      ? { liveDeliveries: [], presentations: [] }
      : deliverWake(context, wake, { ...work, rewake: true });
    const failed = launchFailed(context.db, wake);
    const notice = toldThisSilence(context.db, wake)
      ? { to: "told_this_silence", sent: {} }
      : noticeRequester(context, wake, { ...work, launchFailed: failed });
    markNotified(context.db, wake.wake_id, nowIso);
    return {
      wakeSent,
      notice,
      cause: failed ? "launch_failed" : "no_update",
      conversationId: work.root.conversation_id,
    };
  });
  if (outcome.skipped) return false;
  publish(context, outcome.conversationId, outcome.wakeSent);
  publish(context, outcome.conversationId, outcome.notice.sent);
  context.logger?.info?.({
    event: "scheduled_wake_notified",
    params: {
      wake_id: wake.wake_id,
      attempt_id: wake.attempt_id,
      reason: wake.reason,
    },
    result: { notice_to: outcome.notice.to, cause: outcome.cause },
    status:
      outcome.notice.to === "user_unavailable" || outcome.notice.to === "none"
        ? "undeliverable"
        : "ok",
  });
  return true;
}

// One bad row must not stop the others; it stays due and is retried next tick.
function guarded(context, wake, run) {
  try {
    return run() ? 1 : 0;
  } catch (error) {
    context.logger?.error?.({
      event: "scheduled_wake_failed",
      params: { wake_id: wake.wake_id, attempt_id: wake.attempt_id },
      result: { code: error.code, message: error.message, stack: error.stack },
      status: "error",
    });
    return 0;
  }
}

/** One pass: fire due wakes, then re-wake and notify the unanswered ones. */
export function runScheduledWakes(context, { now }) {
  const nowIso = now.toISOString();
  const overdue = dueRewakes(context.db, nowIso);
  const due = dueWakes(context.db, nowIso);
  // An attempt with a wake that fired in this pass gets that one wake message;
  // its old row's re-wake then only posts the requester notice.
  const firing = new Set();
  const summary = { fired: 0, notified: 0 };
  if (due.length === 0 && overdue.length === 0) return summary;
  const started = Date.now();
  for (const wake of due) {
    const fired = guarded(context, wake, () => fireOne(context, wake, now));
    summary.fired += fired;
    if (fired) firing.add(wake.attempt_id);
  }
  for (const wake of overdue)
    summary.notified += guarded(context, wake, () =>
      rewakeOne(context, wake, {
        now,
        wakeFiringNow: firing.has(wake.attempt_id),
      }),
    );
  context.logger?.info?.({
    event: "scheduled_wake_pass",
    params: { due: due.length, rewake_due: overdue.length },
    result: summary,
    status: "ok",
    latency: Date.now() - started,
  });
  return summary;
}
