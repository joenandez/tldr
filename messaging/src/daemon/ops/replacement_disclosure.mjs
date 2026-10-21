// Replacement disclosure (plan §2.2; ux.md §9 S11). Runs INSIDE the
// endpoint.register adoption transaction that binds a replacement session to
// its failed exact-resume predecessor, so adoption, lineage, notices, and
// deliveries commit or roll back together. The lineage guard alone authorizes
// this internal event; agent applyNone is never consulted.
//
// For every open-work conversation the predecessor participated in, it writes
// one canonical commit/none message (the same storage shape an agent `none`
// send leaves) and exact delivery rows, typed `replacement.notice` with the
// adopted root as source obligation, for each counterpart endpoint: the
// endpoint that opened the work and any endpoint currently holding it. The
// lineage itself (predecessor and replacement) is never a recipient, so the
// unresumable prior holder is never relaunched for a notice, and nothing is
// routed by principal fan-out. The notice names sessions and the thread; it
// never carries a message body.
//
// Each notice is keyed `replacement-notice:<replacement request>:<conversation>`
// under the messages UNIQUE(app_id, idempotency_key) index, so a disclosure
// can exist at most once per adoption and conversation.

import { insertEffectRow, REPLACEMENT_NOTICE_ROUTE_REASON } from '../lifecycle_transition.mjs';
import { chainNodes, conversationSubject } from './lifecycle_view.mjs';
import { createDeliveriesForRecipients, insertMessage, newestLineageEndpointId, payloadHash } from './message_shared.mjs';
import { chosenRoot, openLeaves, participationLinks, predecessorEndpointIds, shortSessionId } from './thread_list.mjs';

function shortThreadId(conversationId) {
  return conversationId.replace(/^[^_]+_/, '').slice(0, 8);
}

function rootRequesterEndpointId(db, rootId) {
  const opening = db.prepare("SELECT effect_payload FROM message_effects WHERE obligation_id = ? AND effect = 'open' LIMIT 1").get(rootId);
  try {
    return JSON.parse(opening?.effect_payload ?? '{}')?.declaration?.sender_endpoint_id ?? null;
  } catch {
    return null;
  }
}

// The requester and every current holder, each resolved to its newest
// lineage replacement (a counterpart replaced in turn is told where it now
// lives), excluding the replacement's own lineage and any endpoint this
// application does not own or that is closed.
function counterpartEndpointIds(db, { appId, root, lineageIds }) {
  const holders = openLeaves(chainNodes(db, root.id)).map((leaf) => leaf.custodian_endpoint_id);
  const candidates = [...new Set([rootRequesterEndpointId(db, root.id), ...holders].map((endpointId) => newestLineageEndpointId(db, endpointId)))];
  return candidates.filter((endpointId) => {
    if (endpointId === null || lineageIds.includes(endpointId)) return false;
    const endpoint = db.prepare('SELECT created_by_app_id, state FROM endpoints WHERE id = ?').get(endpointId);
    return endpoint?.created_by_app_id === appId && endpoint.state !== 'closed';
  });
}

// Both sessions are named by handles unique among known sessions: a Codex
// predecessor and its replacement share a UUIDv7 timestamp prefix.
function noticeBody(db, { predecessor, replacementEndpointId, replacementSessionId, subject, conversationId }) {
  const parts = [
    `${predecessor.runtime} ${shortSessionId(db, predecessor)} could not be resumed`,
    `replacement ${shortSessionId(db, { id: replacementEndpointId, provider_session_id: replacementSessionId })} adopted this thread`,
    ...(subject === null ? [] : [subject]),
    shortThreadId(conversationId),
  ];
  return parts.join(' · ');
}

/**
 * Writes the disclosure for one adoption. Returns per-notice live deliveries
 * and presentations so the caller can dispatch wakes after its transaction
 * commits, plus the counts for its boundary log.
 */
export function discloseReplacement(db, { appId, replacementRequestId, replacementEndpointId, replacementSessionId, stateRoot, logger }) {
  const replacement = db.prepare('SELECT principal_id, process_generation FROM endpoints WHERE id = ?').get(replacementEndpointId);
  const predecessorIds = predecessorEndpointIds(db, appId, replacementEndpointId);
  const lineageIds = [replacementEndpointId, ...predecessorIds];
  // The placeholder has had no session until this adoption, so every link it
  // already holds came from its predecessor: above all the unread deliveries
  // admission moved onto it, which leave the predecessor no link of its own.
  const linksByConversation = Map.groupBy(predecessorIds.length === 0 ? [] : participationLinks(db, appId, lineageIds), (link) => link.conversation_id);
  const directPredecessorId = db.prepare('SELECT endpoint_id FROM resume_requests WHERE replacement_endpoint_id = ? LIMIT 1').get(replacementEndpointId)?.endpoint_id ?? predecessorIds[0];
  const declaration = { type: 'none', sender_endpoint_id: replacementEndpointId, process_generation: replacement.process_generation };
  const wakes = [];
  let adoptedConversationCount = 0;
  let deliveryCount = 0;
  for (const [conversationId, links] of [...linksByConversation].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const root = chosenRoot(db, conversationId);
    if (root?.status !== 'open') continue;
    adoptedConversationCount += 1;
    const idempotencyKey = `replacement-notice:${replacementRequestId}:${conversationId}`;
    if (db.prepare('SELECT 1 FROM messages WHERE app_id = ? AND idempotency_key = ?').get(appId, idempotencyKey)) continue;
    const predecessorId = links.find((link) => link.endpoint_id !== replacementEndpointId)?.endpoint_id ?? directPredecessorId;
    const predecessor = db.prepare('SELECT id, runtime, provider_session_id FROM endpoints WHERE id = ?').get(predecessorId);
    const body = noticeBody(db, { predecessor, replacementEndpointId, replacementSessionId, subject: conversationSubject(db, conversationId), conversationId });
    const messageId = insertMessage(db, {
      conversationId,
      appId,
      senderPrincipalId: replacement.principal_id,
      kind: 'commit',
      body,
      metadata: { notice: 'replacement' },
      idempotencyKey,
      hash: payloadHash({ conversation_id: conversationId, body, obligation_effect: declaration }),
      origin: 'agent',
    });
    insertEffectRow(db, { messageId, effect: declaration, obligationId: null, obligationGeneration: null, now: new Date().toISOString() });
    const liveDeliveries = [];
    const presentations = [];
    for (const recipientEndpointId of counterpartEndpointIds(db, { appId, root, lineageIds })) {
      const routed = createDeliveriesForRecipients(db, {
        conversationId,
        messageId,
        senderPrincipalId: replacement.principal_id,
        senderEndpointId: replacementEndpointId,
        recipientEndpointId,
        routeReason: REPLACEMENT_NOTICE_ROUTE_REASON,
        sourceObligationId: root.id,
        routeReasonEndpointIds: new Set([recipientEndpointId]),
        stateRoot,
        logger,
      });
      liveDeliveries.push(...routed.liveDeliveries);
      presentations.push(...routed.presentations);
    }
    deliveryCount += liveDeliveries.length;
    wakes.push({ conversationId, liveDeliveries, presentations });
  }
  return { adoptedConversationCount, noticeCount: wakes.length, deliveryCount, wakes };
}
