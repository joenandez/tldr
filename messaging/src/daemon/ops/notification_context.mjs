// The bodyless context a notification carries (UX §9 S7/S8): who the message
// is from, its subject, its thread, and whether a reply is expected. Every
// surface that tells a session "a message arrived" reads it here, so the
// tool-boundary peek, the parked-Stop presentation, and the resume brief
// agree. It reads the conversation metadata, the immutable effect
// declaration, and the declared sender session; it never reads a body.
//
// Fields (names are agent-facing; the copy says session/thread, never
// endpoint/principal):
//   from            `<runtime> <id8>` for a session, `user (<channel label>)`
//                   for an inbound channel message, `unknown sender` otherwise
//   from_cwd        the sending session's working directory (sessions only)
//   subject         the conversation subject, or `(no subject)`
//   thread_id       the conversation id (clients shorten it to 8 characters)
//   reply_required  tracked work (open, handoff.offer) and user messages
//   delegation_id   only for a delegation offer still awaiting acceptance by
//                   the receiving session: the id `agent accept|decline
//                   --work` needs (clients build the exact commands from it)
//   work_id         only when the receiving session holds the tracked work the
//                   message belongs to: the root id `agent update|complete|
//                   delegate --work` needs (clients build the exact commands);
//                   `ack_pending: true` beside it when a user message's
//                   acknowledgement is still owed
//   notice          only for a typed chain-notice delivery (given its id):
//                   the UX §9 S11 line, derived from the canonical effect,
//                   the delivery's route reason, and (for a replacement) the
//                   sender's lineage; a notice needs no reply
//   notice_detail   beside `notice`, only when the delivery returns offered
//                   work to its offerer (the acceptance expired, or the
//                   delegate lost custody): {kind: 'offer_expired' |
//                   'delegation_lost', delegation_id, recipient}. The offerer
//                   still holds the work, so `work_id` rides along; the
//                   delegation id is deliberately NOT `delegation_id`, which
//                   means "an offer you can accept". A copy of a requester's
//                   cancel (a holder's typed `cancel.requester` copy or a
//                   finished delegate's or bystander's ordinary one) carries
//                   {kind: 'requester_cancelled', reason} beside `notice`, no
//                   `work_id`, and asks nothing

import { CANCEL_NOTICE_ROUTE_REASON, DELEGATION_NOTICE_ROUTE_REASON, REPLACEMENT_NOTICE_ROUTE_REASON, requesterCancelMessageSql } from '../lifecycle_transition.mjs';
import { CUSTODY_LOST_ROUTE_REASON } from '../custody_reconciler.mjs';
import { OFFER_EXPIRED_ROUTE_REASON } from '../watch_reconciler.mjs';
import { sessionHandles } from './lifecycle_view.mjs';
import { offerRecipientEndpointIds } from './message_shared.mjs';
import { heldWork, participationLinks, predecessorEndpointIds } from './thread_list.mjs';

const REPLY_REQUIRED_EFFECTS = new Set(['open', 'handoff.offer']);
const THREAD_ID_CHARS = 8;

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sessionOf(db, endpointId) {
  if (typeof endpointId !== 'string') return null;
  const endpoint = db.prepare('SELECT id, runtime, provider_session_id, authority_reference FROM endpoints WHERE id = ?').get(endpointId);
  if (!endpoint) return null;
  const id8 = sessionHandles(db)(endpoint);
  return { id8, label: `${endpoint.runtime} ${id8}`, cwd: endpoint.authority_reference };
}

function senderSession(db, declaration) {
  const session = sessionOf(db, declaration?.sender_endpoint_id);
  if (!session) return null;
  return {
    from: session.label,
    from_cwd: typeof session.cwd === 'string' && session.cwd.length > 0 ? session.cwd : null,
  };
}

// The offer's proposed holder: its exact (untyped) delivery on the
// delegation's principal. The delegator is the delegation parent's holder.
function delegationParties(db, { messageId, delegationId }) {
  const delegation = db.prepare('SELECT parent_id, accountable_principal_id FROM obligations WHERE id = ?').get(delegationId);
  const delegator = sessionOf(db, db.prepare('SELECT custodian_endpoint_id FROM obligations WHERE id = ?').get(delegation?.parent_id ?? null)?.custodian_endpoint_id);
  const offeredEndpointId = db
    .prepare(
      `SELECT d.endpoint_id FROM deliveries d JOIN endpoints e ON e.id = d.endpoint_id
        WHERE d.message_id = ? AND d.route_reason IS NULL AND e.principal_id = ?
        ORDER BY d.created_at, d.id LIMIT 1`,
    )
    .get(messageId, delegation?.accountable_principal_id ?? null)?.endpoint_id;
  return { delegator: delegator?.id8 ?? 'a session', proposed: sessionOf(db, offeredEndpointId)?.label ?? 'a session' };
}

function delegationHead({ effect, declaration, parties, db }) {
  const actor = sessionOf(db, declaration?.sender_endpoint_id)?.label ?? 'a session';
  if (effect === 'handoff.offer') return [`Offered to ${parties.proposed}`, `delegated by ${parties.delegator}`, `result returns to ${parties.delegator}`];
  if (effect === 'handoff.decline') return [`Declined by ${actor}`, `still handled by ${parties.delegator}`];
  return [`Now handled by ${actor}`, `delegated by ${parties.delegator}`, `result returns to ${parties.delegator}`];
}

// The replacement notice's sender is the replacement; the predecessor named is
// the one of its lineage that took part in this thread, as the disclosure
// that wrote the notice chose it (replacement_disclosure.mjs).
function replacementHead(db, { appId, threadId, declaration }) {
  const replacementId = declaration?.sender_endpoint_id;
  const predecessorIds = typeof replacementId === 'string' ? predecessorEndpointIds(db, appId, replacementId) : [];
  const link = predecessorIds.length === 0 ? null : participationLinks(db, appId, predecessorIds).find((entry) => entry.conversation_id === threadId);
  // A thread adopted only through a moved delivery keeps no predecessor link.
  const predecessorId = link?.endpoint_id ?? (predecessorIds.length === 0 ? null : db.prepare('SELECT endpoint_id FROM resume_requests WHERE replacement_endpoint_id = ? LIMIT 1').get(replacementId)?.endpoint_id);
  return [
    `${sessionOf(db, predecessorId)?.label ?? 'a session'} could not be resumed`,
    `replacement ${sessionOf(db, replacementId)?.id8 ?? 'a session'} adopted this thread`,
  ];
}

function noticeLine(db, { delivery, messageId, appId, effect, declaration, subject, threadId }) {
  const tail = [subject, threadId.replace(/^[^_]+_/, '').slice(0, THREAD_ID_CHARS)];
  if (delivery.route_reason === REPLACEMENT_NOTICE_ROUTE_REASON) return [...replacementHead(db, { appId, threadId, declaration }), ...tail].join(' · ');
  const parties = delegationParties(db, { messageId, delegationId: delivery.source_obligation_id });
  return [...delegationHead({ effect, declaration, parties, db }), ...tail].join(' · ');
}

function noticeDelivery(db, messageId, deliveryId) {
  if (typeof deliveryId !== 'string') return null;
  const delivery = db.prepare('SELECT route_reason, source_obligation_id FROM deliveries WHERE id = ? AND message_id = ?').get(deliveryId, messageId);
  // Read at call time: these constants come through an import cycle with
  // lifecycle_transition.mjs, so a module-level collection would see them uninitialised.
  const noticeReasons = [DELEGATION_NOTICE_ROUTE_REASON, REPLACEMENT_NOTICE_ROUTE_REASON];
  return noticeReasons.includes(delivery?.route_reason) ? delivery : null;
}

// The typed wakes that hand offered work back to its offerer re-deliver the
// ORIGINAL offer message (watch_reconciler.mjs, custody_reconciler.mjs). Read
// as a message they look like the offerer's own offer, so each is presented
// as the notice it is (proof F39). Read at call time for the same cycle reason.
function returnedWorkKind(routeReason) {
  if (routeReason === OFFER_EXPIRED_ROUTE_REASON) return 'offer_expired';
  if (routeReason === CUSTODY_LOST_ROUTE_REASON) return 'delegation_lost';
  return null;
}

/** The route reasons that return offered work to its offerer, for callers that select deliveries by them. */
export function returnedWorkRouteReasons() {
  return [OFFER_EXPIRED_ROUTE_REASON, CUSTODY_LOST_ROUTE_REASON];
}

function returnedWorkDelivery(db, messageId, deliveryId) {
  if (typeof deliveryId !== 'string') return null;
  const delivery = db.prepare('SELECT route_reason, source_obligation_id FROM deliveries WHERE id = ? AND message_id = ?').get(deliveryId, messageId);
  return returnedWorkKind(delivery?.route_reason) ? delivery : null;
}

/**
 * The S11 notice for a delivery that returns offered work to its offerer, or
 * null for any other delivery. `detail` is the additive JSON; `text` the line:
 * `Offer expired · <recipient> did not accept before the deadline · the work is
 * back with you · delegation <id> · <subject> · <thread8>` (or `Delegation lost
 * · <recipient> stopped before finishing · …`). It reads the conversation
 * subject and the delegation's parties, never a body.
 * @returns {{text: string, detail: {kind: string, delegation_id: string, recipient: string}}|null}
 */
export function returnedWorkNotice(db, { messageId, deliveryId }) {
  const delivery = returnedWorkDelivery(db, messageId, deliveryId);
  if (!delivery) return null;
  const kind = returnedWorkKind(delivery.route_reason);
  const delegationId = delivery.source_obligation_id;
  const conversation = db.prepare('SELECT c.id, c.metadata FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ?').get(messageId);
  if (!conversation) return null;
  const subject = parseJson(conversation.metadata)?.subject;
  const parties = delegationParties(db, { messageId, delegationId });
  const holder = kind === 'delegation_lost'
    ? sessionOf(db, db.prepare('SELECT custodian_endpoint_id FROM obligations WHERE id = ?').get(delegationId)?.custodian_endpoint_id)?.label
    : null;
  const recipient = holder ?? parties.proposed;
  const head = kind === 'offer_expired'
    ? ['Offer expired', `${recipient} did not accept before the deadline`]
    : ['Delegation lost', `${recipient} stopped before finishing`];
  const text = [
    ...head,
    'the work is back with you',
    `delegation ${delegationId}`,
    typeof subject === 'string' && subject.trim().length > 0 ? subject : '(no subject)',
    conversation.id.replace(/^[^_]+_/, '').slice(0, THREAD_ID_CHARS),
  ].join(' · ');
  return { text, detail: { kind, delegation_id: delegationId, recipient } };
}

// A cancel of a root reaches every participant: holders get a typed
// `cancel.requester` copy, a finished delegate or bystander an ordinary one.
// Neither asks anything of its recipient, so both are presented as a notice
// rather than as a message with a Reply command (re-check 7). Who cancelled is
// read from the message itself (requesterCancelMessageSql), never from the
// route: a holder that cancels the root it holds also sends typed copies to
// its delegates, and those must not say "requester" (re-check 8).
function cancelKind(db, messageId, deliveryId) {
  if (db.prepare(`SELECT 1 AS yes FROM (SELECT ? AS message_id) cancel_copy WHERE ${requesterCancelMessageSql('cancel_copy')}`).get(messageId)) return 'requester_cancelled';
  const route = typeof deliveryId === 'string' ? db.prepare('SELECT route_reason FROM deliveries WHERE id = ? AND message_id = ?').get(deliveryId, messageId) : null;
  // Read at call time: the constant comes through an import cycle with lifecycle_transition.mjs.
  return route?.route_reason === CANCEL_NOTICE_ROUTE_REASON ? 'holder_cancelled' : null;
}

const CANCEL_LABEL = { requester_cancelled: 'Cancelled by requester', holder_cancelled: 'Cancelled by the agent that delegated it' };

/**
 * The S11 notice for a copy of a cancel that asks nothing of its recipient, or
 * null for any other message: `Cancelled by requester: <reason> · <subject> ·
 * <thread8>` (or, for a holder's own cancel cascading to its delegates,
 * `Cancelled by the agent that delegated it: …`), with `detail`
 * `{kind, reason}`. Never carries the body.
 * @returns {{text: string, detail: {kind: string, reason: string}}|null}
 */
export function requesterCancelNotice(db, { messageId, deliveryId = null }) {
  const kind = cancelKind(db, messageId, deliveryId);
  if (kind === null) return null;
  const row = db
    .prepare(
      `SELECT m.conversation_id, c.metadata AS conversation_metadata, fx.effect_payload
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         LEFT JOIN message_effects fx ON fx.message_id = m.id
        WHERE m.id = ?`,
    )
    .get(messageId);
  if (!row) return null;
  const subject = parseJson(row.conversation_metadata)?.subject;
  const declared = parseJson(row.effect_payload)?.declaration?.reason;
  const reason = typeof declared === 'string' && declared.length > 0 ? declared : 'no reason given';
  const text = [
    `${CANCEL_LABEL[kind]}: ${reason}`,
    typeof subject === 'string' && subject.trim().length > 0 ? subject : '(no subject)',
    row.conversation_id.replace(/^[^_]+_/, '').slice(0, THREAD_ID_CHARS),
  ].join(' · ');
  return { text, detail: { kind, reason } };
}

/**
 * The delegation a handoff.offer message offers to `endpointId`, or null: only
 * an offer still awaiting acceptance, addressed to that session's principal
 * (and, for an exact offer, to that session or its lineage successor), has an
 * id the session can act on. The id comes from the offer's own effect
 * audit (`created.delegation_id`); no body or other session's data is read.
 * @returns {string|null}
 */
export function pendingOfferDelegationId(db, messageId, endpointId, { logger } = {}) {
  const effect = db.prepare("SELECT effect_payload FROM message_effects WHERE message_id = ? AND effect = 'handoff.offer'").get(messageId);
  const delegationId = parseJson(effect?.effect_payload)?.created?.delegation_id;
  if (typeof delegationId !== 'string' || typeof endpointId !== 'string') return null;
  const pending = db
    .prepare(
      `SELECT 1
         FROM obligations o
         JOIN handoff_watches w ON w.delegation_id = o.id AND w.state = 'awaiting_acceptance'
         JOIN endpoints e ON e.principal_id = o.accountable_principal_id AND e.id = ?
        WHERE o.id = ? AND o.role = 'delegation' AND o.status = 'open' AND o.custodian_endpoint_id IS NULL`,
    )
    .get(endpointId, delegationId);
  if (!pending) return null;
  const answerers = offerRecipientEndpointIds(db, delegationId);
  if (answerers !== null && !answerers.includes(endpointId)) {
    logger?.debug?.({
      event: 'offer_line_withheld',
      params: { message_id: messageId, delegation_id: delegationId, endpoint_id: endpointId },
      result: { reason: 'offered_to_different_session' },
      status: 'withheld',
    });
    return null;
  }
  return delegationId;
}

/**
 * The notification context for one message, or null when it does not exist.
 * Given the presented delivery's id, a typed chain notice adds its S11 line.
 */
export function notificationContext(db, messageId, { deliveryId = null } = {}) {
  const row = db
    .prepare(
      `SELECT m.conversation_id, m.app_id, m.origin, m.origin_channel_route_id, c.metadata AS conversation_metadata,
              fx.effect, fx.effect_payload, r.label AS channel_label
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         LEFT JOIN message_effects fx ON fx.message_id = m.id
         LEFT JOIN channel_routes r ON r.id = m.origin_channel_route_id
        WHERE m.id = ?`,
    )
    .get(messageId);
  if (!row) return null;
  const subject = parseJson(row.conversation_metadata)?.subject;
  const fromUser = row.origin === 'inbound' && row.origin_channel_route_id !== null;
  const declaration = parseJson(row.effect_payload)?.declaration;
  const session = fromUser ? null : senderSession(db, declaration);
  const context = {
    from: fromUser ? `user (${row.channel_label ?? 'channel'})` : session?.from ?? 'unknown sender',
    ...(session?.from_cwd ? { from_cwd: session.from_cwd } : {}),
    subject: typeof subject === 'string' && subject.trim().length > 0 ? subject : '(no subject)',
    thread_id: row.conversation_id,
    reply_required: fromUser || REPLY_REQUIRED_EFFECTS.has(row.effect),
  };
  const delivery = noticeDelivery(db, messageId, deliveryId);
  const returned = delivery ? null : returnedWorkNotice(db, { messageId, deliveryId });
  if (returned) {
    // The offerer still holds the work: its id and commands ride beside the notice.
    const offererEndpointId = db.prepare('SELECT endpoint_id FROM deliveries WHERE id = ?').get(deliveryId)?.endpoint_id;
    const work = heldWork(db, row.conversation_id, offererEndpointId, { messageId });
    return { ...context, reply_required: false, notice: returned.text, notice_detail: returned.detail, ...(work ?? {}) };
  }
  const cancelled = requesterCancelNotice(db, { messageId, deliveryId });
  if (cancelled) return { ...context, reply_required: false, notice: cancelled.text, notice_detail: cancelled.detail };
  if (!delivery) {
    const recipientEndpointId = typeof deliveryId === 'string' ? db.prepare('SELECT endpoint_id FROM deliveries WHERE id = ?').get(deliveryId)?.endpoint_id : null;
    const delegationId = row.effect === 'handoff.offer' ? pendingOfferDelegationId(db, messageId, recipientEndpointId) : null;
    if (delegationId) return { ...context, delegation_id: delegationId };
    // The work this message is part of, when the recipient holds it (F23).
    // A conversation can hold several open roots: the message picks its own.
    const work = heldWork(db, row.conversation_id, recipientEndpointId, { messageId });
    return work ? { ...context, ...work } : context;
  }
  return {
    ...context,
    reply_required: false,
    notice: noticeLine(db, { delivery, messageId, appId: row.app_id, effect: row.effect, declaration, subject: context.subject, threadId: row.conversation_id }),
  };
}
