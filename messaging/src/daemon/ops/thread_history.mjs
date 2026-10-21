// thread.history — the caller-scoped, read-only ordered history of one thread
// (plan §2.4). It backs `agent thread` (S6) and resolves the agent that owes
// the caller for `agent send --thread`.
//
// Identity and gate: the same loaded session tuple thread.list validates
// (requireActingEndpoint plus the register_endpoints authority rule), and the
// same participant set (the endpoint plus the lineage predecessors it
// replaced). The handle is resolved and the participant check applied before
// any body is read. A handle that names no thread of this application is
// `thread_not_found`; a thread the caller set has no link to is
// `not_a_participant`. Neither refusal carries a subject, body, or count.
//
// Read-only: it never writes a row, never touches read_at, delivery state, or
// work state.

import { TightbeamError } from '../../protocol/envelope.mjs';
import { ID_PREFIXES } from '../../protocol/ids.mjs';
import { chainNodes, sessionHandles } from './lifecycle_view.mjs';
import { replacementDeliveryFor } from './message_shared.mjs';
import { returnedWorkNotice, returnedWorkRouteReasons } from './notification_context.mjs';
import { participantsFor, participationLinks, predecessorEndpointIds, threadSummary, validatedEndpoint } from './thread_list.mjs';

const FIELDS = new Set(['principal_id', 'endpoint_id', 'process_generation', 'thread', 'limit', 'since', 'header_only']);
const CONVERSATION_PREFIX = ID_PREFIXES.conversation;
// A handle is the hex suffix of a conversation id, whole or a prefix of at
// least 8 characters, with or without the `cnv_` prefix.
const HANDLE_PATTERN = /^[0-9a-f]{8,32}$/;
export const THREAD_HISTORY_DEFAULT_LIMIT = 100;
export const THREAD_HISTORY_MAX_LIMIT = 1000;

// Effects that change who holds or how the work stands become their own
// history event right after the message that carried them. `update` and
// `none` are just messages.
const EFFECT_EVENTS = {
  open: 'opened',
  'handoff.offer': 'delegated',
  'handoff.accept': 'accepted',
  'handoff.decline': 'declined',
  'close.fulfilled': 'completed',
  'close.cancelled': 'cancelled',
};

function malformed(field, message) {
  throw new TightbeamError('malformed_request', message, { field });
}

function parseSince(since) {
  if (since === undefined || since === null) return null;
  const at = typeof since === 'string' ? new Date(since) : new Date(Number.NaN);
  if (Number.isNaN(at.getTime())) malformed('since', 'since must be an ISO-8601 timestamp when present');
  return at.toISOString();
}

function parsePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) malformed('payload', 'thread.history payload must be an object');
  const unknown = Object.keys(payload).find((key) => !FIELDS.has(key));
  if (unknown) malformed(unknown, `thread.history does not accept ${unknown}`);
  for (const field of ['principal_id', 'endpoint_id']) {
    if (typeof payload[field] !== 'string' || payload[field].length === 0) malformed(field, `${field} is required and must be a non-empty string`);
  }
  if (!Number.isInteger(payload.process_generation) || payload.process_generation < 1) {
    malformed('process_generation', 'process_generation is required and must be a positive integer');
  }
  const thread = typeof payload.thread === 'string' ? payload.thread : '';
  const handle = thread.startsWith(CONVERSATION_PREFIX) ? thread.slice(CONVERSATION_PREFIX.length) : thread;
  if (!HANDLE_PATTERN.test(handle)) {
    malformed('thread', 'thread must be a conversation id or a handle of at least 8 hex characters');
  }
  const limit = payload.limit ?? THREAD_HISTORY_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > THREAD_HISTORY_MAX_LIMIT) {
    malformed('limit', `limit must be an integer from 1 to ${THREAD_HISTORY_MAX_LIMIT}`);
  }
  const headerOnly = payload.header_only ?? false;
  if (typeof headerOnly !== 'boolean') malformed('header_only', 'header_only must be a boolean when present');
  return {
    principalId: payload.principal_id,
    endpointId: payload.endpoint_id,
    processGeneration: payload.process_generation,
    handle,
    limit,
    since: parseSince(payload.since),
    headerOnly,
  };
}

function threadNotFound() {
  throw new TightbeamError('thread_not_found', 'no thread matches this handle', { field: 'thread' });
}

function notAParticipant() {
  throw new TightbeamError('not_a_participant', 'the caller is not a participant in this thread', { field: 'thread' });
}

// Resolves the handle among this application's conversations, preferring the
// caller's own: a prefix shared with a thread the caller is not in never
// blocks or reveals anything. Ambiguity is reported only among the caller's
// own threads. Returns the conversation and the caller set's links to it.
function resolveThread(db, appId, handle, caller) {
  const prefix = `${CONVERSATION_PREFIX}${handle}`;
  const matches = db
    .prepare('SELECT id FROM conversations WHERE created_by_app_id = ? AND substr(id, 1, ?) = ?')
    .all(appId, prefix.length, prefix)
    .map((row) => row.id);
  if (matches.length === 0) threadNotFound();
  const linksByConversation = Map.groupBy(participationLinks(db, appId, caller.endpointIds), (link) => link.conversation_id);
  const mine = matches.filter((id) => linksByConversation.has(id));
  if (mine.length === 0) notAParticipant();
  if (mine.length > 1) malformed('thread', 'the handle matches more than one of your threads; use more characters');
  return { conversationId: mine[0], links: linksByConversation.get(mine[0]) };
}

// Session summaries in thread.list's participant shape, read once per id.
function sessionReader(db, appId, callerEndpointId) {
  const cache = new Map();
  const handle = sessionHandles(db);
  return (endpointId) => {
    if (typeof endpointId !== 'string') return null;
    if (!cache.has(endpointId)) {
      const e = db.prepare('SELECT id, provider_session_id, runtime, authority_reference FROM endpoints WHERE id = ? AND created_by_app_id = ?').get(endpointId, appId);
      cache.set(
        endpointId,
        e
          ? { kind: 'session', endpoint_id: e.id, provider_session_id: e.provider_session_id ?? null, short_id: handle(e), runtime: e.runtime ?? null, authority_reference: e.authority_reference ?? null, is_self: e.id === callerEndpointId }
          : null,
      );
    }
    return cache.get(endpointId);
  };
}

function deliveryStep(row) {
  if (row.state === 'failed') return 'failed';
  if (row.state === 'expired') return 'timed_out';
  if (row.acknowledged_at) return 'acknowledged';
  if (row.read_at) return 'received';
  return row.state === 'delivered' ? 'delivered' : 'committed';
}

function declarationOf(effectPayload) {
  try {
    return JSON.parse(effectPayload ?? '{}')?.declaration ?? {};
  } catch {
    return {};
  }
}

function recipientsOf(db, messageId, session) {
  const rows = db
    .prepare(
      `SELECT d.endpoint_id, d.channel_route_id, d.state, d.read_at, d.acknowledged_at, cr.label
         FROM deliveries d LEFT JOIN channel_routes cr ON cr.id = d.channel_route_id
        WHERE d.message_id = ?
        ORDER BY d.created_at ASC, d.rowid ASC`,
    )
    .all(messageId);
  // A re-delivered message has several rows for one recipient; the latest
  // row carries its current step.
  const byRecipient = new Map();
  for (const row of rows) {
    // The replacement's own row stands for a superseded endpoint's duplicate.
    if (replacementDeliveryFor(db, { messageId, endpointId: row.endpoint_id, state: row.state }) !== null) continue;
    const who = row.channel_route_id ? { kind: 'user', label: row.label } : session(row.endpoint_id) ?? { kind: 'session', endpoint_id: row.endpoint_id };
    byRecipient.set(row.channel_route_id ?? row.endpoint_id, { ...who, step: deliveryStep(row) });
  }
  return [...byRecipient.values()];
}

function unreadMessageIds(db, conversationId, endpointIds) {
  const marks = endpointIds.map(() => '?').join(', ');
  return new Set(
    db
      .prepare(
        `SELECT DISTINCT d.message_id AS id
           FROM deliveries d JOIN messages m ON m.id = d.message_id
          WHERE m.conversation_id = ? AND d.endpoint_id IN (${marks})
            AND d.read_at IS NULL AND d.acknowledged_at IS NULL AND d.state != 'failed'`,
      )
      .all(conversationId, ...endpointIds)
      .map((row) => row.id),
  );
}

// Message items without their body, recipients, or unread tag: those are
// hydrated only for the page that is returned (hydrateMessages).
function messageItems(db, conversationId, { session }) {
  const rows = db
    .prepare(
      `SELECT m.id, m.created_at, m.sender_principal_id, m.origin_channel_route_id, m.in_reply_to_message_id,
              me.effect, me.effect_payload, me.obligation_id, cr.label AS origin_label
         FROM messages m
         LEFT JOIN message_effects me ON me.message_id = m.id
         LEFT JOIN channel_routes cr ON cr.id = m.origin_channel_route_id
        WHERE m.conversation_id = ?
        ORDER BY m.created_at ASC, m.rowid ASC`,
    )
    .all(conversationId);
  return rows.flatMap((row) => {
    const declaration = declarationOf(row.effect_payload);
    const sender = row.origin_channel_route_id
      ? { kind: 'user', label: row.origin_label }
      : session(declaration.sender_endpoint_id) ?? { kind: 'principal', principal_id: row.sender_principal_id };
    const message = {
      type: 'message',
      message_id: row.id,
      at: row.created_at,
      sender,
      recipients: null,
      kind: row.effect ?? 'message',
      body: null,
      in_reply_to_message_id: row.in_reply_to_message_id ?? null,
      unread: false,
    };
    const event = EFFECT_EVENTS[row.effect];
    if (!event) return [message];
    const holder = event === 'opened' ? session(declaration.target_endpoint_id) : event === 'accepted' ? sender : undefined;
    return [message, { type: 'event', event, at: row.created_at, message_id: row.id, obligation_id: row.obligation_id ?? null, actor: sender, ...(holder === undefined ? {} : { holder }) }];
  });
}

// The caller's unread typed wakes that hand offered work back to it (expiry,
// custody loss) re-deliver the caller's own offer message. Each such message
// carries the notice that says what happened (proof F39), by message id.
function returnedWorkNotices(db, conversationId, endpointIds) {
  const reasons = returnedWorkRouteReasons();
  const rows = db
    .prepare(
      `SELECT d.id, d.message_id
         FROM deliveries d JOIN messages m ON m.id = d.message_id
        WHERE m.conversation_id = ? AND d.endpoint_id IN (${endpointIds.map(() => '?').join(', ')})
          AND d.route_reason IN (${reasons.map(() => '?').join(', ')})
          AND d.read_at IS NULL AND d.acknowledged_at IS NULL AND d.state != 'failed'
        ORDER BY d.created_at ASC, d.id ASC`,
    )
    .all(conversationId, ...endpointIds, ...reasons);
  const notices = new Map();
  for (const row of rows) {
    const notice = returnedWorkNotice(db, { messageId: row.message_id, deliveryId: row.id });
    if (notice) notices.set(row.message_id, { ...notice.detail, text: notice.text });
  }
  return notices;
}

function hydrateMessages(db, items, { conversationId, session, caller }) {
  const messages = items.filter((item) => item.type === 'message');
  if (messages.length === 0) return items;
  const ids = messages.map((item) => item.message_id);
  const bodies = new Map(
    db.prepare(`SELECT id, body FROM messages WHERE id IN (${ids.map(() => '?').join(', ')})`).all(...ids).map((row) => [row.id, row.body]),
  );
  const unread = unreadMessageIds(db, conversationId, caller.endpointIds);
  const notices = returnedWorkNotices(db, conversationId, caller.endpointIds);
  for (const message of messages) {
    message.recipients = recipientsOf(db, message.message_id, session);
    message.body = bodies.get(message.message_id) ?? null;
    message.unread = unread.has(message.message_id);
    if (notices.has(message.message_id)) message.notice = notices.get(message.message_id);
  }
  return items;
}

// How many items a full read would return, counted without reading any of
// them: one per message, one per effect event, one per replacement.
function itemCount(db, conversationId, replacements) {
  const events = Object.keys(EFFECT_EVENTS);
  const counted = db
    .prepare(
      `SELECT COUNT(*) AS messages,
              COUNT(CASE WHEN me.effect IN (${events.map(() => '?').join(', ')}) THEN 1 END) AS events
         FROM messages m LEFT JOIN message_effects me ON me.message_id = m.id
        WHERE m.conversation_id = ?`,
    )
    .get(...events, conversationId);
  return counted.messages + counted.events + replacements.length;
}

// Lineage: each participant endpoint a replacement session took over.
function replacementEvents(db, appId, sessionIds, session) {
  if (sessionIds.length === 0) return [];
  const marks = sessionIds.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT rr.endpoint_id, rr.replacement_endpoint_id, COALESCE(rr.replacement_admitted_at, rr.updated_at) AS at
         FROM resume_requests rr JOIN endpoints e ON e.id = rr.replacement_endpoint_id AND e.created_by_app_id = ?
        WHERE rr.replacement_endpoint_id IS NOT NULL AND rr.endpoint_id IN (${marks})
        ORDER BY at ASC, rr.id ASC`,
    )
    .all(appId, ...sessionIds)
    .map((row) => ({ type: 'event', event: 'replaced', at: row.at, replaced: session(row.endpoint_id), replacement: session(row.replacement_endpoint_id) }));
}

// Messages keep commit order with each effect event right behind its
// message; a lineage event sorts after anything committed at the same time.
function ordered(messages, replacements) {
  const keyed = [...messages.map((item, seq) => ({ item, seq })), ...replacements.map((item) => ({ item, seq: Number.MAX_SAFE_INTEGER }))];
  return keyed.sort((a, b) => (a.item.at === b.item.at ? a.seq - b.seq : a.item.at < b.item.at ? -1 : 1)).map(({ item }) => item);
}

function page(items, { since, limit }) {
  const recent = since === null ? items : items.filter((item) => item.at >= since);
  const shown = recent.slice(-limit);
  return { items: shown, hidden_count: items.length - shown.length };
}

// The node the work currently rests on: the deepest open node with a bound
// custodian. An offer not yet accepted leaves the work with the offerer.
function currentHolder(nodes) {
  const held = nodes.filter((node) => node.status === 'open' && node.custodian_endpoint_id !== null);
  return held.find((node) => !held.some((child) => child.parent_id === node.id)) ?? null;
}

function requesterEndpointId(db, rootId) {
  const row = db.prepare("SELECT effect_payload FROM message_effects WHERE effect = 'open' AND obligation_id = ?").get(rootId);
  return row ? declarationOf(row.effect_payload).sender_endpoint_id ?? null : null;
}

function participantRole(endpointId, { requesterId, holderId, nodes }) {
  if (endpointId === requesterId) return 'requester';
  if (holderId === endpointId) return 'holder';
  const delegates = nodes.some((node) => node.status === 'open' && node.custodian_endpoint_id === endpointId && nodes.some((child) => child.parent_id === node.id && child.role === 'delegation' && child.status === 'open'));
  return delegates ? 'delegator' : 'participant';
}

// The newest root the caller set opened here, preferring open work.
function callerRoot(db, conversationId, endpointIds) {
  const marks = endpointIds.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT o.id, o.status, o.resolution, replacement.resolution AS superseded_by_resolution
         FROM obligations o JOIN message_effects me ON me.obligation_id = o.id AND me.effect = 'open'
         LEFT JOIN obligations replacement ON replacement.id = o.resolution_replacement_id
        WHERE o.conversation_id = ? AND o.role = 'root'
          AND json_extract(me.effect_payload, '$.declaration.sender_endpoint_id') IN (${marks})
        ORDER BY o.status = 'open' DESC, o.created_at DESC, o.id DESC
        LIMIT 1`,
    )
    .get(conversationId, ...endpointIds) ?? null;
}

// Forward resume lineage: the newest session that took over `endpointId`,
// transitively. The visited set stops a malformed cycle.
function latestReplacement(db, appId, endpointId) {
  const next = db.prepare(
    `SELECT rr.replacement_endpoint_id AS id
       FROM resume_requests rr JOIN endpoints e ON e.id = rr.replacement_endpoint_id AND e.created_by_app_id = ?
      WHERE rr.endpoint_id = ? AND rr.replacement_endpoint_id IS NOT NULL
      ORDER BY COALESCE(rr.replacement_admitted_at, rr.updated_at) DESC, rr.id DESC
      LIMIT 1`,
  );
  const visited = new Set([endpointId]);
  let current = endpointId;
  for (let row = next.get(appId, current); row && !visited.has(row.id); row = next.get(appId, current)) {
    visited.add(row.id);
    current = row.id;
  }
  return current;
}

// The agent that owes the caller (plan §2.4 send --thread step 1): the
// custodian of the caller's root attempt. Delegating does not move the debt
// (the delegate is reported as information); a replacement inherits it.
// Null when the caller opened no work here.
function owedBy(db, appId, { conversationId, caller, session }) {
  const root = callerRoot(db, conversationId, caller.endpointIds);
  if (!root) return null;
  const nodes = chainNodes(db, root.id);
  const attempts = nodes.filter((node) => node.role === 'attempt' && node.parent_id === root.id);
  const attempt = attempts.find((node) => node.status === 'open') ?? attempts.at(-1);
  if (!attempt) return null;
  const endpointId = latestReplacement(db, appId, attempt.custodian_endpoint_id);
  const holderNode = currentHolder(nodes);
  return {
    ...session(endpointId),
    root_obligation_id: root.id,
    root_status: root.status,
    // How the caller's own root ended (null while open); a follow-up refusal
    // labels it from here, never from the thread's chosen root.
    root_resolution: root.resolution ?? null,
    // A superseded root ended however the node that superseded it ended.
    root_superseded_by_resolution: root.resolution === 'superseded' ? (root.superseded_by_resolution ?? null) : null,
    replaced_endpoint_id: endpointId === attempt.custodian_endpoint_id ? null : attempt.custodian_endpoint_id,
    delegated_to: holderNode?.role === 'delegation' ? session(holderNode.custodian_endpoint_id) : null,
  };
}

function threadHeader(db, appId, { conversationId, caller, links, session }) {
  const summary = threadSummary(db, appId, conversationId, caller, links);
  const nodes = summary.root_obligation_id ? chainNodes(db, summary.root_obligation_id) : [];
  const holderNode = currentHolder(nodes);
  // Custody may still record a session that was replaced (before its
  // replacement's SessionStart recovery): the work rests with the newest.
  const holderId = holderNode ? latestReplacement(db, appId, holderNode.custodian_endpoint_id) : null;
  const roleContext = { requesterId: summary.root_obligation_id ? requesterEndpointId(db, summary.root_obligation_id) : null, holderId, nodes };
  const participants = participantsFor(db, appId, conversationId, caller.endpointId).map((p) => (p.kind === 'session' ? { ...p, role: participantRole(p.endpoint_id, roleContext) } : p));
  return {
    ...summary,
    participants,
    holder: holderId ? session(holderId) : null,
    owed_by: owedBy(db, appId, { conversationId, caller, session }),
  };
}

function readHistory(context, connection, request) {
  const db = context.db;
  const appId = connection.appId;
  validatedEndpoint(db, connection, request);
  const predecessors = predecessorEndpointIds(db, appId, request.endpointId);
  const caller = { principalId: request.principalId, endpointId: request.endpointId, endpointIds: [request.endpointId, ...predecessors], logger: context.logger };
  const { conversationId, links } = resolveThread(db, appId, request.handle, caller);
  const session = sessionReader(db, appId, caller.endpointId);
  const thread = threadHeader(db, appId, { conversationId, caller, links, session });
  const sessionIds = thread.participants.filter((p) => p.kind === 'session').map((p) => p.endpoint_id);
  const replacements = replacementEvents(db, appId, sessionIds, session);
  // A follow-up needs only the header: no item is read, all are hidden.
  if (request.headerOnly) return { thread, items: [], hidden_count: itemCount(db, conversationId, replacements) };
  const paged = page(ordered(messageItems(db, conversationId, { session }), replacements), request);
  return { thread, items: hydrateMessages(db, paged.items, { conversationId, session, caller }), hidden_count: paged.hidden_count };
}

export const threadHistoryOp = {
  name: 'thread.history',
  allowedScopes: ['agent'],
  permission: 'register_endpoints',
  handler(context, payload, connection) {
    const startedAt = performance.now();
    const request = parsePayload(payload);
    const params = { endpoint_id: request.endpointId, limit: request.limit, since: request.since, header_only: request.headerOnly };
    try {
      const result = readHistory(context, connection, request);
      context.logger?.info({
        event: 'thread.history',
        params,
        result: { conversation_id: result.thread.conversation_id, item_count: result.items.length, hidden_count: result.hidden_count, unread_count: result.thread.unread_count },
        status: 'ok',
        latency_ms: Math.round(performance.now() - startedAt),
      });
      return { result };
    } catch (error) {
      context.logger?.warn({ event: 'thread.history', params, status: 'error', code: error?.code ?? 'internal_error', latency_ms: Math.round(performance.now() - startedAt) });
      throw error;
    }
  },
};
