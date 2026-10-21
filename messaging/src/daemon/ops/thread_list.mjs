// thread.list — the caller-scoped, read-only list of the threads one agent
// session belongs to (plan §2.4). It backs replacement disclosure and the
// agent threads CLI.
//
// Identity: the authenticated connection establishes only the application.
// The caller passes its loaded session tuple (principal_id, endpoint_id,
// process_generation) and the daemon validates it with the same policy every
// acting operation uses (requireActingEndpoint) before reading a row. There is
// no other selector: a request that names any other field is malformed, so a
// session cannot list on behalf of a sibling.
//
// Participant set: the validated endpoint plus every endpoint it replaced
// through resume lineage (resume_requests.replacement_endpoint_id), so an
// adopting session sees the threads of the session it took over from.
//
// Read-only: it never writes a row, never touches read_at, delivery state, or
// work state.

import { TightbeamError } from '../../protocol/envelope.mjs';
import { requireActingEndpoint } from '../lifecycle_transition.mjs';
import { chainNodes, chainWatches, conversationSubject, deriveChainLabel, isHostedLaunchFailure, launchFailureFor, sessionHandles } from './lifecycle_view.mjs';
import { offerRecipientEndpointIds, replacementDeliveryFor } from './message_shared.mjs';
import { deliveryStepFor } from '../../protocol/delivery_step.mjs';

const FIELDS = new Set(['principal_id', 'endpoint_id', 'process_generation', 'all', 'waiting_on', 'limit']);
const WAITING_ON_FILTERS = { me: 'you', them: 'them' };
export const THREAD_LIST_DEFAULT_LIMIT = 100;
export const THREAD_LIST_MAX_LIMIT = 1000;

function malformed(field, message) {
  throw new TightbeamError('malformed_request', message, { field });
}

function parsePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) malformed('payload', 'thread.list payload must be an object');
  const unknown = Object.keys(payload).find((key) => !FIELDS.has(key));
  if (unknown) malformed(unknown, `thread.list does not accept ${unknown}`);
  for (const field of ['principal_id', 'endpoint_id']) {
    if (typeof payload[field] !== 'string' || payload[field].length === 0) malformed(field, `${field} is required and must be a non-empty string`);
  }
  if (!Number.isInteger(payload.process_generation) || payload.process_generation < 1) {
    malformed('process_generation', 'process_generation is required and must be a positive integer');
  }
  const includeClosed = payload.all ?? false;
  if (typeof includeClosed !== 'boolean') malformed('all', 'all must be a boolean when present');
  const waitingOn = payload.waiting_on ?? null;
  if (waitingOn !== null && !Object.hasOwn(WAITING_ON_FILTERS, waitingOn)) malformed('waiting_on', 'waiting_on must be "me" or "them" when present');
  const limit = payload.limit ?? THREAD_LIST_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > THREAD_LIST_MAX_LIMIT) {
    malformed('limit', `limit must be an integer from 1 to ${THREAD_LIST_MAX_LIMIT}`);
  }
  return {
    principalId: payload.principal_id,
    endpointId: payload.endpoint_id,
    processGeneration: payload.process_generation,
    includeClosed,
    waitingOn,
    limit,
  };
}

// Validates the session tuple, then applies the register-only read rule that
// endpoint.list uses: the endpoint's authority must be inside the caller's
// register_endpoints grant. Failures reuse requireActingEndpoint's refusal
// vocabulary; an endpoint outside the grant is reported as not visible.
export function validatedEndpoint(db, connection, tuple) {
  requireActingEndpoint(db, {
    appId: connection.appId,
    senderPrincipalId: tuple.principalId,
    senderEndpointId: tuple.endpointId,
    processGeneration: tuple.processGeneration,
  });
  const grant = connection.permissions.get('register_endpoints');
  const authorities = Array.isArray(grant?.allowed_authorities) ? grant.allowed_authorities : [];
  const { authority_name: authority } = db.prepare('SELECT authority_name FROM endpoints WHERE id = ?').get(tuple.endpointId);
  if (!authorities.includes(authority)) {
    throw new TightbeamError('obligation_conflict', 'the acting endpoint is not visible to this application', { field: 'endpoint_id' });
  }
}

// The endpoint's lineage predecessors, transitively. UNION (not UNION ALL)
// dedups, so a malformed cycle in resume_requests still terminates. Only
// endpoints this application owns are followed.
export function predecessorEndpointIds(db, appId, endpointId) {
  return db
    .prepare(
      `WITH RECURSIVE lineage(id) AS (
         SELECT ?
         UNION
         SELECT rr.endpoint_id
           FROM resume_requests rr
           JOIN lineage l ON rr.replacement_endpoint_id = l.id
           JOIN endpoints e ON e.id = rr.endpoint_id AND e.created_by_app_id = ?
       )
       SELECT id FROM lineage WHERE id != ?`,
    )
    .all(endpointId, appId, endpointId)
    .map((row) => row.id);
}

// Every (conversation, endpoint, via) link tying a participant endpoint to a
// conversation this application created. The four links are the whole
// inclusion rule; nothing else makes a thread visible. The endpoint set is a
// handful of ids, and each link scans only rows of this application's
// conversations, which is bounded for the local scale (a few sessions and
// requests); no index is added for it.
export function participationLinks(db, appId, endpointIds) {
  const marks = endpointIds.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT links.conversation_id AS conversation_id, links.endpoint_id AS endpoint_id, links.via AS via
         FROM (
       SELECT m.conversation_id AS conversation_id,
              json_extract(me.effect_payload, '$.declaration.sender_endpoint_id') AS endpoint_id,
              'sender' AS via
         FROM message_effects me JOIN messages m ON m.id = me.message_id
        WHERE json_extract(me.effect_payload, '$.declaration.sender_endpoint_id') IN (${marks})
       UNION ALL
       SELECT m.conversation_id, d.endpoint_id, 'delivery'
         FROM deliveries d JOIN messages m ON m.id = d.message_id
        WHERE d.endpoint_id IN (${marks})
       UNION ALL
       SELECT o.conversation_id, o.custodian_endpoint_id, 'custody'
         FROM obligations o
        WHERE o.custodian_endpoint_id IN (${marks})
       UNION ALL
       SELECT rb.conversation_id, rb.target_endpoint_id, 'reply_binding'
         FROM reply_bindings rb
        WHERE rb.target_endpoint_id IN (${marks})
         ) links
         JOIN conversations c ON c.id = links.conversation_id
        WHERE c.created_by_app_id = ?`,
    )
    .all(...endpointIds, ...endpointIds, ...endpointIds, ...endpointIds, appId);
}

const SENDER_ENDPOINT = "json_extract(me.effect_payload, '$.declaration.sender_endpoint_id')";

function marksFor(ids) {
  return ids.map(() => '?').join(', ');
}

// The thread's work chain. A conversation can hold several requests; the
// newest open one is the live one, else the newest closed one.
export function chosenRoot(db, conversationId) {
  const roots = db.prepare("SELECT * FROM obligations WHERE conversation_id = ? AND role = 'root' ORDER BY created_at DESC, id DESC").all(conversationId);
  return roots.find((root) => root.status === 'open') ?? roots[0] ?? null;
}

// Open leaves are the nodes work currently rests on: an open attempt or
// delegation with no open child. A delegator that handed work on is waiting on
// the delegate, not holding it.
export function openLeaves(nodes) {
  const open = nodes.filter((node) => node.role !== 'root' && node.status === 'open');
  return open.filter((node) => !open.some((child) => child.parent_id === node.id));
}

/**
 * Every tracked work `endpointId` holds in the conversation right now (F23),
 * newest root first: each open root with an open attempt or accepted
 * delegation in that endpoint's custody, the exact condition `agent update|
 * complete|delegate --work` accepts. A conversation can hold several open
 * roots, so no single "chosen" root may decide whether work is held. The work
 * id is the root's; `ack_pending` is set when the work arrived as a user
 * message whose acknowledgement is still owed. `known` lends the chain nodes
 * of a root the caller already loaded.
 * @returns {Array<{work_id: string, ack_pending?: true}>}
 */
export function heldWorks(db, conversationId, endpointId, known = null) {
  return heldWorksIn(openRootChains(db, conversationId, known), endpointId);
}

// Every open root of the conversation with its chain nodes, newest root first.
// `known` lends the chain nodes of a root the caller already loaded.
function openRootChains(db, conversationId, known = null) {
  const roots = db.prepare("SELECT * FROM obligations WHERE conversation_id = ? AND role = 'root' AND status = 'open' ORDER BY created_at DESC, id DESC").all(conversationId);
  return roots.map((root) => ({ root, nodes: known?.rootId === root.id ? known.nodes : chainNodes(db, root.id) }));
}

function heldWorksIn(chains, endpointId) {
  if (typeof endpointId !== 'string') return [];
  return chains.map(({ root, nodes }) => heldWorkOf(root, nodes, endpointId)).filter((work) => work !== null);
}

// The root of the work one message is about, found the way message.read finds
// it: walk the reply chain (the message itself first) to the nearest message
// whose effect references an obligation, then that obligation's chain up to its
// root (the new root of an `open`, the node an update, handoff or close names).
// null when no message in the chain references an obligation: the root cannot
// be established, and nothing may be guessed in its place. Like message.read the
// walk has no fixed depth cap; a reply chain longer than the message table can
// only be a cycle, so that count bounds it.
function messageRootId(db, messageId) {
  const row = db
    .prepare(
      `WITH RECURSIVE reply_chain(id, parent_message_id, depth) AS (
         SELECT id, in_reply_to_message_id, 0 FROM messages WHERE id = ?
         UNION ALL
         SELECT m.id, m.in_reply_to_message_id, rc.depth + 1
           FROM messages m JOIN reply_chain rc ON rc.parent_message_id = m.id
          WHERE rc.depth < (SELECT COUNT(*) FROM messages)
       ), up(id, parent_id, depth) AS (
         SELECT o.id, o.parent_id, rc.depth
           FROM reply_chain rc
           JOIN message_effects me ON me.message_id = rc.id
           JOIN obligations o ON o.id = me.obligation_id
         UNION ALL
         SELECT o.id, o.parent_id, up.depth FROM obligations o JOIN up ON o.id = up.parent_id
       )
       SELECT id FROM up WHERE parent_id IS NULL ORDER BY depth ASC LIMIT 1`,
    )
    .get(messageId);
  return row?.id ?? null;
}

/**
 * The tracked work `endpointId` holds that one delivered message is about, or
 * null (F23). The message selects its own root through its reply lineage, and
 * work is shown only while that root is open and held by the endpoint (a closed
 * root, another holder's root and a pending offer show nothing). When the root
 * cannot be established (no `messageId`, or no message in its reply chain
 * references an obligation) there is no work id: the caller's newest held root
 * is never substituted, because it may belong to unrelated work.
 * @returns {{work_id: string, ack_pending?: true}|null}
 */
export function heldWork(db, conversationId, endpointId, { messageId = null } = {}) {
  if (typeof endpointId !== 'string' || typeof messageId !== 'string') return null;
  const rootId = messageRootId(db, messageId);
  if (rootId === null) return null;
  const root = db.prepare('SELECT * FROM obligations WHERE id = ? AND conversation_id = ?').get(rootId, conversationId);
  if (!root || root.status !== 'open') return null;
  return heldWorkOf(root, chainNodes(db, root.id), endpointId);
}

function heldWorkOf(root, nodes, endpointId) {
  const holds = nodes.some((node) => node.role !== 'root' && node.status === 'open' && node.custodian_endpoint_id === endpointId);
  if (!holds) return null;
  const ackPending = Boolean(root.ack_due_at) && !root.ack_accepted_at && Boolean(root.ack_message_id);
  return { work_id: root.id, ...(ackPending ? { ack_pending: true } : {}) };
}

function unreadCount(db, conversationId, endpointIds) {
  return db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM deliveries d JOIN messages m ON m.id = d.message_id
        WHERE m.conversation_id = ? AND d.endpoint_id IN (${marksFor(endpointIds)})
          AND d.read_at IS NULL AND d.acknowledged_at IS NULL AND d.state != 'failed'`,
    )
    .get(conversationId, ...endpointIds).n;
}

// Work state: lifecycle.view's label, plus what only a resolution can say.
// A cancelled root is `cancelled` for every holder, including descendants the
// cascade stored as `superseded` (their audit resolution is never rewritten).
// A delegate that declined its offer sees `declined` while the root lives on.
function workState({ db, root, nodes, watches, attention, caller, leaves }) {
  const label = deriveChainLabel({ root, nodes, watches, attention });
  if (root.status === 'closed') return root.resolution === 'cancelled' ? 'cancelled' : label;
  const declinedByCaller = nodes.some(
    (node) =>
      node.role === 'delegation' &&
      node.status === 'closed' &&
      offerAddressedToCaller(db, node, caller) &&
      watches.some((watch) => watch.delegation_id === node.id && watch.outcome === 'declined'),
  );
  const callerStillActs = leaves.some((leaf) => callerActsOn(db, leaf, caller));
  return declinedByCaller && !callerStillActs ? 'declined' : label;
}

function callerActsOn(db, leaf, caller) {
  if (leaf.custodian_endpoint_id !== null) return caller.endpointIds.includes(leaf.custodian_endpoint_id);
  return offerAddressedToCaller(db, leaf, caller);
}

// An offer is addressed to the caller's principal; an exact offer (one
// committed with recipient_endpoint_id) is addressed to that one session and
// its lineage successors, so a same-principal sibling is shown nothing to
// answer. An offer with no exact recipient keeps principal semantics.
function offerAddressedToCaller(db, node, caller) {
  if (node.accountable_principal_id !== caller.principalId) return false;
  const answerers = offerRecipientEndpointIds(db, node.id);
  if (answerers === null || answerers.includes(caller.endpointId)) return true;
  caller.logger?.debug?.({
    event: 'thread_offer_withheld',
    params: { delegation_id: node.id, endpoint_id: caller.endpointId },
    result: { reason: 'offered_to_different_session' },
    status: 'withheld',
  });
  return false;
}

// A thread with no open work whose latest outbound delivery from the caller
// failed or timed out (an untracked `new:` launch failure) waits on the
// caller: nobody else will act, so the default view must still show it.
function waitingOn({ db, root, leaves, caller, unread, step }) {
  const undelivered = step === 'failed' || step === 'timed_out';
  if (root === null) return unread > 0 || undelivered ? 'you' : 'nobody';
  if (root.status === 'closed') return undelivered ? 'you' : 'nobody';
  if (leaves.some((leaf) => callerActsOn(db, leaf, caller))) return 'you';
  return leaves.length > 0 ? 'them' : 'nobody';
}

// The endpoint that holds the tracked work now: the newest open attempt in
// custody, else the last attempt that had one. agent status --work names the
// same endpoint from the lifecycle projection's attempts.
function currentHolderEndpoint(nodes) {
  const held = nodes.filter((node) => node.role === 'attempt' && node.custodian_endpoint_id);
  return (held.findLast((node) => node.status === 'open') ?? held.at(-1))?.custodian_endpoint_id ?? null;
}

// A thread's delivery step is that of the caller's most recent outbound
// message, read by the rule agent status --work shares (protocol/
// delivery_step.mjs): the step the work's current holder reached, from its
// newest row; the least advanced recipient when the holder has none.
function deliveryStep(db, conversationId, endpointIds, holderEndpointId) {
  const message = db
    .prepare(
      `SELECT m.id AS id
         FROM messages m JOIN message_effects me ON me.message_id = m.id
        WHERE m.conversation_id = ? AND ${SENDER_ENDPOINT} IN (${marksFor(endpointIds)})
        ORDER BY m.created_at DESC, m.id DESC LIMIT 1`,
    )
    .get(conversationId, ...endpointIds);
  if (!message) return null;
  const rows = db
    .prepare('SELECT id AS delivery_id, COALESCE(channel_route_id, endpoint_id) AS recipient, endpoint_id, state, read_at, acknowledged_at, created_at FROM deliveries WHERE message_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(message.id)
    .map((row) => ({ ...row, replacement_delivery_id: replacementDeliveryFor(db, { messageId: message.id, endpointId: row.endpoint_id, state: row.state }) }));
  return deliveryStepFor(rows, { holderEndpointId });
}

/** The handle daemon-written copy uses for one session (see sessionHandles). */
export function shortSessionId(db, endpoint) {
  return sessionHandles(db)(endpoint);
}

// A thread the caller adopted only through a pending delivery that admission
// moved onto it keeps no predecessor link (the row itself was re-pointed).
// The replacement notice the caller wrote at adoption is the durable record
// that it adopted the thread, from its direct predecessor.
function disclosedPredecessorIds(db, conversationId, endpointId) {
  const disclosed = db
    .prepare(
      `SELECT 1 FROM messages m JOIN message_effects me ON me.message_id = m.id
        WHERE m.conversation_id = ? AND ${SENDER_ENDPOINT} = ? AND json_extract(m.metadata, '$.notice') = 'replacement' LIMIT 1`,
    )
    .get(conversationId, endpointId);
  if (!disclosed) return [];
  return db.prepare('SELECT endpoint_id FROM resume_requests WHERE replacement_endpoint_id = ? LIMIT 1').all(endpointId).map((row) => row.endpoint_id);
}

function roleFor(db, { conversationId, caller, links, nodes }) {
  const first = db
    .prepare(
      `SELECT ${SENDER_ENDPOINT} AS sender
         FROM messages m JOIN message_effects me ON me.message_id = m.id
        WHERE m.conversation_id = ? ORDER BY m.created_at ASC, m.id ASC LIMIT 1`,
    )
    .get(conversationId);
  if (first?.sender === caller.endpointId) return { role: 'started', adoptedFrom: [] };
  if (nodes.some((node) => node.role === 'delegation' && node.custodian_endpoint_id === caller.endpointId)) return { role: 'delegated to me', adoptedFrom: [] };
  const predecessorIds = caller.endpointIds.filter((id) => id !== caller.endpointId);
  const linkedIds = predecessorIds.filter((id) => links.some((link) => link.endpoint_id === id));
  const adoptedIds = linkedIds.length > 0 ? linkedIds : disclosedPredecessorIds(db, conversationId, caller.endpointId);
  if (adoptedIds.length === 0) return { role: 'participant', adoptedFrom: [] };
  const adoptedFrom = adoptedIds.map((id) => {
    const endpoint = db.prepare('SELECT id, provider_session_id, runtime FROM endpoints WHERE id = ?').get(id);
    return { endpoint_id: id, provider_session_id: endpoint.provider_session_id ?? null, runtime: endpoint.runtime ?? null, short: shortSessionId(db, endpoint) };
  });
  return { role: `adopted from ${adoptedFrom[0].short}`, adoptedFrom: adoptedFrom.map(({ short, ...rest }) => rest) };
}

// Every session the thread touches plus the user labels of its channel routes.
// The label is the channel route's, never an address or topology. A route is
// registered by its channel adapter's own application, never the agent's, so
// the conversation's own messages, deliveries and reply bindings (which only
// this application's conversation can hold) decide which routes it names.
export function participantsFor(db, appId, conversationId, callerEndpointId) {
  const handle = sessionHandles(db);
  const sessions = db
    .prepare(
      `SELECT e.id, e.provider_session_id, e.runtime, e.authority_reference
         FROM endpoints e
        WHERE e.created_by_app_id = ? AND e.id IN (
          SELECT ${SENDER_ENDPOINT} FROM message_effects me JOIN messages m ON m.id = me.message_id WHERE m.conversation_id = ?
          UNION SELECT d.endpoint_id FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE m.conversation_id = ?
          UNION SELECT custodian_endpoint_id FROM obligations WHERE conversation_id = ?
          UNION SELECT target_endpoint_id FROM reply_bindings WHERE conversation_id = ?)
        ORDER BY e.created_at ASC, e.id ASC`,
    )
    .all(appId, conversationId, conversationId, conversationId, conversationId)
    .map((e) => ({
      kind: 'session',
      endpoint_id: e.id,
      provider_session_id: e.provider_session_id ?? null,
      short_id: handle(e),
      runtime: e.runtime ?? null,
      authority_reference: e.authority_reference ?? null,
      is_self: e.id === callerEndpointId,
    }));
  const labels = db
    .prepare(
      `SELECT DISTINCT cr.label AS label
         FROM channel_routes cr
        WHERE cr.id IN (
          SELECT origin_channel_route_id FROM messages WHERE conversation_id = ? AND origin_channel_route_id IS NOT NULL
          UNION SELECT d.channel_route_id FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE m.conversation_id = ? AND d.channel_route_id IS NOT NULL
          UNION SELECT channel_route_id FROM reply_bindings WHERE conversation_id = ?)
        ORDER BY cr.label`,
    )
    .all(conversationId, conversationId, conversationId)
    .map((row) => ({ kind: 'user', label: row.label }));
  return [...sessions, ...labels];
}

// The delegation offered to the caller and still awaiting its answer: the
// only way a delegate learns the id `agent accept|decline --work` needs.
function pendingOffer(db, nodes, watches, caller) {
  const offered = nodes.find(
    (node) =>
      node.role === 'delegation' &&
      node.status === 'open' &&
      node.custodian_endpoint_id === null &&
      offerAddressedToCaller(db, node, caller) &&
      watches.some((watch) => watch.delegation_id === node.id && watch.state === 'awaiting_acceptance'),
  );
  return offered ? { delegation_id: offered.id } : null;
}

export function threadSummary(db, appId, conversationId, caller, links) {
  const root = chosenRoot(db, conversationId);
  const nodes = root ? chainNodes(db, root.id) : [];
  const watches = root ? chainWatches(db, root.id) : [];
  const attention = root ? db.prepare('SELECT attention_source FROM root_attention WHERE root_obligation_id = ?').get(root.id) ?? null : null;
  const leaves = openLeaves(nodes);
  const unread = unreadCount(db, conversationId, caller.endpointIds);
  const conversation = db.prepare('SELECT closed_at, created_at FROM conversations WHERE id = ?').get(conversationId);
  const lastActivity = db.prepare('SELECT MAX(created_at) AS at FROM messages WHERE conversation_id = ?').get(conversationId).at;
  const { role, adoptedFrom } = roleFor(db, { conversationId, caller, links, nodes });
  const state = root ? workState({ db, root, nodes, watches, attention, caller, leaves }) : null;
  const step = deliveryStep(db, conversationId, caller.endpointIds, currentHolderEndpoint(nodes));
  // Tracked work surfaces a launch failure while its root is open; an
  // untracked message has no root, so only its failed delivery does, or a
  // resume the daemon ended on purpose for a session another app holds (its
  // delivery is unread, not failed).
  const failure = root && root.status !== 'open' ? null : launchFailureFor(db, conversationId);
  const launchFailed = root ? root.status === 'open' : step === 'failed' || isHostedLaunchFailure(failure);
  const chains = openRootChains(db, conversationId, root ? { rootId: root.id, nodes } : null);
  // Offers to the caller on ANY open root, newest root first: an offer on an
  // earlier root makes the thread wait on the caller, so its id must be shown.
  const offers = chains
    .map((chain) => pendingOffer(db, chain.nodes, chain.root.id === root?.id ? watches : chainWatches(db, chain.root.id), caller))
    .filter((found) => found !== null);
  const offer = offers[0] ?? null;
  const held = heldWorksIn(chains, caller.endpointId);
  // A conversation can hold several open roots; the chosen one decides the
  // state shown, but the caller owes the thread whenever ANY open root rests
  // on it, so --waiting-on me and held_works agree.
  const owesOpenWork = chains.some((chain) => openLeaves(chain.nodes).some((leaf) => callerActsOn(db, leaf, caller)));
  return {
    conversation_id: conversationId,
    subject: conversationSubject(db, conversationId),
    root_obligation_id: root?.id ?? null,
    role,
    adopted_from: adoptedFrom,
    work_state: state,
    delivery_step: step,
    launch_failure: launchFailed ? failure : null,
    unread_count: unread,
    last_activity_at: lastActivity ?? conversation.created_at,
    // A declined offer leaves nothing for the delegate to wait on.
    waiting_on: owesOpenWork ? 'you' : state === 'declined' ? 'nobody' : waitingOn({ db, root, leaves, caller, unread, step }),
    open: root?.status === 'open' && conversation.closed_at === null,
    // pending_offer is the newest root's offer; pending_offers lists every one (additive).
    ...(offer ? { pending_offer: offer, pending_offers: offers } : {}),
    // held_work is the newest held root; held_works is every open root the caller holds (additive).
    ...(held.length > 0 ? { held_work: held[0], held_works: held } : {}),
  };
}

function byRecency(a, b) {
  if (a.last_activity_at !== b.last_activity_at) return a.last_activity_at < b.last_activity_at ? 1 : -1;
  return a.conversation_id < b.conversation_id ? 1 : -1;
}

function listThreads(context, connection, request) {
  const db = context.db;
  validatedEndpoint(db, connection, request);
  const predecessors = predecessorEndpointIds(db, connection.appId, request.endpointId);
  const caller = { principalId: request.principalId, endpointId: request.endpointId, endpointIds: [request.endpointId, ...predecessors], logger: context.logger };
  const linksByConversation = Map.groupBy(participationLinks(db, connection.appId, caller.endpointIds), (link) => link.conversation_id);
  const wanted = request.waitingOn === null ? null : WAITING_ON_FILTERS[request.waitingOn];
  const summaries = [...linksByConversation]
    .map(([conversationId, links]) => threadSummary(db, connection.appId, conversationId, caller, links))
    .filter((thread) => (wanted === null || thread.waiting_on === wanted) && (request.includeClosed || thread.open || thread.waiting_on === 'you'))
    .sort(byRecency);
  const truncated = summaries.length > request.limit;
  const threads = summaries.slice(0, request.limit).map((thread) => ({
    ...thread,
    participants: participantsFor(db, connection.appId, thread.conversation_id, caller.endpointId),
  }));
  return { threads, truncated, predecessorCount: predecessors.length };
}

export const threadListOp = {
  name: 'thread.list',
  allowedScopes: ['agent'],
  permission: 'register_endpoints',
  handler(context, payload, connection) {
    const startedAt = performance.now();
    const request = parsePayload(payload);
    const params = { endpoint_id: request.endpointId, all: request.includeClosed, waiting_on: request.waitingOn, limit: request.limit };
    try {
      const { threads, truncated, predecessorCount } = listThreads(context, connection, request);
      context.logger?.info({
        event: 'thread.list',
        params: { ...params, lineage_endpoint_count: predecessorCount },
        result: { thread_count: threads.length, truncated },
        status: 'ok',
        latency_ms: Math.round(performance.now() - startedAt),
      });
      return { result: { threads, truncated } };
    } catch (error) {
      context.logger?.warn({ event: 'thread.list', params, status: 'error', code: error?.code ?? 'internal_error', latency_ms: Math.round(performance.now() - startedAt) });
      throw error;
    }
  },
};
