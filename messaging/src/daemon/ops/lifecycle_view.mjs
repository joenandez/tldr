// lifecycle.view — the forward derived projection (Project Relay parent
// 4.2, subtask 4.2.1; plan «Technical Approach 6» and REQ-09). The read
// side of delivery truth: it joins the canonical obligation graph with
// handoff watches, typed deliveries, endpoint rows, and root attention and
// derives, AT READ TIME ONLY, the five core labels — working,
// awaiting_acceptance, delegated, needs_attention, done. There is no stored
// combined status anywhere (the obligations `status` open|closed column is
// canonical work truth, not a presentation label), no listener input (none
// exists), and no acknowledgement deadline: read and acknowledged evidence
// never changes a label.
//
// Derivation precedence per chain, from canonical records alone:
//
//   done               the root closed — its immutable resolution is the truth;
//   needs_attention    a root_attention row stands (Stop-block escape,
//                      endpoint.custody_lost, delivery.failed), or an OPEN
//                      root holds neither exact custody nor an armed watch
//                      nor recovery state — fail visible rather than silent;
//   awaiting_acceptance  an offered delegation sits behind its durable watch;
//   delegated          accepted child custody binds the work;
//   working            an open attempt/delegation in exact custody.
//
// Attention outranks custody on purpose: a staged resolution whose report
// delivery failed is still fully owned work, but it is exactly the shape an
// operator must see. Reading writes nothing and schedules nothing.

import { TightbeamError } from '../../protocol/envelope.mjs';
import { rootCompletionMode } from '../lifecycle_transition.mjs';

const VIEW_FIELDS = ['conversation_id', 'root_obligation_id'];

function validateViewRequest(payload) {
  const request = payload ?? {};
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TightbeamError('malformed_request', 'request is required and must be an object');
  }
  for (const key of Object.keys(request)) {
    if (!VIEW_FIELDS.includes(key)) {
      throw new TightbeamError('malformed_request', `lifecycle.view declares "${key}", which is not part of its request contract`, { field: key });
    }
  }
  for (const field of VIEW_FIELDS) {
    const value = request[field];
    if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
      throw new TightbeamError('malformed_request', `${field} must be a non-empty string when present`, { field });
    }
  }
  return request;
}

function chainNodes(db, rootId) {
  return db
    .prepare(
      `WITH RECURSIVE chain(id) AS (
         SELECT id FROM obligations WHERE id = ?
         UNION ALL
         SELECT o.id FROM obligations o JOIN chain c ON o.parent_id = c.id
       )
       SELECT o.*, e.state AS endpoint_state
         FROM obligations o LEFT JOIN endpoints e ON e.id = o.custodian_endpoint_id
        WHERE o.id IN chain
        ORDER BY o.created_at ASC, o.id ASC`,
    )
    .all(rootId);
}

function chainWatches(db, rootId) {
  return db
    .prepare(
      `WITH RECURSIVE chain(id) AS (
         SELECT id FROM obligations WHERE id = ?
         UNION ALL
         SELECT o.id FROM obligations o JOIN chain c ON o.parent_id = c.id
       )
       SELECT w.* FROM handoff_watches w WHERE w.delegation_id IN chain ORDER BY w.created_at ASC, w.id ASC`,
    )
    .all(rootId);
}

function conversationSubject(db, conversationId) {
  const row = db.prepare('SELECT metadata FROM conversations WHERE id = ?').get(conversationId);
  try {
    const subject = JSON.parse(row?.metadata ?? '{}')?.subject;
    return typeof subject === 'string' && subject.trim().length > 0 ? subject : null;
  } catch {
    return null;
  }
}

function userOriginMessageId(db, rootId) {
  return db
    .prepare(
      `SELECT m.id
         FROM message_effects me
         JOIN messages m ON m.id = me.message_id
        WHERE me.effect = 'open' AND me.obligation_id = ?
          AND m.origin_channel_route_id IS NOT NULL`,
    )
    .get(rootId)?.id ?? null;
}

/**
 * The ACTIVE staged terminal resolution for this root, if any: the typed
 * close.delivery_confirmed deliveries still pending or claimed, with the
 terminal effect and outcome their audit declared. Typing is recipient-exact, so
 * this is the one return route to the principal that opened the work; other
 * participants' copies of the same report are ordinary deliveries and are
 * never presented as a pending confirmation. Failed candidates stay as audit
 * rows in the graph but drop out of here — they are history, not a pending
 * confirmation (LC-D05).
 */
function activeStagedResolution(db, rootId) {
  const rows = db
    .prepare(
      `SELECT d.id AS delivery_id, d.endpoint_id AS endpoint_id, d.message_id AS message_id, d.state AS state, me.effect AS effect, me.effect_payload AS effect_payload
         FROM deliveries d
         JOIN message_effects me ON me.message_id = d.message_id AND me.effect IN ('close.fulfilled', 'close.cancelled') AND me.obligation_id = ?
        WHERE d.route_reason = 'close.delivery_confirmed' AND d.source_obligation_id = ?
          AND d.state IN ('pending', 'claimed')
        ORDER BY d.created_at ASC, d.id ASC`,
    )
    .all(rootId, rootId);
  if (rows.length === 0) return null;
  let outcome = null;
  try {
    outcome = JSON.parse(rows[0]?.effect_payload)?.declaration?.outcome ?? null;
  } catch {
    outcome = null;
  }
  return {
    message_id: rows[0].message_id,
    terminal_effect: rows[0].effect,
    outcome,
    deliveries: rows.map((row) => ({ delivery_id: row.delivery_id, endpoint_id: row.endpoint_id, state: row.state })),
  };
}

function notificationProjection(db, rootId) {
  const opening = db
    .prepare(
      `SELECT m.metadata
         FROM message_effects me JOIN messages m ON m.id = me.message_id
        WHERE me.effect = 'open' AND me.obligation_id = ?`,
    )
    .get(rootId);
  let channelSelectors = null;
  try {
    const value = JSON.parse(opening?.metadata)?.tightbeam_agent?.notification_channels;
    if (Array.isArray(value) && value.length > 0 && value.every((selector) => typeof selector === 'string' && selector.length > 0)) {
      channelSelectors = value;
    }
  } catch {
    channelSelectors = null;
  }
  if (!channelSelectors) return null;
  const resolution = db
    .prepare(
      `SELECT me.message_id
         FROM message_effects me
         JOIN deliveries d ON d.message_id = me.message_id
        WHERE me.effect = 'close.fulfilled' AND me.obligation_id = ?
          AND d.route_reason = 'close.delivery_confirmed' AND d.source_obligation_id = ?
        ORDER BY d.created_at DESC, d.id DESC LIMIT 1`,
    )
    .get(rootId, rootId);
  return { channel_selectors: channelSelectors, ...(resolution ? { message_id: resolution.message_id } : {}) };
}

function deriveChainLabel({ root, nodes, watches, attention }) {
  if (root.status === 'closed') return 'done';
  if (attention) return 'needs_attention';
  const watchStateByDelegation = new Map(watches.map((watch) => [watch.delegation_id, watch.state]));
  const openDelegations = nodes.filter((node) => node.role === 'delegation' && node.status === 'open');
  if (openDelegations.some((delegation) => delegation.custodian_endpoint_id === null && watchStateByDelegation.get(delegation.id) === 'awaiting_acceptance')) {
    return 'awaiting_acceptance';
  }
  if (openDelegations.some((delegation) => delegation.custodian_endpoint_id !== null)) return 'delegated';
  if (nodes.some((node) => node.status === 'open' && node.custodian_endpoint_id !== null)) return 'working';
  // An open root with neither exact custody, nor an armed acceptance watch,
  // nor attention/recovery evidence is the one unsafe gap the contract
  // forbids; surfacing it as needs_attention keeps it impossible to lose.
  return 'needs_attention';
}

function projectionForRoot(db, root) {
  const nodes = chainNodes(db, root.id);
  const watches = chainWatches(db, root.id);
  const attention = db.prepare('SELECT attention_source, stop_block_count, first_marked_at, last_block_at FROM root_attention WHERE root_obligation_id = ?').get(root.id) ?? null;

  const attempts = nodes
    .filter((node) => node.role === 'attempt')
    .map((node) => ({
      obligation_id: node.id,
      generation: node.generation,
      status: node.status,
      custodian_endpoint_id: node.custodian_endpoint_id,
      endpoint_state: node.endpoint_state,
      resolution: node.resolution,
      resolution_outcome: node.resolution_outcome,
    }));
  const delegations = nodes
    .filter((node) => node.role === 'delegation')
    .map((node) => ({
      obligation_id: node.id,
      generation: node.generation,
      status: node.status,
      custodian_endpoint_id: node.custodian_endpoint_id,
      accountable_principal_id: node.accountable_principal_id,
      endpoint_state: node.endpoint_state,
      watch_state: watches.find((watch) => watch.delegation_id === node.id)?.state ?? null,
      watch_outcome: watches.find((watch) => watch.delegation_id === node.id)?.outcome ?? null,
    }));

  return {
    root_obligation_id: root.id,
    conversation_id: root.conversation_id,
    subject: conversationSubject(db, root.conversation_id),
    user_origin_message_id: userOriginMessageId(db, root.id),
    generation: root.generation,
    completion_mode: rootCompletionMode(db, root.id),
    status: deriveChainLabel({ root, nodes, watches, attention }),
    accountable_principal_id: root.accountable_principal_id,
    first_progress_message_id: root.first_progress_message_id,
    first_progress_at: root.first_progress_at,
    ack_due_at: root.ack_due_at,
    ack_message_id: root.ack_message_id,
    ack_delivery_id: root.ack_delivery_id,
    ack_accepted_at: root.ack_accepted_at,
    created_at: root.created_at,
    updated_at: root.updated_at,
    resolution:
      root.status === 'closed'
        ? {
            resolution: root.resolution,
            message_id: root.resolution_message_id,
            outcome: root.resolution_outcome,
            reason: root.resolution_reason,
            source: root.resolution_source,
            replacement_id: root.resolution_replacement_id,
          }
        : null,
    attempts,
    delegations,
    // Staged resolution is a PENDING-confirmation presentation, so it exists
    // only while the root can still receive one. A closed root (including a
    // close.cancelled withdrawal over a stale candidate) keeps its audit
    // rows as history; its immutable `resolution` above is the truth.
    staged_resolution: root.status === 'open' ? activeStagedResolution(db, root.id) : null,
    notification: notificationProjection(db, root.id),
    attention,
  };
}

/**
 * Builds the derived projection over every chain visible to this
 * application (isolation rides the root's accountable principal, the same
 * rule close.cancelled and recovery admit under). Pure reads: byte-stable
 * ordering everywhere, zero writes, zero inferred effects.
 */
export function buildLifecycleView(db, appId, payload) {
  const request = validateViewRequest(payload);
  const roots = db
    .prepare(
      `SELECT o.* FROM obligations o
        JOIN principals p ON p.id = o.accountable_principal_id
       WHERE o.role = 'root' AND p.created_by_app_id = ?
         AND (? IS NULL OR o.conversation_id = ?)
         AND (? IS NULL OR o.id = ?)
       ORDER BY o.created_at ASC, o.id ASC`,
    )
    .all(
      appId,
      request.conversation_id ?? null,
      request.conversation_id ?? null,
      request.root_obligation_id ?? null,
      request.root_obligation_id ?? null,
    );
  return { chains: roots.map((root) => projectionForRoot(db, root)) };
}

export const lifecycleViewOp = {
  name: 'lifecycle.view',
  allowedScopes: ['agent'],
  // The same obligation-administration grant the retired obligation.list
  // read under: the projection exposes cross-principal work truth, so it
  // stays behind the vocabulary that always governed it.
  permission: 'manage_obligations',
  handler(context, payload, connection) {
    return { result: buildLifecycleView(context.db, connection.appId, payload) };
  },
};
