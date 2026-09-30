// Shared transport/write logic for conversation.create, inbox.list,
// message.read, message.acknowledge, endpoint.register's watermark refresh,
// and the single forward lifecycle writer message.commit via
// src/daemon/lifecycle_transition.mjs (docs/protocol.md "Conversations and
// messages"). The legacy message.send/message.reply writers these helpers
// once served were retired by the forward lifecycle cutover; the helpers
// themselves are the forward writer's reuse surface and stay.

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { TightbeamError } from '../../protocol/envelope.mjs';
import { generateId } from '../../protocol/ids.mjs';
import { isSafeSessionId, sessionPaths } from '../../protocol/session_paths.mjs';
import { isUniqueConstraintError } from './authority_scope.mjs';
import { REPLY_BINDING_POLICY } from '../reply_listener_policy.mjs';
import { activeListenerForEndpoint, createPendingPresentation } from './listener_operations.mjs';

/**
 * Deep, key-sorted JSON serialization so two payloads with the same
 * content but different key order hash identically (docs/protocol.md
 * "Idempotency": "a SHA-256 of the canonical payload"). Arrays keep their
 * order — order is semantic there.
 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key]);
    return sorted;
  }
  return value;
}

export function payloadHash(fields) {
  const json = JSON.stringify(canonicalize(fields));
  return createHash('sha256').update(json).digest('hex');
}

/**
 * Which grant authorizes this caller to act as `principal`:
 *   'agent'    — send_as_principal scoped to the sender principal's
 *                authority AND ownership of that principal (F3: two
 *                applications sharing the same authority scope must not be
 *                able to send as each other's principals);
 *   'inbound'  — bare publish_inbound_messages, the unscoped alternate
 *                grant path for a channel bridge, deliberately NOT
 *                ownership-checked — it exists precisely to let a bridge
 *                app inject a verified reply as a principal it does not own;
 *   null       — neither grant: the caller may not act as this principal.
 *
 * The branch is also the message's durable origin: when both grants are
 * held the scoped-and-owned path wins, so an application's own session
 * traffic is never mistaken for bridge ingress.
 * docs/security-model.md Permission catalog #2, #7.
 */
export function resolveSendBranch(connection, principal) {
  const sendGrant = connection.permissions.get('send_as_principal');
  if (
    sendGrant &&
    Array.isArray(sendGrant.allowed_authorities) &&
    sendGrant.allowed_authorities.includes(principal.authority_name) &&
    principal.created_by_app_id === connection.appId
  ) {
    return 'agent';
  }
  if (connection.permissions.has('publish_inbound_messages')) return 'inbound';
  return null;
}

export function requirePrincipal(db, principalId, field) {
  const principal = db.prepare('SELECT id, authority_name, created_by_app_id FROM principals WHERE id = ?').get(principalId);
  if (!principal) {
    throw new TightbeamError('malformed_request', `no principal registered with id "${principalId}"`, { field });
  }
  return principal;
}

export function requireParticipant(db, conversationId, principalId) {
  const row = db
    .prepare('SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND principal_id = ?')
    .get(conversationId, principalId);
  if (!row) {
    throw new TightbeamError('conversation_binding_conflict', `principal "${principalId}" is not a participant of conversation "${conversationId}"`);
  }
}

export function loadConversationOrUnknown(db, conversationId) {
  const conversation = db.prepare('SELECT id, owner_principal_id, closed_at FROM conversations WHERE id = ?').get(conversationId);
  if (!conversation) {
    throw new TightbeamError('conversation_unknown', `no conversation registered with id "${conversationId}"`);
  }
  return conversation;
}

/**
 * Stamps owner_principal_id on the first accepted send into a fresh
 * conversation. The column is only ever included in an UPDATE guarded by
 * `WHERE owner_principal_id IS NULL`, so no code path ever changes an
 * already-set value (the state ownership contract §4 "Routing bindings do not
 * change from untrusted input"; adapted from tldr;'s
 * thread_ownership.mjs fail-closed, no-override binding rule — see
 * the internal provenance record).
 */
export function stampOwnerIfUnset(db, conversationId, senderPrincipalId) {
  db.prepare('UPDATE conversations SET owner_principal_id = ? WHERE id = ? AND owner_principal_id IS NULL').run(
    senderPrincipalId,
    conversationId,
  );
}

/**
 * Creates the direct conversation for one authored message intent. Called
 * from inside the caller's single write transaction. Participant pairs are
 * deliberately not a thread identity: a new obligation creates a new
 * canonical conversation and exact retries are resolved by idempotency
 * before reaching this helper.
 */
export function resolveOrCreateDirectConversation(db, { appId, principalA, principalB, metadata }) {
  const conversationId = generateId('conversation');
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO conversations (id, created_by_app_id, binding_kind, owner_principal_id, metadata, created_at) VALUES (?, ?, 'direct', NULL, ?, ?)",
  ).run(conversationId, appId, JSON.stringify(metadata), now);
  for (const principalId of new Set([principalA, principalB])) {
    db.prepare('INSERT INTO conversation_participants (conversation_id, principal_id, role, added_at) VALUES (?, ?, NULL, ?)').run(
      conversationId,
      principalId,
      now,
    );
  }
  return conversationId;
}

/**
 * At most one ACTIVE (pending or claimed) resume request per (endpoint,
 * message): guaranteed transactionally (check-before-insert inside the
 * caller's single message-send/reply transaction; node:sqlite is
 * synchronous and Node is single-threaded, so no other write can
 * interleave), not by a structural unique index. The check covers BOTH
 * active states — a claimed request is just as live as a pending one, and
 * inserting beside it would duplicate the wake exactly when recovery is
 * already underway. In practice this check is defense-in-depth — the
 * deliveries table's own partial-unique index on (message_id,
 * endpoint_id) already means at most one fan-out call ever runs for a
 * given (endpoint, message) pair, so at most one resume-request-creation
 * attempt can ever occur for it.
 */
export function maybeCreateResumeRequest(db, { endpoint, conversationId, messageId, reason }) {
  const existing = db
    .prepare("SELECT id FROM resume_requests WHERE endpoint_id = ? AND message_id = ? AND state IN ('pending', 'claimed')")
    .get(endpoint.id, messageId);
  if (existing) return existing.id;

  const now = new Date().toISOString();
  const id = generateId('resume_request');
  db.prepare(
    `INSERT INTO resume_requests
      (id, endpoint_id, principal_id, session_id, conversation_id, message_id, reason, authority_reference, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(
    id,
    endpoint.id,
    endpoint.principal_id,
    endpoint.session_id,
    conversationId,
    messageId,
    reason,
    endpoint.authority_reference,
    now,
    now,
  );
  return id;
}

/**
 * Records the exact endpoint delivery selected by a daemon-derived inbound
 * reply. Bound channel ingress intentionally does not consult the generic
 * principal subscription bus: listener.v1 owns the later live presentation
 * path. Until that path exists, this uses only the durable resume/enqueue
 * branch so one reply can never choose both outcomes.
 */
export function createDerivedInboundDelivery(db, { conversationId, messageId, endpoint, listener = null }) {
  if (listener) {
    const now = new Date().toISOString();
    const deliveryId = generateId('delivery');
    db.prepare(
      "INSERT INTO deliveries (id, message_id, endpoint_id, state, route_reason, source_obligation_id, created_at, updated_at) VALUES (?, ?, ?, 'pending', NULL, NULL, ?, ?)",
    ).run(deliveryId, messageId, endpoint.id, now, now);
    return { delivery_id: deliveryId, route_outcome: 'live_pending_ack' };
  }
  const route = routeDelivery({
    endpointState: endpoint.state,
    launchMode: endpoint.launch_mode,
    hasExactListener: false,
  });
  if (route === 'skip') {
    throw new TightbeamError('permission_denied', 'the reply binding target endpoint is closed');
  }
  const now = new Date().toISOString();
  const deliveryId = generateId('delivery');
  db.prepare(
    "INSERT INTO deliveries (id, message_id, endpoint_id, state, route_reason, source_obligation_id, created_at, updated_at) VALUES (?, ?, ?, 'pending', NULL, NULL, ?, ?)",
  ).run(deliveryId, messageId, endpoint.id, now, now);
  if (route === 'resume_dead' || route === 'resume_idle') {
    maybeCreateResumeRequest(db, {
      endpoint,
      conversationId,
      messageId,
      reason: RESUME_REASON_BY_ROUTE[route],
    });
  }
  return {
    delivery_id: deliveryId,
    route_outcome: route === 'resume_dead' || route === 'resume_idle' ? 'resume_pending' : 'enqueue_only',
  };
}

/**
 * The delivery routing tree, ported from Helm's comms_dispatcher.mjs (see
 * the internal provenance record). Pure so every outcome is reachable in a unit test
 * without a daemon. The order is the contract and is load-bearing:
 *
 *   0. closed                   -> terminal, no delivery row at all
 *   1. dead                     -> resume request, reason endpoint_dead
 *   2. exact listener held open -> stage a presentation, done
 *   3. non-interactive + idle   -> resume request, reason endpoint_idle
 *   4. interactive/unknown idle, busy, retiring, or dead custody -> enqueue
 *                                  unread work until an exact current listener
 *                                  receives it or a terminated-retirement
 *                                  successor is authorized
 *
 * The terminal-process test outranks the live-listener test, which is
 * where this diverges from the source. Helm's live-delivery probe is per
 * SESSION, so there a dead session cannot be the live listener and the
 * listener-first order is safe. Tightbeam's observer bus is keyed by
 * PRINCIPAL while every routing consequence is per ENDPOINT, so an observer
 * — or one sibling session — cannot suppress the
 * resume of a provably-gone process. Routing creates the durable request, but
 * the resumer decides whether it can launch: interactive or unknown custody
 * remains unclaimed until exact terminated-retirement proof authorizes one
 * successor. The dead process cannot receive unread work.
 *
 * A generic principal subscription is deliberately absent from this input.
 * Only a listener fenced to the endpoint's current process generation and
 * provider session is evidence that this exact process can receive a staged
 * presentation. Interactive and unknown idle endpoints therefore enqueue
 * until a listener is observed rather than creating a second owner.
 *
 * An unrecognised state routes to `enqueue_only`, the one outcome that
 * cannot spawn a second process on top of a session that may still be
 * alive. The durable delivery row is written either way, so the message
 * is never lost — only its wake-up is withheld.
 */
export function routeDelivery({ endpointState, launchMode = null, hasExactListener = false }) {
  if (endpointState === 'closed') return 'skip';
  // A takeover has rotated authority but no successor generation exists yet.
  // Persist unread work without presenting or spawning beside that handoff.
  if (endpointState === 'takeover_pending') return 'enqueue_only';
  if (endpointState === 'dead') return 'resume_dead';
  if (hasExactListener && endpointState === 'idle') return 'stage_presentation';
  if (endpointState === 'idle' && launchMode === 'non_interactive') return 'resume_idle';
  return 'enqueue_only';
}

// Cases 1 and 2 both produce a resume request and are distinguished only
// by this column, matching Helm's distinct resumed_pid_dead /
// resume_alive_idle decisions.
const RESUME_REASON_BY_ROUTE = { resume_dead: 'endpoint_dead', resume_idle: 'endpoint_idle' };

/**
 * Refreshes the legacy per-session inbox watermark
 * (`<state-root>/sessions/<session_id>/inbox.watermark`,
 * src/protocol/session_paths.mjs) as a compatibility-only best-effort
 * notification. It is not an admission or read signal; current receipt is
 * authorized by an exact listener presentation or a fenced successor.
 *
 * Deliberately best-effort and deliberately OUTSIDE the durability
 * contract: the delivery row is authoritative and this file is a hint, so
 * a full disk, a read-only state root, or a session directory someone
 * deleted must never fail or roll back a message.commit. A lost watermark
 * costs a legacy notice, not unread durability or exact receipt authority.
 * The converse also holds: this runs inside the caller's write transaction,
 * so a rolled-back commit can leave a bumped compatibility marker.
 */
export function refreshSessionWatermark({ stateRoot, sessionId, deliveryId, wake = null, logger }) {
  if (!stateRoot || !isSafeSessionId(sessionId)) return;
  try {
    const paths = sessionPaths(stateRoot, sessionId);
    fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    const marker = wake === null ? { delivery_id: deliveryId, updated_at: new Date().toISOString() } : { delivery_id: deliveryId, wake };
    fs.writeFileSync(paths.watermark, `${JSON.stringify(marker)}\n`, {
      mode: 0o600,
    });
  } catch (err) {
    logger?.warn({ event: 'session_watermark_write_failed', session_id: sessionId, delivery_id: deliveryId, error: err.message });
  }
}

/**
 * Refreshes the watermark of a session that has just BECOME the endpoint
 * behind an existing delivery row, from that row.
 *
 * Case D(b) writes its delivery while the placeholder endpoint has a NULL
 * `provider_session_id`: there is no session, so there is no session
 * directory and refreshSessionWatermark above returns without writing.
 * Adoption (ops/endpoint_register.mjs) is the moment a session id exists
 * for that row, so this preserves the legacy marker for compatibility
 * observers. It does not admit or read the delivery: a current exact
 * listener must receive it, or a fenced terminated-retirement successor may
 * receive it after launch. A delivery row is not a delivery.
 *
 * Newest unread row, because the watermark remains a compatibility
 * "something is waiting" hint only. It never enumerates, admits, or reads
 * the row. Returns the delivery id it pointed at, or null when there is
 * nothing waiting.
 */
export function refreshWatermarkForAdoptedSession(db, { stateRoot, endpointId, sessionId, logger }) {
  if (!stateRoot || !isSafeSessionId(sessionId)) return null;
  const delivery = db
    .prepare(
      `SELECT id FROM deliveries
        WHERE endpoint_id = ? AND read_at IS NULL AND state != 'failed'
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
    )
    .get(endpointId);
  if (!delivery) return null;
  refreshSessionWatermark({ stateRoot, sessionId, deliveryId: delivery.id, logger });
  return delivery.id;
}

// ---------------------------------------------------------------------
// Recipient endpoint selection (item 44).
//
// A delivery that answers work opened by one endpoint belongs to THAT
// endpoint; a message merely addressed to a principal may wake at most one of
// its endpoints. Before item 44 every non-closed endpoint of every recipient
// principal got a row and every idle non_interactive one got its own resume
// request, so one reply to an interactive requester resumed ~20 stale
// `claude -p` sessions of the requester's principal.

/**
 * Default staleness window for resume candidates: an endpoint that has a
 * provider session and no recorded activity for longer than this is never
 * resumed by principal-addressed or reply routing. Seven days: long enough
 * that a session idling over a weekend is still woken, short enough that a
 * month-old `claude -p` transcript is not revived to replay an old task.
 */
export const DEFAULT_RESUME_STALE_AFTER_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_RESUME_STALE_AFTER_MS = DEFAULT_RESUME_STALE_AFTER_DAYS * DAY_MS;

/**
 * `TIGHTBEAM_RESUME_STALE_AFTER_DAYS` is a window parameter, like
 * TIGHTBEAM_RESUME_LEASE_MS, not a mode: a positive integer number of days.
 * Anything else falls back to the default; nothing disables the filter.
 */
export function resolveResumeStaleAfterMs(env = process.env) {
  const raw = typeof env?.TIGHTBEAM_RESUME_STALE_AFTER_DAYS === 'string' ? env.TIGHTBEAM_RESUME_STALE_AFTER_DAYS.trim() : '';
  if (!/^[1-9][0-9]{0,4}$/.test(raw)) return DEFAULT_RESUME_STALE_AFTER_MS;
  return Number.parseInt(raw, 10) * DAY_MS;
}

const RESUME_DECISION_LOG_LIMIT = 25;

function timestampMs(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/**
 * The endpoint's last recorded activity: `endpoints.updated_at`, which the
 * lifecycle hook transitions (SessionStart/UserPromptSubmit/Stop), listener
 * attach, registration and replay, and supervised death all bump. A reply
 * binding may contribute its own anchor — when the bound endpoint sent the
 * message being answered — because sending is activity the endpoint row does
 * not record.
 */
function lastActivityMs(endpoint, anchorAt = null) {
  return Math.max(timestampMs(endpoint.updated_at), timestampMs(endpoint.created_at), timestampMs(anchorAt));
}

/**
 * Stale: the endpoint has a provider session to resume and no activity
 * within the window. A sessionless placeholder (Case D(b)) is a cold spawn,
 * not the revival of an old transcript, so age alone never makes it stale.
 */
function isStaleResumeTarget(endpoint, { nowMs, staleAfterMs, anchorAt = null }) {
  if (typeof endpoint.session_id !== 'string' || endpoint.session_id.length === 0) return false;
  return nowMs - lastActivityMs(endpoint, anchorAt) > staleAfterMs;
}

/**
 * Chooses which of ONE recipient principal's open endpoints get a delivery
 * row and which one, at most, gets a resume request. Pure over its inputs.
 *
 *   exact         the caller already narrowed routing to one endpoint (a
 *                 child result to its parent custodian, an inbound target).
 *                 Custody is the proof of relevance, so age is not checked.
 *   targeted      an `open` names the endpoint that takes custody. Every open
 *                 endpoint of the principal keeps its row (F19: each window
 *                 of a shared principal holds its own copy), but only the
 *                 target may be resumed; siblings are never woken.
 *   bound         the message answers a message or work this principal
 *                 opened from `binding.endpoint_id` (reply, requester return
 *                 route). Only that endpoint gets a row. It is
 *                 resumed only when its own route says so (idle
 *                 non_interactive, or dead) and it is not stale, with
 *                 activity anchored at `binding.anchor_at` when given. An
 *                 interactive or unknown requester keeps the row unread and
 *                 nothing else is woken.
 *   bound_closed  the bound endpoint is closed. Rows go to the principal's
 *                 open endpoints so the message stays in the inbox, and
 *                 nothing is resumed: no sibling inherits another session's
 *                 reply.
 *   principal     no binding. Every open endpoint keeps its row (inbox
 *                 visibility unchanged) and at most one is resumed: the most
 *                 recently active eligible endpoint — route resume_idle or
 *                 resume_dead, and not stale — ties broken by newest
 *                 created_at, then endpoint id. None at all when one of the
 *                 principal's endpoints was staged a live presentation.
 */
export function selectRecipientEndpoints({ endpoints, routes, binding = null, nowMs, staleAfterMs }) {
  const decisions = [];
  const wantsResume = (endpoint) => Boolean(RESUME_REASON_BY_ROUTE[routes.get(endpoint.id)]);
  let mode = 'principal';
  let rowEndpoints = endpoints;
  let resumeScope = endpoints;
  if (binding?.kind === 'exact') {
    mode = 'exact';
  } else if (binding?.endpoint_id) {
    const bound = endpoints.find((endpoint) => endpoint.id === binding.endpoint_id);
    if (!bound) {
      mode = 'bound_closed';
    } else {
      // `targeted` keeps the principal-wide rows (F19: every window of a
      // shared principal keeps its own copy) and restricts only the wake;
      // `bound` restricts both.
      mode = binding.rows === 'principal' ? 'targeted' : 'bound';
      if (mode === 'bound') rowEndpoints = [bound];
      resumeScope = [bound];
      for (const endpoint of endpoints) {
        if (endpoint.id !== bound.id) decisions.push({ endpoint_id: endpoint.id, route: routes.get(endpoint.id), decision: 'not_bound' });
      }
    }
  }

  let resumeEndpointId = null;
  if (mode === 'exact' || mode === 'bound' || mode === 'targeted') {
    for (const endpoint of mode === 'exact' ? rowEndpoints : resumeScope) {
      const route = routes.get(endpoint.id);
      if (!wantsResume(endpoint)) {
        decisions.push({ endpoint_id: endpoint.id, route, decision: 'no_resume_route' });
      } else if (mode !== 'exact' && isStaleResumeTarget(endpoint, { nowMs, staleAfterMs, anchorAt: binding.anchor_at ?? null })) {
        decisions.push({ endpoint_id: endpoint.id, route, decision: 'stale' });
      } else if (resumeEndpointId === null) {
        resumeEndpointId = endpoint.id;
        decisions.push({ endpoint_id: endpoint.id, route, decision: 'resume' });
      }
    }
  } else if (mode === 'bound_closed') {
    for (const endpoint of rowEndpoints) decisions.push({ endpoint_id: endpoint.id, route: routes.get(endpoint.id), decision: 'bound_endpoint_closed' });
  } else {
    const presented = rowEndpoints.some((endpoint) => routes.get(endpoint.id) === 'stage_presentation');
    const candidates = [];
    for (const endpoint of rowEndpoints) {
      const route = routes.get(endpoint.id);
      if (!wantsResume(endpoint)) {
        decisions.push({ endpoint_id: endpoint.id, route, decision: route === 'stage_presentation' ? 'live_presentation' : 'no_resume_route' });
      } else if (presented) {
        decisions.push({ endpoint_id: endpoint.id, route, decision: 'presented_elsewhere' });
      } else if (isStaleResumeTarget(endpoint, { nowMs, staleAfterMs })) {
        decisions.push({ endpoint_id: endpoint.id, route, decision: 'stale' });
      } else {
        candidates.push(endpoint);
      }
    }
    candidates.sort((a, b) =>
      lastActivityMs(b) - lastActivityMs(a)
      || timestampMs(b.created_at) - timestampMs(a.created_at)
      || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    candidates.forEach((endpoint, index) => {
      if (index === 0) resumeEndpointId = endpoint.id;
      decisions.push({ endpoint_id: endpoint.id, route: routes.get(endpoint.id), decision: index === 0 ? 'resume_most_recent' : 'not_most_recent' });
    });
  }
  return { mode, rowEndpointIds: new Set(rowEndpoints.map((endpoint) => endpoint.id)), resumeEndpointId, decisions };
}

/**
 * One boundary log per recipient principal per message — never per endpoint
 * — recording why each endpoint was or was not chosen to wake.
 */
function logResumeSelection(logger, { messageId, principalId, binding, endpoints, selection, resumeStaleAfterMs }) {
  if (!logger?.info) return;
  const counts = {};
  for (const entry of selection.decisions) counts[entry.decision] = (counts[entry.decision] ?? 0) + 1;
  logger.info({
    event: 'recipient_resume_selection',
    params: {
      message_id: messageId,
      principal_id: principalId,
      mode: selection.mode,
      binding_source: binding?.source ?? null,
      bound_endpoint_id: binding?.endpoint_id ?? null,
      endpoint_count: endpoints.length,
      stale_after_days: resumeStaleAfterMs / DAY_MS,
    },
    result: {
      delivery_rows: selection.rowEndpointIds.size,
      resume_endpoint_id: selection.resumeEndpointId,
      decision_counts: counts,
      decisions: selection.decisions.slice(0, RESUME_DECISION_LOG_LIMIT),
      decisions_truncated: selection.decisions.length > RESUME_DECISION_LOG_LIMIT,
    },
    status: 'ok',
  });
}

/**
 * Creates the durable delivery rows for the conversation participants other
 * than the sender (docs/state-ownership.md §6; the plan's «Agent-to-agent
 * message flow» step 4: canonical message + per-endpoint delivery record
 * written in one transaction, before any live-notification/claim work — see
 * the internal provenance record, adapted from Helm kernel.mjs's
 * persist-before-transport ordering), routes each endpoint through
 * routeDelivery above, and applies selectRecipientEndpoints per principal: a
 * bound delivery reaches only its bound endpoint, and a principal-addressed
 * one wakes at most one endpoint.
 *
 * `endpointBindings` maps a recipient principal id to
 * `{ endpoint_id, source, anchor_at }` (lifecycle_transition.mjs
 * resolveEndpointBindings). `recipientEndpointId` is the caller's exact
 * narrowing and outranks any binding.
 *
 * The durable delivery row is written for every routing outcome, the
 * staged one included: only the durable staging happens here, inside the
 * transaction. The listener frame itself is published by the caller after
 * commit, so no push failure can roll back a write.
 *
 * `eventBus` is optional — a context built without one (unit fixtures,
 * and any future caller that has no live-notification surface) simply has
 * no live listeners.
 *
 * `routeReasonPrincipalId` narrows a typed route to one participant: every
 * recipient still gets a delivery row, but only that principal's endpoints
 * carry the reason/source pair.
 */
export function createDeliveriesForRecipients(db, { conversationId, messageId, senderPrincipalId, recipientEndpointId = null, routeReason = null, sourceObligationId = null, routeReasonPrincipalId = null, endpointBindings = null, resumeStaleAfterMs = DEFAULT_RESUME_STALE_AFTER_MS, stateRoot, logger }) {
  const recipientEndpoints = db
    .prepare(
      `SELECT e.id AS id, e.state AS state, e.principal_id AS principal_id,
              e.provider_session_id AS session_id, e.process_generation AS process_generation,
              e.launch_mode AS launch_mode, e.authority_reference AS authority_reference,
              e.created_at AS created_at, e.updated_at AS updated_at
         FROM endpoints e
         JOIN conversation_participants cp ON cp.principal_id = e.principal_id
        WHERE cp.conversation_id = ?
          AND cp.principal_id != ?
          AND (? IS NULL OR e.id = ?)
          AND e.state != 'closed'
        ORDER BY e.principal_id, e.created_at, e.id`,
    )
    .all(conversationId, senderPrincipalId, recipientEndpointId, recipientEndpointId);

  const listeners = new Map();
  const routes = new Map();
  const byPrincipal = new Map();
  for (const endpoint of recipientEndpoints) {
    const listener = activeListenerForEndpoint(db, {
      endpointId: endpoint.id,
      processGeneration: endpoint.process_generation,
      providerSessionId: endpoint.session_id,
    });
    listeners.set(endpoint.id, listener);
    routes.set(endpoint.id, routeDelivery({
      endpointState: endpoint.state,
      launchMode: endpoint.launch_mode,
      hasExactListener: Boolean(listener),
    }));
    if (!byPrincipal.has(endpoint.principal_id)) byPrincipal.set(endpoint.principal_id, []);
    byPrincipal.get(endpoint.principal_id).push(endpoint);
  }

  const nowMs = Date.now();
  const rowEndpointIds = new Set();
  const resumeEndpointIds = new Set();
  for (const [principalId, endpoints] of byPrincipal) {
    const binding = recipientEndpointId !== null
      ? { kind: 'exact', source: 'caller_exact' }
      : endpointBindings?.get(principalId) ?? null;
    const selection = selectRecipientEndpoints({ endpoints, routes, binding, nowMs, staleAfterMs: resumeStaleAfterMs });
    for (const id of selection.rowEndpointIds) rowEndpointIds.add(id);
    if (selection.resumeEndpointId !== null) resumeEndpointIds.add(selection.resumeEndpointId);
    logResumeSelection(logger, { messageId, principalId, binding, endpoints, selection, resumeStaleAfterMs });
  }

  // Typed routes carry reason and source obligation together or not at all
  // (schema CHECK); ordinary participant fan-out leaves both NULL. When the
  // caller names a routeReasonPrincipalId, ONLY that principal's endpoints
  // are typed: a delivery-confirmed report reaches every participant, but
  // only the requester's return route may confirm it (INV-07). No named
  // principal means no typed row at all, which fails closed by design.
  const now = new Date().toISOString();
  const insert = db.prepare(
    "INSERT INTO deliveries (id, message_id, endpoint_id, state, route_reason, source_obligation_id, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)",
  );
  const liveDeliveries = [];
  const presentations = [];
  for (const endpoint of recipientEndpoints) {
    if (!rowEndpointIds.has(endpoint.id)) continue;
    const route = routes.get(endpoint.id);
    if (route === 'skip') continue;
    const listener = listeners.get(endpoint.id);

    const deliveryId = generateId('delivery');
    const typed = routeReason !== null && endpoint.principal_id === routeReasonPrincipalId;
    insert.run(deliveryId, messageId, endpoint.id, typed ? routeReason : null, typed ? sourceObligationId : null, now, now);
    liveDeliveries.push({ principal_id: endpoint.principal_id, endpoint_id: endpoint.id, message_id: messageId });
    if (route === 'stage_presentation') {
      presentations.push(createPendingPresentation(db, { listener, messageId, deliveryId }));
      db.prepare("UPDATE listeners SET state = 'waking', updated_at = ? WHERE id = ? AND listener_generation = ? AND state IN ('parked', 'attached')")
        .run(now, listener.id, listener.listener_generation);
    } else if (RESUME_REASON_BY_ROUTE[route] && resumeEndpointIds.has(endpoint.id)) {
      maybeCreateResumeRequest(db, { endpoint, conversationId, messageId, reason: RESUME_REASON_BY_ROUTE[route] });
    }
    // 'enqueue_only', or a resume route that selection declined: the pending
    // delivery row is the whole outcome. It stays unread until exact receipt
    // by the current listener or a permitted terminated-retirement
    // successor; no tool-boundary hook reads it.

    // Every route that wrote a row refreshes the legacy compatibility marker.
    // It never substitutes for exact presentation, admission, or receipt.
    refreshSessionWatermark({ stateRoot, sessionId: endpoint.session_id, deliveryId, logger });
  }
  return { liveDeliveries, presentations };
}

/**
 * Creates ordinary delivery rows for routes that were already resolved by
 * message.commit's transaction. Channel routes are deliberately not
 * conversation participants: the route descriptor names the integration
 * endpoint that owns transport, while the conversation remains agent-owned.
 */
export function createDeliveriesForChannelRoutes(db, {
  conversationId,
  messageId,
  routes,
  replyTargetEndpointId = null,
  replyTargetMustBeSender = true,
  routeReason = null,
  sourceObligationId = null,
}) {
  const now = new Date().toISOString();
  const insert = db.prepare(
    "INSERT INTO deliveries (id, message_id, endpoint_id, state, route_reason, source_obligation_id, channel_route_id, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)",
  );
  // An agent's own message binds replies back to one of the sender's own
  // endpoints. A Tightbeam-authored notice has no agent sender, so its
  // caller names the open agent endpoint explicitly
  // (replyTargetMustBeSender: false); channel.reply.publish still enforces
  // conversation participation when a reply arrives.
  let replyTarget = null;
  if (typeof replyTargetEndpointId === 'string') {
    replyTarget = replyTargetMustBeSender
      ? db
          .prepare(
            `SELECT e.id, e.provider_session_id, e.process_generation
               FROM endpoints e
               JOIN messages m ON m.id = ?
              WHERE e.id = ? AND e.principal_id = m.sender_principal_id`,
          )
          .get(messageId, replyTargetEndpointId)
      : db
          .prepare("SELECT e.id, e.provider_session_id, e.process_generation FROM endpoints e WHERE e.id = ? AND e.state != 'closed'")
          .get(replyTargetEndpointId);
  }
  const insertReplyBinding = db.prepare(
    `INSERT INTO reply_bindings
      (id, app_id, channel_route_id, conversation_id, source_message_id, source_delivery_id, target_endpoint_id,
       source_provider_session_id, source_process_generation, created_at, expires_at, state, retired_at, retired_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL)`,
  );
  const liveDeliveries = [];
  for (const routeRecord of routes) {
    // A channel route is a transport adapter, not an agent session. Its
    // canonical delivery row is claimed exclusively by delivery.claim, so it
    // must never enter the session resume/watermark lifecycle.
    if (routeRecord.endpoint_state === 'closed') continue;

    const deliveryId = generateId('delivery');
    insert.run(deliveryId, messageId, routeRecord.endpoint_id, routeReason, sourceObligationId, routeRecord.id, now, now);
    liveDeliveries.push({ principal_id: routeRecord.principal_id, endpoint_id: routeRecord.endpoint_id, message_id: messageId });
    let capabilities = [];
    try {
      capabilities = JSON.parse(routeRecord.capabilities);
    } catch {
      // Route selection has already validated the persisted descriptor. A
      // corrupt descriptor must fail closed by withholding reply authority.
    }
    if (replyTarget && capabilities.includes('reply')) {
      insertReplyBinding.run(
        generateId('reply_binding'),
        routeRecord.app_id,
        routeRecord.id,
        conversationId,
        messageId,
        deliveryId,
        replyTarget.id,
        replyTarget.provider_session_id,
        replyTarget.process_generation,
        now,
        new Date(Date.parse(now) + REPLY_BINDING_POLICY.bindingLifetimeMs).toISOString(),
      );
    }
  }
  return { liveDeliveries };
}

/**
 * Routes a managed child result through the ordinary durable delivery and
 * resume path, but only to the child obligation's immediate parent endpoint.
 *
 * Strict by default: a CHILD-RESULT wake whose parent endpoint cannot be
 * found (closed, gone, or outside the conversation) fails the whole commit,
 * because an unreported terminal result is exactly what INV-11 forbids.
 * Callers that mirror ENDPOINT-DEATH's
 * create_one_parent_custody_loss_delivery_if_parent_exists semantics —
 * where the custody decision must commit even though its parent can never
 * receive a wake — pass ifParentExists and get an empty routing instead of a
 * throw.
 */
export function createParentResultDelivery(db, { conversationId, messageId, senderPrincipalId, parentEndpointId, routeReason = null, sourceObligationId = null, stateRoot, logger, ifParentExists = false }) {
  const routable = db
    .prepare(
      `SELECT e.id, e.principal_id AS principal_id
         FROM endpoints AS e
         JOIN conversation_participants AS cp ON cp.principal_id = e.principal_id
        WHERE e.id = ?
          AND cp.conversation_id = ?
          AND e.principal_id != ?
          AND e.state != 'closed'`,
    )
    .get(parentEndpointId ?? null, conversationId, senderPrincipalId);
  if (!routable) {
    if (ifParentExists) return { liveDeliveries: [] };
    throw new TightbeamError('obligation_conflict', 'the immediate parent endpoint is no longer routable for this child result');
  }
  return createDeliveriesForRecipients(db, {
    conversationId,
    messageId,
    senderPrincipalId,
    recipientEndpointId: parentEndpointId,
    routeReason,
    sourceObligationId,
    // Already narrowed to this one endpoint above; naming its principal
    // keeps the "a typed route always names its intended recipient" rule
    // uniform across every typed writer.
    routeReasonPrincipalId: routable.principal_id,
    stateRoot,
    logger,
  });
}

/**
 * Post-commit fan-out (ws-9, docs/protocol.md "Live notification and
 * event frames"): pushes one inbox.delivery event per live delivery
 * collected by createDeliveriesForRecipients. Always called AFTER the
 * write transaction has committed, never from inside it — a push
 * failure must never roll back a durable write. context.eventBus may be
 * absent (e.g. a unit-test context built without one); this is then a
 * silent no-op, matching "durable state is authoritative, events are
 * best-effort."
 */
export function pushLiveDeliveryEvents(context, { conversationId, liveDeliveries }) {
  if (!context.eventBus || !liveDeliveries) return;
  for (const delivery of liveDeliveries) {
    context.eventBus.publish(
      delivery.principal_id,
      'inbox.delivery',
      {
        message_id: delivery.message_id,
        conversation_id: conversationId,
        principal_id: delivery.principal_id,
        endpoint_id: delivery.endpoint_id,
        delivery_state: 'pending',
      },
      context.logger,
    );
  }
}

/**
 * Inserts the canonical message row. `origin` is the author-origin axis
 * resolved from the caller's grant path (resolveSendBranch) and stored on
 * the row; the column's CHECK fails closed if anything outside
 * ('agent','inbound') is ever passed. Callers wrap this in withTransaction
 * alongside conversation resolution and delivery fan-out so a UNIQUE
 * (app_id, idempotency_key) violation rolls back every write in this
 * request, not just the message row (the state ownership contract §5;
 * the internal provenance record's Helm kernel.mjs idempotency-hit-suppression adaptation).
 */
export function insertMessage(db, { conversationId, appId, senderPrincipalId, kind, body, metadata, idempotencyKey, hash, origin, originChannelRouteId = null, inReplyToMessageId = null }) {
  const messageId = generateId('message');
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO messages
      (id, conversation_id, app_id, sender_principal_id, kind, body, metadata, idempotency_key, payload_hash, created_at, origin, origin_channel_route_id, in_reply_to_message_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(messageId, conversationId, appId, senderPrincipalId, kind, body, JSON.stringify(metadata ?? {}), idempotencyKey, hash, now, origin, originChannelRouteId, inReplyToMessageId);
  return messageId;
}

/**
 * Runs writeFn() inside the caller's transaction; on a UNIQUE(app_id,
 * idempotency_key) violation, reads the conflicting row back (outside any
 * transaction — the failed attempt has already rolled back) and resolves
 * idempotent replay vs. collision by comparing payload_hash. Never a
 * pre-check-then-insert race: the insert is always attempted first.
 */
export function withIdempotency(db, { appId, idempotencyKey, hash }, writeFn) {
  try {
    return { ...writeFn(), idempotent_replay: false };
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    const existing = db
      .prepare('SELECT id, conversation_id, payload_hash FROM messages WHERE app_id = ? AND idempotency_key = ?')
      .get(appId, idempotencyKey);
    if (existing && existing.payload_hash === hash) {
      return { message_id: existing.id, conversation_id: existing.conversation_id, idempotent_replay: true };
    }
    throw new TightbeamError('idempotency_collision', `idempotency_key "${idempotencyKey}" was already used with a different payload`, {
      field: 'idempotency_key',
    });
  }
}

export function validateMetadata(metadata) {
  if (metadata !== undefined && (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata))) {
    throw new TightbeamError('malformed_request', 'metadata must be an object when present', { field: 'metadata' });
  }
}

export function validateIdempotencyKey(idempotencyKey) {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
    throw new TightbeamError('malformed_request', 'idempotency_key is required and must be a non-empty string', { field: 'idempotency_key' });
  }
}

// 256 KiB cap on a message body, UTF-8 byte length (F1: an oversized
// canonical message could otherwise produce an inbox.list/message.read
// result too large to encode as a single frame — see server.mjs safeWrite
// and inbox_list.mjs's own byte budget for the read-side half of this
// fix).
export const MAX_BODY_BYTES = 262144;

export function validateBody(body) {
  if (typeof body !== 'string') {
    throw new TightbeamError('malformed_request', 'body is required and must be a string', { field: 'body' });
  }
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    throw new TightbeamError('malformed_request', `body exceeds ${MAX_BODY_BYTES} bytes`, { field: 'body' });
  }
}
