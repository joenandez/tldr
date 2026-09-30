// The lifecycle transition engine (Project Relay parent 2.1): the ONLY
// authority that may change forward obligation truth, applied as exactly one
// typed effect per committed application-authored message
// (.spectre/features/lifecycle-control-plane/specs/plan.md "Technical
// Approach 1-2"; docs/lifecycle-control-plane/transitions.yaml MSG-OPEN
// through MSG-NONE).
//
// Every effect validates its guards, then writes message + immutable
// message_effects row + obligation/watch mutations + delivery routes inside
// ONE caller transaction, so a guard loser or an injected failure leaves zero
// committed rows of any kind (INV-01/INV-06). Custodian-authored effects are
// generation-fenced on both axes: the exact obligation generation AND the
// endpoint process_generation must match, and a mismatch rejects without a
// trace. Closed rows are never updated — status and resolution variant fields
// are written together once, which is what schema v7's closed-immutability
// trigger demands.
//
// Idempotency identity is (app_id, idempotency_key) plus the canonical hash
// over every request field INCLUDING the full effect object: same key + same
// payload replays the original result, same key + any changed field is a
// collision. Replay reconstruction reads the immutable audit row (whose
// payload records both the declared effect and the rows it created), so a
// replay never re-runs — and can never fail — a generation or custody fence.
//
// This is an internal engine: no public operation is registered here. The
// public `message.commit` wrapper (parent 2.2) and the exactly-once watch
// routing for decline/child-result (parent 3.1) bind it from outside; the
// acceptance-expiry reconciler that races accept at the awaiting_acceptance
// CAS is task 3.2's. Parent 2.3 adds the
// administrative RECOVERY-RETRY / RECOVERY-SWITCH transitions at the bottom
// of this file: same transaction discipline and guard vocabulary, but no
// message row — their idempotency identity lives in the lifecycle_commands
// ledger (schema v8).

import { TightbeamError } from '../protocol/envelope.mjs';
import { generateId } from '../protocol/ids.mjs';
import { RESERVED_SELECTORS, SELECTOR_PATTERN } from './channel_route_contract.mjs';
import { withTransaction } from './db.mjs';
import { REPLY_BINDING_POLICY } from './reply_listener_policy.mjs';
import { replyContinuityDiagnostic } from './reply_continuity_diagnostics.mjs';
import { createPendingPresentation, publishPresentation } from './ops/listener_operations.mjs';
import { isUniqueConstraintError } from './ops/authority_scope.mjs';
import { armTachyonFromCommittedEffect, endUnsupportedTachyonListeners, isTachyonArmedForGeneration } from './tachyon_arming.mjs';
import {
  createDeliveriesForChannelRoutes,
  createDeliveriesForRecipients,
  createParentResultDelivery,
  insertMessage,
  loadConversationOrUnknown,
  payloadHash,
  pushLiveDeliveryEvents,
  refreshSessionWatermark,
  requireParticipant,
  requirePrincipal,
  resolveOrCreateDirectConversation,
  resolveSendBranch,
  routeDelivery,
  stampOwnerIfUnset,
  validateBody,
  validateIdempotencyKey,
  validateMetadata,
  withIdempotency,
} from './ops/message_shared.mjs';
import { validateConversationMetadata } from './ops/conversation_create.mjs';
import { tightbeamCommandName } from '../cli/package_context.mjs';

const COMPLETION_MODES = ['message_committed', 'delivery_confirmed'];
const TERMINAL_OUTCOMES = ['success', 'failure', 'blocked'];

// The exact field set each effect family may declare — nothing more. A field
// belonging to another family makes the object declare two effects at once,
// which is malformed: every post-cutover message carries EXACTLY one effect
// (INV-02), and effects are never inferred from prose or extra fields.
const EFFECT_FIELDS = {
  'open': ['target_principal_id', 'target_endpoint_id', 'completion_mode', 'sender_endpoint_id', 'process_generation'],
  'update': ['obligation_id', 'generation', 'sender_endpoint_id', 'process_generation', 'acknowledgement'],
  'handoff.offer': [
    'obligation_id',
    'generation',
    'sender_endpoint_id',
    'process_generation',
    'target_principal_id',
    'registration_key',
    'acceptance_deadline_at',
  ],
  'handoff.accept': ['obligation_id', 'generation', 'sender_endpoint_id', 'process_generation'],
  'handoff.decline': ['obligation_id', 'generation', 'sender_endpoint_id', 'process_generation'],
  'close.fulfilled': ['obligation_id', 'generation', 'sender_endpoint_id', 'process_generation', 'outcome'],
  'close.cancelled': ['obligation_id', 'generation', 'reason', 'source', 'sender_endpoint_id', 'process_generation'],
  'none': ['sender_endpoint_id', 'process_generation'],
};

function requireEffectString(effect, field) {
  const value = effect[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TightbeamError('malformed_request', `obligation_effect.${field} is required and must be a non-empty string`, { field });
  }
  return value;
}

function requireEffectPositiveInteger(effect, field) {
  const value = effect[field];
  if (!Number.isInteger(value) || value < 1) {
    throw new TightbeamError('malformed_request', `obligation_effect.${field} is required and must be a positive integer`, { field });
  }
  return value;
}

/**
 * Validates the effect declaration's shape before anything touches the
 * database: known type, exact per-family field set, well-formed values.
 */
export function validateEffect(declaredEffect) {
  if (!declaredEffect || typeof declaredEffect !== 'object' || Array.isArray(declaredEffect)) {
    throw new TightbeamError('malformed_request', 'obligation_effect is required and must declare exactly one effect', { field: 'obligation_effect' });
  }
  const type = declaredEffect.type;
  if (typeof type !== 'string' || !EFFECT_FIELDS[type]) {
    throw new TightbeamError(
      'malformed_request',
      'obligation_effect.type must be one of "open", "update", "handoff.offer", "handoff.accept", "handoff.decline", "close.fulfilled", "close.cancelled", "none"',
      { field: 'obligation_effect.type' },
    );
  }
  for (const key of Object.keys(declaredEffect)) {
    if (key !== 'type' && !EFFECT_FIELDS[type].includes(key)) {
      throw new TightbeamError('malformed_request', `obligation_effect declares "${key}", which does not belong to the "${type}" effect; exactly one effect may be declared`, {
        field: `obligation_effect.${key}`,
      });
    }
  }

  const effect = { type };
  if (type === 'open') {
    effect.target_principal_id = requireEffectString(declaredEffect, 'target_principal_id');
    effect.target_endpoint_id = requireEffectString(declaredEffect, 'target_endpoint_id');
    const completionMode = requireEffectString(declaredEffect, 'completion_mode');
    if (!COMPLETION_MODES.includes(completionMode)) {
      throw new TightbeamError('malformed_request', 'obligation_effect.completion_mode must be "message_committed" or "delivery_confirmed"', {
        field: 'obligation_effect.completion_mode',
      });
    }
    effect.completion_mode = completionMode;
    if (declaredEffect.sender_endpoint_id !== undefined || declaredEffect.process_generation !== undefined) {
      effect.sender_endpoint_id = requireEffectString(declaredEffect, 'sender_endpoint_id');
      effect.process_generation = requireEffectPositiveInteger(declaredEffect, 'process_generation');
    }
    return effect;
  }

  if (type === 'none') {
    effect.sender_endpoint_id = requireEffectString(declaredEffect, 'sender_endpoint_id');
    effect.process_generation = requireEffectPositiveInteger(declaredEffect, 'process_generation');
    return effect;
  }

  if (type === 'close.cancelled') {
    effect.obligation_id = requireEffectString(declaredEffect, 'obligation_id');
    effect.generation = requireEffectPositiveInteger(declaredEffect, 'generation');
    effect.reason = requireEffectString(declaredEffect, 'reason');
    effect.source = requireEffectString(declaredEffect, 'source');
    effect.sender_endpoint_id = requireEffectString(declaredEffect, 'sender_endpoint_id');
    effect.process_generation = requireEffectPositiveInteger(declaredEffect, 'process_generation');
    return effect;
  }

  // update, handoff.*, close.fulfilled share the fenced-node core fields.
  effect.obligation_id = requireEffectString(declaredEffect, 'obligation_id');
  effect.generation = requireEffectPositiveInteger(declaredEffect, 'generation');
  effect.sender_endpoint_id = requireEffectString(declaredEffect, 'sender_endpoint_id');
  effect.process_generation = requireEffectPositiveInteger(declaredEffect, 'process_generation');
  if (type === 'update' && declaredEffect.acknowledgement !== undefined) {
    if (declaredEffect.acknowledgement !== true) {
      throw new TightbeamError('malformed_request', 'obligation_effect.acknowledgement must be true when present', { field: 'acknowledgement' });
    }
    effect.acknowledgement = true;
  }
  if (type === 'handoff.offer') {
    effect.target_principal_id = requireEffectString(declaredEffect, 'target_principal_id');
    effect.registration_key = requireEffectString(declaredEffect, 'registration_key');
    const deadline = requireEffectString(declaredEffect, 'acceptance_deadline_at');
    if (Number.isNaN(Date.parse(deadline))) {
      throw new TightbeamError('malformed_request', 'obligation_effect.acceptance_deadline_at must be an absolute timestamp', {
        field: 'obligation_effect.acceptance_deadline_at',
      });
    }
    effect.acceptance_deadline_at = deadline;
  }
  if (type === 'close.fulfilled') {
    const outcome = requireEffectString(declaredEffect, 'outcome');
    if (!TERMINAL_OUTCOMES.includes(outcome)) {
      throw new TightbeamError('malformed_request', 'obligation_effect.outcome must be one of "success", "failure", "blocked"', {
        field: 'obligation_effect.outcome',
      });
    }
    effect.outcome = outcome;
  }
  return effect;
}

// ---------------------------------------------------------------------
// Shared guards. Every rejection path reuses the existing error vocabulary:
// custody/generation/state races fail with obligation_conflict, invisible
// obligations with the non-leaking permission_denied (the isolation rule
// inherited from the retired legacy writers).

function loadObligationInConversation(db, { obligationId, conversationId }) {
  const node = db.prepare('SELECT * FROM obligations WHERE id = ?').get(obligationId);
  if (!node || node.conversation_id !== conversationId) {
    throw new TightbeamError('obligation_conflict', `obligation "${obligationId}" is not work in this conversation`, { field: 'obligation_id' });
  }
  return node;
}

function requireOpen(node) {
  if (node.status !== 'open') {
    throw new TightbeamError('obligation_conflict', `obligation "${node.id}" is closed and its resolution is immutable`, { field: 'obligation_id' });
  }
}

function fenceGeneration(node, suppliedGeneration) {
  if (node.generation !== suppliedGeneration) {
    throw new TightbeamError('obligation_conflict', `obligation "${node.id}" is at generation ${node.generation}, not ${suppliedGeneration}; a stale generation cannot mutate open work`, {
      field: 'generation',
    });
  }
}

/**
 * Resolves the acting endpoint and fences it: it must exist under this app,
 * belong to the sending principal, and sit at the exact observed process
 * generation. A stale or foreign process never gets past this gate, so it can
 * never mutate open work (INV-06).
 */
function requireActingEndpoint(db, { appId, senderPrincipalId, senderEndpointId, processGeneration }) {
  const endpoint = db.prepare('SELECT id, principal_id, created_by_app_id, process_generation FROM endpoints WHERE id = ?').get(senderEndpointId);
  if (!endpoint || endpoint.created_by_app_id !== appId) {
    throw new TightbeamError('obligation_conflict', 'the acting endpoint is not visible to this application', { field: 'sender_endpoint_id' });
  }
  if (endpoint.principal_id !== senderPrincipalId) {
    throw new TightbeamError('obligation_conflict', 'sender_endpoint_id does not belong to sender_principal_id', { field: 'sender_endpoint_id' });
  }
  if (endpoint.process_generation === null || endpoint.process_generation !== processGeneration) {
    throw new TightbeamError('obligation_conflict', `endpoint "${endpoint.id}" is at process generation ${endpoint.process_generation}, not ${processGeneration}`, {
      field: 'process_generation',
    });
  }
  return endpoint;
}

/**
 * Custodian-authored effects act through the exact current custodian. A root
 * carries accountability only (no custodian row exists), so closing a root is
 * authorized through its one open attempt: the executing child's custodian
 * closes the chain head in the same transaction.
 */
function requireCustody(db, { node, senderEndpointId }) {
  if (node.role === 'root') {
    const ownedAttempt = db
      .prepare("SELECT 1 FROM obligations WHERE parent_id = ? AND role = 'attempt' AND status = 'open' AND custodian_endpoint_id = ?")
      .get(node.id, senderEndpointId);
    if (!ownedAttempt) {
      throw new TightbeamError('obligation_conflict', 'a root is closed only through the endpoint owning its open attempt', { field: 'sender_endpoint_id' });
    }
    return;
  }
  if (node.custodian_endpoint_id !== senderEndpointId) {
    throw new TightbeamError('obligation_conflict', `obligation "${node.id}" is not in the custody of endpoint "${senderEndpointId}"`, { field: 'sender_endpoint_id' });
  }
}

function requireTerminalCustody(db, { node, senderEndpointId }) {
  if (node.role !== 'root') return requireCustody(db, { node, senderEndpointId });
  const activeAttempt = db.prepare("SELECT * FROM obligations WHERE parent_id = ? AND role = 'attempt' AND status = 'open' ORDER BY created_at ASC, id ASC LIMIT 1").get(node.id);
  if (!activeAttempt) throw new TightbeamError('obligation_conflict', `root obligation "${node.id}" has no open custodied attempt`, { field: 'obligation_id' });
  requireCustody(db, { node: activeAttempt, senderEndpointId });
}

/**
 * Writes the immutable one-per-message effect audit row. The payload keeps
 * the declared effect together with the rows it created: the forward schema
 * deliberately has no message column on obligations, so this payload is what
 * makes an identical-key replay able to return the originally created
 * root/attempt/delegation/watch IDs.
 */
function insertEffectRow(db, { messageId, effect, obligationId, obligationGeneration, created, now }) {
  db.prepare(
    `INSERT INTO message_effects (id, message_id, effect, effect_payload, obligation_id, obligation_generation, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(generateId('message_effect'), messageId, effect.type, JSON.stringify({ declaration: effect, created: created ?? null }), obligationId ?? null, obligationGeneration ?? null, now);
}

// ---------------------------------------------------------------------
// Effect writers. Each runs INSIDE the caller's transaction after the
// message row exists; any throw rolls the whole commit back to zero rows.

export function applyOpen(db, { appId, conversationId, messageId, effect, now }) {
  const target = requirePrincipal(db, effect.target_principal_id, 'obligation_effect.target_principal_id');
  requireParticipant(db, conversationId, target.id);

  const targetEndpoint = db.prepare('SELECT id, principal_id, state FROM endpoints WHERE id = ? AND created_by_app_id = ?').get(effect.target_endpoint_id, appId);
  if (!targetEndpoint) {
    throw new TightbeamError('endpoint_unknown', `no endpoint "${effect.target_endpoint_id}" is visible to this application`, { field: 'obligation_effect.target_endpoint_id' });
  }
  if (targetEndpoint.principal_id !== target.id) {
    throw new TightbeamError('obligation_conflict', 'the target endpoint must belong to the target principal', { field: 'obligation_effect.target_endpoint_id' });
  }
  if (targetEndpoint.state === 'closed') {
    throw new TightbeamError('obligation_conflict', 'open work requires an open target endpoint', { field: 'obligation_effect.target_endpoint_id' });
  }

  const rootId = generateId('obligation');
  db.prepare(
    `INSERT INTO obligations (id, conversation_id, role, status, generation, accountable_principal_id, created_at, updated_at)
     VALUES (?, ?, 'root', 'open', 1, ?, ?, ?)`,
  ).run(rootId, conversationId, target.id, now, now);
  const attemptId = generateId('obligation');
  db.prepare(
    `INSERT INTO obligations (id, conversation_id, parent_id, role, status, generation, accountable_principal_id, custodian_endpoint_id, created_at, updated_at)
     VALUES (?, ?, ?, 'attempt', 'open', 1, ?, ?, ?, ?)`,
  ).run(attemptId, conversationId, rootId, target.id, targetEndpoint.id, now, now);

  const created = { root_id: rootId, attempt_id: attemptId };
  insertEffectRow(db, { messageId, effect, obligationId: rootId, obligationGeneration: 1, created, now });
  return { created, effectObligationId: rootId, effectGeneration: 1 };
}

function applyUpdate(db, ctxFields) {
  const { appId, senderPrincipalId, conversationId, messageId, effect, now } = ctxFields;
  requireActingEndpoint(db, { appId, senderPrincipalId, senderEndpointId: effect.sender_endpoint_id, processGeneration: effect.process_generation });
  const node = loadObligationInConversation(db, { obligationId: effect.obligation_id, conversationId });
  requireOpen(node);
  fenceGeneration(node, effect.generation);
  requireCustody(db, { node, senderEndpointId: effect.sender_endpoint_id });

  let acknowledgement = null;
  if (effect.acknowledgement) {
    const rootId = chainRootOf(db, node.id);
    const root = db.prepare('SELECT * FROM obligations WHERE id = ?').get(rootId);
    const origin = db
      .prepare(
        `SELECT m.id AS message_id, m.origin_channel_route_id AS route_id
           FROM message_effects me
           JOIN messages m ON m.id = me.message_id
          WHERE me.effect = 'open' AND me.obligation_id = ?`,
      )
      .get(rootId);
    if (
      !root
      || root.role !== 'root'
      || root.status !== 'open'
      || typeof root.ack_due_at !== 'string'
      || root.ack_due_at.length === 0
      || root.ack_accepted_at !== null
      || !origin?.route_id
    ) {
      throw new TightbeamError('obligation_conflict', 'this work has no pending user acknowledgement', { field: 'obligation_id' });
    }
    const active = db
      .prepare("SELECT 1 FROM deliveries WHERE route_reason = 'ack.provider_confirmed' AND source_obligation_id = ? AND state IN ('pending', 'claimed') LIMIT 1")
      .get(root.id);
    if (active) {
      throw new TightbeamError('obligation_conflict', 'this work already has an acknowledgement awaiting provider confirmation', { field: 'obligation_id' });
    }
    acknowledgement = { rootId: root.id, originRouteId: origin.route_id };
  }

  // First-progress evidence lands once and is never rewritten: COALESCE
  // keeps the original fact on every later update.
  db.prepare(
    `UPDATE obligations
        SET first_progress_message_id = COALESCE(first_progress_message_id, ?),
            first_progress_at = COALESCE(first_progress_at, ?),
            updated_at = ?
      WHERE id = ? AND status = 'open'`,
  ).run(messageId, now, now, node.id);

  insertEffectRow(db, { messageId, effect, obligationId: node.id, obligationGeneration: node.generation, now });
  return acknowledgement
    ? { effectObligationId: node.id, effectGeneration: node.generation, stageAcknowledgementRootId: acknowledgement.rootId, acknowledgementOriginRouteId: acknowledgement.originRouteId }
    : { effectObligationId: node.id, effectGeneration: node.generation };
}

/** Typed transport receipt for a contextual user acknowledgement. */
export const ACK_PROVIDER_CONFIRMED_ROUTE_REASON = 'ack.provider_confirmed';

/**
 * Provider delivery is the only ACK satisfaction boundary. The delivery row
 * is both root-bound and claim-token gated by delivery.complete; this helper
 * only records the exact accepted ACK facts and never resolves work.
 */
export function acceptProviderAcknowledgement(db, { deliveryId, now }) {
  const acceptedAt = now instanceof Date ? now.toISOString() : now;
  const delivery = db
    .prepare('SELECT id, message_id, route_reason, source_obligation_id FROM deliveries WHERE id = ?')
    .get(deliveryId);
  if (!delivery || delivery.route_reason !== ACK_PROVIDER_CONFIRMED_ROUTE_REASON || !delivery.source_obligation_id) return null;
  const stamped = db
    .prepare(
      `UPDATE obligations
          SET ack_message_id = ?, ack_delivery_id = ?, ack_accepted_at = ?, updated_at = ?
        WHERE id = ? AND role = 'root' AND status = 'open'
          AND ack_due_at IS NOT NULL AND ack_accepted_at IS NULL`,
    )
    .run(delivery.message_id, delivery.id, acceptedAt, acceptedAt, delivery.source_obligation_id);
  return stamped.changes === 1 ? { root_obligation_id: delivery.source_obligation_id, message_id: delivery.message_id, delivery_id: delivery.id, accepted_at: acceptedAt } : null;
}

function applyHandoffOffer(db, ctxFields) {
  const { appId, senderPrincipalId, conversationId, messageId, effect, now } = ctxFields;
  requireActingEndpoint(db, { appId, senderPrincipalId, senderEndpointId: effect.sender_endpoint_id, processGeneration: effect.process_generation });
  const parent = loadObligationInConversation(db, { obligationId: effect.obligation_id, conversationId });
  requireOpen(parent);
  if (parent.role === 'root') {
    throw new TightbeamError('obligation_conflict', 'a root holds no execution custody to delegate from', { field: 'obligation_id' });
  }
  fenceGeneration(parent, effect.generation);
  requireCustody(db, { node: parent, senderEndpointId: effect.sender_endpoint_id });

  const recipient = requirePrincipal(db, effect.target_principal_id, 'obligation_effect.target_principal_id');
  requireParticipant(db, conversationId, recipient.id);

  const delegationId = generateId('obligation');
  db.prepare(
    `INSERT INTO obligations (id, conversation_id, parent_id, role, status, generation, accountable_principal_id, created_at, updated_at)
     VALUES (?, ?, ?, 'delegation', 'open', 1, ?, ?, ?)`,
  ).run(delegationId, conversationId, parent.id, recipient.id, now, now);

  const watchId = generateId('handoff_watch');
  db.prepare(
    `INSERT INTO handoff_watches (id, delegation_id, state, acceptance_deadline_at, created_at, updated_at)
     VALUES (?, ?, 'awaiting_acceptance', ?, ?, ?)`,
  ).run(watchId, delegationId, effect.acceptance_deadline_at, now, now);

  const created = { delegation_id: delegationId, watch_id: watchId };
  insertEffectRow(db, { messageId, effect, obligationId: parent.id, obligationGeneration: parent.generation, created, now });
  return { created, effectObligationId: parent.id, effectGeneration: parent.generation };
}

/**
 * Shared admission for acting ON a delegated offer (accept/decline): the
 * actor is the recipient principal's endpoint at the exact observed process
 * generation, the delegation is open, and its named generation matches.
 */
function loadDelegationForRecipientAction(db, { appId, senderPrincipalId, conversationId, effect }) {
  const endpoint = requireActingEndpoint(db, { appId, senderPrincipalId, senderEndpointId: effect.sender_endpoint_id, processGeneration: effect.process_generation });
  const delegation = loadObligationInConversation(db, { obligationId: effect.obligation_id, conversationId });
  if (delegation.role !== 'delegation') {
    throw new TightbeamError('obligation_conflict', `obligation "${delegation.id}" is not a delegation`, { field: 'obligation_id' });
  }
  if (delegation.accountable_principal_id !== endpoint.principal_id) {
    throw new TightbeamError('obligation_conflict', 'the acting endpoint does not belong to the delegation\'s recipient principal', { field: 'sender_endpoint_id' });
  }
  requireOpen(delegation);
  fenceGeneration(delegation, effect.generation);

  const watch = db.prepare('SELECT id, state FROM handoff_watches WHERE delegation_id = ?').get(delegation.id);
  if (!watch || watch.state !== 'awaiting_acceptance') {
    throw new TightbeamError('obligation_conflict', `delegation "${delegation.id}" has no open acceptance window`, { field: 'obligation_id' });
  }
  return { delegation, watch };
}

function applyHandoffAccept(db, ctxFields) {
  const { conversationId, messageId, effect, now } = ctxFields;
  const { delegation, watch } = loadDelegationForRecipientAction(db, ctxFields);
  if (delegation.custodian_endpoint_id !== null) {
    throw new TightbeamError('obligation_conflict', `delegation "${delegation.id}" was already accepted`, { field: 'obligation_id' });
  }

  // Exactly one of accept/expiry wins the awaiting_acceptance CAS; binding
  // custody rides the same transaction, so a lost race rolls both back.
  const advanced = db.prepare("UPDATE handoff_watches SET state = 'awaiting_result', updated_at = ? WHERE id = ? AND state = 'awaiting_acceptance'").run(now, watch.id);
  if (advanced.changes !== 1) {
    throw new TightbeamError('obligation_conflict', `delegation "${delegation.id}" acceptance raced a decided watch`, { field: 'obligation_id' });
  }
  const bound = db.prepare("UPDATE obligations SET custodian_endpoint_id = ?, updated_at = ? WHERE id = ? AND status = 'open' AND custodian_endpoint_id IS NULL").run(
    effect.sender_endpoint_id,
    now,
    delegation.id,
  );
  if (bound.changes !== 1) {
    throw new TightbeamError('obligation_conflict', `delegation "${delegation.id}" cannot bind custody`, { field: 'obligation_id' });
  }

  insertEffectRow(db, { messageId, effect, obligationId: delegation.id, obligationGeneration: delegation.generation, now });
  // Acceptance wakes no one (transitions.yaml MSG-HANDOFF-ACCEPT): the parent
  // learns the outcome from the watch, so this commit writes no deliveries.
  return { effectObligationId: delegation.id, effectGeneration: delegation.generation };
}

function applyHandoffDecline(db, ctxFields) {
  const { stateRoot, logger, senderPrincipalId, conversationId, messageId, effect, now } = ctxFields;
  const { delegation, watch } = loadDelegationForRecipientAction(db, ctxFields);

  const declined = db
    .prepare(
      `UPDATE obligations
          SET status = 'closed', resolution = 'failed', resolution_reason = 'declined_by_recipient',
              resolution_source = ?, updated_at = ?
        WHERE id = ? AND status = 'open'`,
    )
    .run(`handoff.decline:${messageId}`, now, delegation.id);
  if (declined.changes !== 1) {
    throw new TightbeamError('obligation_conflict', `delegation "${delegation.id}" cannot be declined`, { field: 'obligation_id' });
  }

  const parent = db.prepare('SELECT id, custodian_endpoint_id FROM obligations WHERE id = ?').get(delegation.parent_id);
  // The decline decision (delegation failed + watch declined) must commit
  // even when the immediate parent's custodian endpoint is closed or absent:
  // the wake mirrors ENDPOINT-DEATH's
  // create_one_parent_custody_loss_delivery_if_parent_exists — best-effort,
  // never a reason to strand the offered delegation and its armed watch.
  const { liveDeliveries, presentations } = createParentResultDelivery(db, {
    conversationId,
    messageId,
    senderPrincipalId,
    parentEndpointId: parent?.custodian_endpoint_id,
    ifParentExists: true,
    stateRoot,
    logger,
  });

  // Decline wakes the immediate parent exactly once: the single durable
  // delivery row doubles as the watch's unique parent_delivery_id reference.
  const parentDeliveryId = db.prepare('SELECT id FROM deliveries WHERE message_id = ? AND endpoint_id = ?').get(messageId, parent?.custodian_endpoint_id)?.id ?? null;
  db.prepare("UPDATE handoff_watches SET state = 'closed', outcome = 'declined', closed_at = ?, parent_delivery_id = ?, updated_at = ? WHERE id = ? AND state = 'awaiting_acceptance'").run(
    now,
    parentDeliveryId,
    now,
    watch.id,
  );

  insertEffectRow(db, { messageId, effect, obligationId: delegation.id, obligationGeneration: delegation.generation, now });
  return { liveDeliveries, presentations, effectObligationId: delegation.id, effectGeneration: delegation.generation };
}

/**
 * Closes every still-open descendant of a deliberately closing node as
 * superseded BY that node, then silently closes their watches. Silent means
 * NO parent wake route: the whole subtree terminates together, so
 * exactly-once parent routing (task 3.1) has nothing to deliver here. The
 * watch outcome vocabulary has no superseded value — storage closes a watch
 * only through one of its four outcomes, and child_failed is the truthful
 * pick (the delegated child can never produce a result now).
 *
 * Every deliberate terminal close cascades regardless of the named node's
 * role (root, attempt, or accepted delegation): stopping at roots would
 * strand open sub-delegations beneath a closed attempt or delegation, whose
 * watches would stay armed forever with no reconciler left to decide them.
 * Death/recovery paths stay exact-custody-only and never call this.
 */
function supersedeOpenDescendants(db, { closingNodeId, source, now }) {
  db.prepare(
    `WITH RECURSIVE descendants(id) AS (
       SELECT id FROM obligations WHERE parent_id = ?
       UNION ALL
       SELECT o.id FROM obligations o JOIN descendants d ON o.parent_id = d.id
     )
     UPDATE obligations
        SET status = 'closed', resolution = 'superseded', resolution_replacement_id = ?, resolution_source = ?, updated_at = ?
      WHERE id IN descendants AND status = 'open'`,
  ).run(closingNodeId, closingNodeId, source, now);

  db.prepare(
    `WITH RECURSIVE descendants(id) AS (
       SELECT id FROM obligations WHERE parent_id = ?
       UNION ALL
       SELECT o.id FROM obligations o JOIN descendants d ON o.parent_id = d.id
     )
     UPDATE handoff_watches
        SET state = 'closed', outcome = 'child_failed', closed_at = ?, updated_at = ?
      WHERE state <> 'closed' AND delegation_id IN descendants`,
  ).run(closingNodeId, now, now);
}

/**
 * CHILD-RESULT (transitions.yaml): a fulfilled delegation produced its
 * terminal result, so its own watch closes with outcome "result" exactly
 * once, referencing the one parent delivery that reports it — the same
 * recorded-wake discipline as decline. The delegation flip above already
 * fenced open→closed, so an open watch must exist here; anything else means
 * the offer invariant broke and fails closed rather than waking a parent for
 * an undecided custody.
 */
function closeDelegationWatchWithResult(db, { delegationId, parentDeliveryId, now }) {
  const closedWatch = db
    .prepare("UPDATE handoff_watches SET state = 'closed', outcome = 'result', closed_at = ?, parent_delivery_id = ?, updated_at = ? WHERE delegation_id = ? AND state <> 'closed'")
    .run(now, parentDeliveryId, now, delegationId);
  if (closedWatch.changes !== 1) {
    throw new TightbeamError('obligation_conflict', `delegation "${delegationId}" has no open watch to close with its result`, { field: 'obligation_id' });
  }
}

/**
 * The terminal report of an accepted delegation reaches EXACTLY its
 * immediate parent: one durable delivery naming the delegation whose custody
 * ended (route_reason + source_obligation_id, per the plan's «Technical
 * Approach 3» typed routing), written inside this same transaction together
 * with its resume route when the parent needs waking. The returned
 * liveDeliveries tell the commit entry point that this writer routed
 * everything itself, so the ordinary participant fan-out must not
 * double-deliver.
 */
function routeChildResultDelivery(db, { conversationId, messageId, senderPrincipalId, delegation, stateRoot, logger }) {
  const parent = db.prepare('SELECT id, custodian_endpoint_id FROM obligations WHERE id = ?').get(delegation.parent_id);
  const { liveDeliveries, presentations } = createParentResultDelivery(db, {
    conversationId,
    messageId,
    senderPrincipalId,
    parentEndpointId: parent?.custodian_endpoint_id,
    routeReason: 'handoff.child.result',
    sourceObligationId: delegation.id,
    stateRoot,
    logger,
  });
  // Exactly one delivery was written for this message, to the parent
  // endpoint; its row id is the watch's unique parent_delivery_id.
  const parentDeliveryId = db.prepare('SELECT id FROM deliveries WHERE message_id = ? AND endpoint_id = ?').get(messageId, parent?.custodian_endpoint_id)?.id ?? null;
  return { liveDeliveries, presentations, parentDeliveryId };
}

// ---------------------------------------------------------------------
// Delivery-confirmed truth (Project Relay parent 4.2; transitions.yaml
// DELIVERY-CLAIM / DELIVERY-SUCCEED / DELIVERY-FAIL; canonical INV-07).
//
// A delivery receipt is TRANSPORT fact and is never work completion — except
// through this exact policy: a close.fulfilled naming a root whose open
// effect declared completion_mode "delivery_confirmed" STAGES its proposed
// resolution inside the message transaction (immutable effect audit + typed
// eligible delivery), and only `delivery.complete { outcome: "delivered" }`
// on THAT delivery, held under an active claim token, closes the named chain.
// Eligibility is RECIPIENT-EXACT: the report fans out to every participant,
// but the only typed row is the return route to the principal that opened
// the work (confirmationRecipientPrincipalId below). Any other participant's
// copy is an ordinary delivery — deliverable, claimable, completable, and
// inert for closure — so a bystander's receipt can never manufacture
// terminal work truth before the requester has the report.
// Everything the staging needs lives in existing v9 columns: the effect
// audit row carries the proposed outcome, the deliveries route_reason /
// source_obligation_id pair marks the eligible row, and the requester is a
// fact of the open effect's own message. No new table, no new column, no
// stored combined status.

/** The typed route that marks a staged terminal report's eligible deliveries. */
export const DELIVERY_CONFIRMED_ROUTE_REASON = 'close.delivery_confirmed';

/** Attention source for a staged report whose exact delivery failed (DELIVERY-FAIL). */
export const DELIVERY_FAILED_ATTENTION_SOURCE = 'delivery.failed';

/**
 * A root's completion mode, read from its own immutable open-effect audit.
 * Every engine-created root wrote one in its opening transaction; an absent
 * or unreadable payload fails toward the message_committed behavior the
 * graph had before staging existed rather than inventing a third mode.
 * Exported for the lifecycle.view projection, which must present the same
 * completion-mode fact the closer acts on.
 */
export function rootCompletionMode(db, rootId) {
  const effect = db.prepare("SELECT effect_payload FROM message_effects WHERE effect = 'open' AND obligation_id = ?").get(rootId);
  try {
    return JSON.parse(effect?.effect_payload)?.declaration?.completion_mode ?? 'message_committed';
  } catch {
    return 'message_committed';
  }
}

/**
 * The ONE principal a staged terminal report must reach before its root may
 * close: the requester that opened the work. Derived from the root's own
 * immutable open-effect audit joined to the message that carried it, so the
 * answer is a fact of the opening request and nothing later can restate it —
 * a participant who merely joined the conversation can never become
 * closure-eligible. Returns null when that audit is missing or its message
 * is gone, which fails closed: nothing is eligible and the work stays open.
 */
export function confirmationRecipientPrincipalId(db, rootId) {
  const row = db
    .prepare(
      `SELECT m.sender_principal_id AS principal_id
         FROM message_effects me
         JOIN messages m ON m.id = me.message_id
        WHERE me.effect = 'open' AND me.obligation_id = ?`,
    )
    .get(rootId);
  return row?.principal_id ?? null;
}

/** The immutable inbound channel origin, if this root was opened from one. */
function immutableOriginForRoot(db, rootId) {
  return db
    .prepare(
      `SELECT m.id AS message_id, m.origin_channel_route_id AS route_id
         FROM message_effects me
         JOIN messages m ON m.id = me.message_id
        WHERE me.effect = 'open' AND me.obligation_id = ?`,
    )
    .get(rootId) ?? null;
}

/**
 * True while a staged terminal report still has an ACTIVE (pending/claimed)
 * typed delivery for this root. A failed delivery drops out of the predicate:
 * the candidate stays as audit and a later close.fulfilled may stage a fresh
 * one (LC-D05 "terminal candidate is retained for audit").
 */
function hasActiveStagedResolution(db, rootId) {
  return Boolean(
    db
      .prepare(
        `SELECT 1
           FROM deliveries d
           JOIN message_effects me ON me.message_id = d.message_id AND me.effect IN ('close.fulfilled', 'close.cancelled') AND me.obligation_id = ?
          WHERE d.route_reason = ? AND d.source_obligation_id = ?
            AND d.state IN ('pending', 'claimed')
          LIMIT 1`,
      )
      .get(rootId, DELIVERY_CONFIRMED_ROUTE_REASON, rootId),
  );
}

function stageDeliveryConfirmedTerminal(db, { node, messageId, effect, now, origin }) {
  if (hasActiveStagedResolution(db, node.id)) {
    throw new TightbeamError('obligation_conflict', `root "${node.id}" already has a terminal resolution staged for delivery confirmation; it closes only through that exact delivery`, {
      field: 'obligation_id',
    });
  }
  insertEffectRow(db, { messageId, effect, obligationId: node.id, obligationGeneration: node.generation, now });
  return {
    stageDeliveryConfirmedRootId: node.id,
    stageConfirmationRecipientPrincipalId: confirmationRecipientPrincipalId(db, node.id),
    stageTerminalOriginRouteId: origin?.route_id ?? null,
    effectObligationId: node.id,
    effectGeneration: node.generation,
  };
}

/**
 * DELIVERY-SUCCEED's close_exact_staged_root_if_delivery_confirmed write,
 * run INSIDE the delivery.complete transaction after the exact claim token
 * verified. Marks nothing when the delivery is not a typed eligible route,
 * when its root already closed (a replayed or second candidate's receipt —
 * exactly-once across restarts rides this guard plus the claim ledger), or
 * when the staged audit row is unreadable (fail closed: transport truth
 * stands, work stays open). Closing the root supersedes its remaining open
 * subtree with the same silent cascade as a message_committed root close.
 */
export function closeStagedDeliveryConfirmedChain(db, { deliveryId, now }) {
  const closedAt = now instanceof Date ? now.toISOString() : now;
  const delivery = db.prepare('SELECT id, message_id, endpoint_id, route_reason, source_obligation_id, channel_route_id FROM deliveries WHERE id = ?').get(deliveryId);
  if (!delivery || delivery.route_reason !== DELIVERY_CONFIRMED_ROUTE_REASON || !delivery.source_obligation_id) {
    return null;
  }
  const root = db.prepare('SELECT * FROM obligations WHERE id = ?').get(delivery.source_obligation_id);
  if (!root || root.status !== 'open') {
    return null;
  }
  // A selected external-channel fanout is the notification evidence itself:
  // every selected route must deliver before the root closes. Channel routes
  // are deliberately not conversation participants, so they cannot satisfy
  // the ordinary requester-endpoint check below.
  if (delivery.channel_route_id !== null) {
    const unresolved = db
      .prepare(
        `SELECT COUNT(*) AS n FROM deliveries
          WHERE message_id = ? AND route_reason = ? AND source_obligation_id = ? AND state <> 'delivered'`,
      )
      .get(delivery.message_id, DELIVERY_CONFIRMED_ROUTE_REASON, root.id).n;
    if (unresolved > 0) return null;
  } else {
    // Recipient-exact, re-derived here rather than trusted from the row: the
  // typed route is written by the staging transaction, but only the opening
  // request says who the report is FOR. A receipt at any other endpoint —
  // another participant's fan-out copy, or a row typed by an older daemon —
  // is transport truth and closes nothing.
    const recipient = db.prepare('SELECT principal_id FROM endpoints WHERE id = ?').get(delivery.endpoint_id);
    if (!recipient || recipient.principal_id !== confirmationRecipientPrincipalId(db, root.id)) {
      return null;
    }
  }
  const effectRow = db.prepare("SELECT effect, effect_payload FROM message_effects WHERE message_id = ? AND obligation_id = ? AND effect IN ('close.fulfilled', 'close.cancelled')").get(delivery.message_id, root.id);
  let declaration = null;
  try {
    declaration = JSON.parse(effectRow?.effect_payload)?.declaration ?? null;
  } catch {
    declaration = null;
  }
  if (!effectRow || !declaration) {
    return null;
  }
  const fulfilled = effectRow.effect === 'close.fulfilled' && TERMINAL_OUTCOMES.includes(declaration.outcome);
  const cancelled = effectRow.effect === 'close.cancelled'
    && typeof declaration.reason === 'string' && declaration.reason.length > 0
    && typeof declaration.source === 'string' && declaration.source.length > 0;
  if (!fulfilled && !cancelled) return null;
  const closed = fulfilled
    ? db
      .prepare("UPDATE obligations SET status = 'closed', resolution = 'fulfilled', resolution_message_id = ?, resolution_outcome = ?, updated_at = ? WHERE id = ? AND status = 'open'")
      .run(delivery.message_id, declaration.outcome, closedAt, root.id)
    : db
      .prepare("UPDATE obligations SET status = 'closed', resolution = 'cancelled', resolution_reason = ?, resolution_source = ?, updated_at = ? WHERE id = ? AND status = 'open'")
      .run(declaration.reason, declaration.source, closedAt, root.id);
  if (closed.changes !== 1) {
    return null;
  }
  supersedeOpenDescendants(db, { closingNodeId: root.id, source: `delivery_confirmed_close:${root.id}`, now: closedAt });
  return { root_obligation_id: root.id, resolution_message_id: delivery.message_id, outcome: fulfilled ? declaration.outcome : 'cancelled' };
}

/**
 * DELIVERY-FAIL's leave_delivery_confirmed_root_open + mark_root_attention
 * writes, run INSIDE the delivery.complete transaction: the root stays open
 * and actionable, and one visibility mark lands on it (the same upsert shape
 * as the custody reconciler's, with its own attention_source). Inert for any
 * non-typed delivery and for a root that already closed.
 */
export function markStagedDeliveryFailedAttention(db, { deliveryId, now }) {
  const markedAt = now instanceof Date ? now.toISOString() : now;
  const delivery = db.prepare('SELECT id, route_reason, source_obligation_id FROM deliveries WHERE id = ?').get(deliveryId);
  if (!delivery || delivery.route_reason !== DELIVERY_CONFIRMED_ROUTE_REASON || !delivery.source_obligation_id) {
    return null;
  }
  const root = db.prepare('SELECT status FROM obligations WHERE id = ?').get(delivery.source_obligation_id);
  if (!root || root.status !== 'open') {
    return null;
  }
  db.prepare(
    `INSERT INTO root_attention (root_obligation_id, stop_block_count, attention_source, first_marked_at, last_block_at, updated_at)
       VALUES (?, 1, '${DELIVERY_FAILED_ATTENTION_SOURCE}', ?, ?, ?)
       ON CONFLICT(root_obligation_id) DO UPDATE SET
         attention_source = excluded.attention_source,
         last_block_at = excluded.last_block_at,
         updated_at = excluded.updated_at`,
  ).run(delivery.source_obligation_id, markedAt, markedAt, markedAt);
  return { root_obligation_id: delivery.source_obligation_id };
}

function applyCloseFulfilled(db, ctxFields) {
  const { appId, senderPrincipalId, conversationId, messageId, effect, now, eventBus, stateRoot, logger } = ctxFields;
  requireActingEndpoint(db, { appId, senderPrincipalId, senderEndpointId: effect.sender_endpoint_id, processGeneration: effect.process_generation });
  const node = loadObligationInConversation(db, { obligationId: effect.obligation_id, conversationId });
  requireOpen(node);
  fenceGeneration(node, effect.generation);
  requireCustody(db, { node, senderEndpointId: effect.sender_endpoint_id });

  // Delivery-confirmed roots (MSG-CLOSE-FULFILLED's
  // close_eligible_root_or_stage_delivery_confirmed_resolution): the message
  // transaction records the PROPOSED terminal resolution — the immutable
  // effect audit below plus the typed eligible delivery the commit entry
  // point routes next — while the whole chain STAYS OPEN. An open root must
  // keep exactly one custodian, so nothing closes here: only the later
  // `delivered` completion of that exact delivery closes the chain
  // (closeStagedDeliveryConfirmedChain), and a `failed` one marks attention
  // (markStagedDeliveryFailedAttention). The completion mode itself is a fact
  // of the root's own open effect audit — no extra column exists or is
  // needed (plan «Technical Approach 6»).
  const origin = node.role === 'root' ? immutableOriginForRoot(db, node.id) : null;
  if (node.role === 'root' && (rootCompletionMode(db, node.id) === 'delivery_confirmed' || origin?.route_id)) {
    return stageDeliveryConfirmedTerminal(db, { node, messageId, effect, now, origin });
  }

  // One atomic flip: status and the complete fulfilled variant land together,
  // satisfying trg_obligations_closed_immutable rather than fighting it.
  const closed = db
    .prepare("UPDATE obligations SET status = 'closed', resolution = 'fulfilled', resolution_message_id = ?, resolution_outcome = ?, updated_at = ? WHERE id = ? AND status = 'open'")
    .run(messageId, effect.outcome, now, node.id);
  if (closed.changes !== 1) {
    throw new TightbeamError('obligation_conflict', `obligation "${node.id}" cannot be closed`, { field: 'obligation_id' });
  }

  let routedDeliveries;
  let routedPresentations;
  if (node.role === 'delegation') {
    const routed = routeChildResultDelivery(db, { conversationId, messageId, senderPrincipalId, delegation: node, eventBus, stateRoot, logger });
    closeDelegationWatchWithResult(db, { delegationId: node.id, parentDeliveryId: routed.parentDeliveryId, now });
    routedDeliveries = routed.liveDeliveries;
    routedPresentations = routed.presentations;
  }
  // The terminal close fences its whole open subtree whatever its role; the
  // closing node's OWN custody transition above (root accountability,
  // delegation result wake) is unchanged.
  supersedeOpenDescendants(db, {
    closingNodeId: node.id,
    source: node.role === 'root' ? `root_close:${messageId}` : `close_fulfilled:${messageId}`,
    now,
  });

  insertEffectRow(db, { messageId, effect, obligationId: node.id, obligationGeneration: node.generation, now });
  return routedDeliveries === undefined
    ? { effectObligationId: node.id, effectGeneration: node.generation }
    : { liveDeliveries: routedDeliveries, presentations: routedPresentations, effectObligationId: node.id, effectGeneration: node.generation };
}

function applyCloseCancelled(db, ctxFields) {
  const { appId, senderPrincipalId, conversationId, messageId, effect, now } = ctxFields;
  const node = db.prepare('SELECT * FROM obligations WHERE id = ?').get(effect.obligation_id);
  const accountableApp = node && db.prepare('SELECT created_by_app_id FROM principals WHERE id = ?').get(node.accountable_principal_id);
  if (!node || !accountableApp || accountableApp.created_by_app_id !== appId) {
    // Non-leaking: an unknown and a foreign-app obligation are
    // indistinguishable.
    throw new TightbeamError('permission_denied', 'cancellation is not granted for this obligation');
  }
  if (node.conversation_id !== conversationId) {
    throw new TightbeamError('obligation_conflict', `obligation "${node.id}" is not part of this conversation`, { field: 'obligation_id' });
  }
  requireOpen(node);
  fenceGeneration(node, effect.generation);
  requireActingEndpoint(db, { appId, senderPrincipalId, senderEndpointId: effect.sender_endpoint_id, processGeneration: effect.process_generation });
  requireTerminalCustody(db, { node, senderEndpointId: effect.sender_endpoint_id });

  const origin = node.role === 'root' ? immutableOriginForRoot(db, node.id) : null;
  if (node.role === 'root' && origin?.route_id) {
    return stageDeliveryConfirmedTerminal(db, { node, messageId, effect, now, origin });
  }

  const cancelled = db
    .prepare("UPDATE obligations SET status = 'closed', resolution = 'cancelled', resolution_reason = ?, resolution_source = ?, updated_at = ? WHERE id = ? AND status = 'open'")
    .run(effect.reason, effect.source, now, node.id);
  if (cancelled.changes !== 1) {
    throw new TightbeamError('obligation_conflict', `obligation "${node.id}" cannot be cancelled`, { field: 'obligation_id' });
  }

  if (node.role === 'delegation') {
    // A cancelled offered/accepted delegation can never deliver a result.
    db.prepare("UPDATE handoff_watches SET state = 'closed', outcome = 'child_failed', closed_at = ?, updated_at = ? WHERE delegation_id = ? AND state <> 'closed'").run(now, now, node.id);
  }
  // Same role-independent cascade as close.fulfilled: a cancelled attempt or
  // delegation takes its open subtree down with it, silently.
  supersedeOpenDescendants(db, {
    closingNodeId: node.id,
    source: node.role === 'root' ? `root_cancel:${messageId}` : `close_cancelled:${messageId}`,
    now,
  });

  insertEffectRow(db, { messageId, effect, obligationId: node.id, obligationGeneration: node.generation, now });
  return { effectObligationId: node.id, effectGeneration: node.generation };
}

function applyNone(db, ctxFields) {
  const { appId, senderPrincipalId, conversationId, messageId, effect, now } = ctxFields;
  requireActingEndpoint(db, { appId, senderPrincipalId, senderEndpointId: effect.sender_endpoint_id, processGeneration: effect.process_generation });
  const ownedOpenWork = db
    .prepare("SELECT id FROM obligations WHERE conversation_id = ? AND custodian_endpoint_id = ? AND status = 'open' ORDER BY id LIMIT 2")
    .all(conversationId, effect.sender_endpoint_id);
  if (ownedOpenWork.length > 0) {
    // INV-03: checked before anything persists — the whole commit aborts.
    throw new TightbeamError('obligation_conflict', 'an endpoint holding open work in this conversation cannot send a none effect', { field: 'obligation_effect.type', reason: 'open_work_requires_effect', ...(ownedOpenWork.length === 1 ? { work_id: ownedOpenWork[0].id } : {}) });
  }

  insertEffectRow(db, { messageId, effect, obligationId: null, obligationGeneration: null, now });
  return { effectObligationId: null, effectGeneration: null };
}

const APPLY_BY_TYPE = {
  'open': applyOpen,
  'update': applyUpdate,
  'handoff.offer': applyHandoffOffer,
  'handoff.accept': applyHandoffAccept,
  'handoff.decline': applyHandoffDecline,
  'close.fulfilled': applyCloseFulfilled,
  'close.cancelled': applyCloseCancelled,
  'none': applyNone,
};

// ---------------------------------------------------------------------
// Idempotent replay.

function findIdempotentReplay(db, { appId, idempotencyKey, hash }) {
  const existing = db.prepare('SELECT id, conversation_id, payload_hash FROM messages WHERE app_id = ? AND idempotency_key = ?').get(appId, idempotencyKey);
  if (!existing) return null;
  if (existing.payload_hash !== hash) {
    throw new TightbeamError('idempotency_collision', `idempotency_key "${idempotencyKey}" was already used with a different payload`, { field: 'idempotency_key' });
  }
  return existing;
}

function reconstructResult(db, { messageId, conversationId, idempotentReplay }) {
  const effectRow = db.prepare('SELECT effect, effect_payload, obligation_id, obligation_generation FROM message_effects WHERE message_id = ?').get(messageId);
  if (!effectRow) {
    // Unreachable for keys this engine issued (identity equality proved the
    // message exists and every engine message writes its audit row in the
    // same transaction) — fail closed rather than invent a shape.
    throw new TightbeamError('obligation_conflict', `message "${messageId}" carries no lifecycle effect audit`);
  }
  let created = null;
  try {
    created = JSON.parse(effectRow.effect_payload)?.created ?? null;
  } catch {
    created = null;
  }
  const replyWaitIds = db
    .prepare(
      `SELECT rw.id
         FROM reply_waits rw
         JOIN reply_bindings rb ON rb.id = rw.binding_id
        WHERE rb.source_message_id = ?
        ORDER BY rw.id ASC`,
    )
    .all(messageId)
    .map((row) => row.id);
  return {
    message_id: messageId,
    conversation_id: conversationId,
    effect: {
      type: effectRow.effect,
      obligation_id: effectRow.obligation_id,
      generation: effectRow.obligation_generation,
    },
    ...(created ?? {}),
    ...(replyWaitIds.length > 0 ? { await_reply: true, reply_wait_ids: replyWaitIds } : {}),
    idempotent_replay: idempotentReplay,
  };
}

// Reuse channel_route_contract's reserved words and selector shape exactly
// (see that file's export comment): a second literal copy here could
// silently drift from what route registration accepts.
const RESERVED_CHANNEL_SELECTORS = RESERVED_SELECTORS;
const CHANNEL_SELECTOR_PATTERN = SELECTOR_PATTERN;

function normalizeChannelSelectors(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((selector) => typeof selector !== 'string' || !CHANNEL_SELECTOR_PATTERN.test(selector))) {
    throw new TightbeamError('malformed_request', 'channel_selectors must be an array of channel selectors when present', { field: 'channel_selectors' });
  }
  const selectors = [...new Set(value)].sort();
  const reserved = selectors.filter((selector) => RESERVED_CHANNEL_SELECTORS.has(selector));
  if (reserved.length > 0 && selectors.length !== 1) {
    throw new TightbeamError('malformed_request', 'all or origin must be the only channel selector', { field: 'channel_selectors' });
  }
  return selectors;
}

function availableRoute(row) {
  return row.app_status === 'active' && (row.endpoint_state === 'idle' || row.endpoint_state === 'busy');
}

function routeSupportsSend(row) {
  try {
    return JSON.parse(row.capabilities).includes('send');
  } catch {
    return false;
  }
}

function routeSupportsReply(row) {
  try {
    return JSON.parse(row.capabilities).includes('reply');
  } catch {
    return false;
  }
}

function validateAwaitReply(db, { awaitReply, sendBranch, effect, channelRoutes, appId, senderPrincipalId }) {
  if (awaitReply !== undefined && typeof awaitReply !== 'boolean') {
    throw new TightbeamError('malformed_request', 'await_reply must be a boolean when present', { field: 'await_reply' });
  }
  const isAgentNoneEffect = sendBranch === 'agent' && effect.type === 'none';
  const endpoint = isAgentNoneEffect && typeof effect.sender_endpoint_id === 'string'
    ? db.prepare('SELECT * FROM endpoints WHERE id = ?').get(effect.sender_endpoint_id)
    : null;
  const hasExactAgentSender =
    isAgentNoneEffect &&
    endpoint &&
    endpoint.created_by_app_id === appId &&
    endpoint.principal_id === senderPrincipalId &&
    endpoint.state !== 'closed' &&
    endpoint.process_generation === effect.process_generation;
  if (hasExactAgentSender && channelRoutes.some(routeSupportsReply)) return true;

  if (!awaitReply) return false;
  if (sendBranch !== 'agent' || effect.type !== 'none') {
    throw new TightbeamError('obligation_conflict', 'await_reply requires an agent-authored none effect', { field: 'await_reply' });
  }
  if (
    !endpoint ||
    endpoint.created_by_app_id !== appId ||
    endpoint.principal_id !== senderPrincipalId ||
    endpoint.state === 'closed' ||
    endpoint.process_generation !== effect.process_generation
  ) {
    throw new TightbeamError('obligation_conflict', 'await_reply requires the exact sender endpoint and process generation', { field: 'await_reply' });
  }
  if (!channelRoutes.some(routeSupportsReply)) {
    throw new TightbeamError('obligation_conflict', 'await_reply requires at least one selected reply-capable channel route', { field: 'await_reply' });
  }
  return true;
}

function createReplyWaitsForAwaitedMessage(db, { messageId, now }) {
  const bindings = db
    .prepare(
      `SELECT id, target_endpoint_id, source_provider_session_id, source_process_generation
         FROM reply_bindings
        WHERE source_message_id = ?
        ORDER BY id ASC`,
    )
    .all(messageId);
  const insert = db.prepare(
    `INSERT INTO reply_waits
       (id, binding_id, endpoint_id, provider_session_id, process_generation, state, terminal_reason, created_at, updated_at, closed_at)
     VALUES (?, ?, ?, ?, ?, 'pending_delivery', NULL, ?, ?, NULL)`,
  );
  let count = 0;
  for (const binding of bindings) {
    insert.run(
      generateId('reply_wait'),
      binding.id,
      binding.target_endpoint_id,
      binding.source_provider_session_id,
      binding.source_process_generation,
      now,
      now,
    );
    count += 1;
  }
  return count;
}

const CHANNEL_ROUTE_SELECT = `SELECT r.id, r.app_id, r.principal_id, r.endpoint_id, r.capabilities,
                                      a.status AS app_status, e.state AS endpoint_state
                                 FROM channel_routes r
                                 JOIN applications a ON a.id = r.app_id
                                 JOIN endpoints e ON e.id = r.endpoint_id
                                WHERE r.state = 'active'`;

function resolveChannelRoutes(db, { selectors, conversationId, inReplyToMessageId }) {
  if (selectors.length === 0) return [];
  if (selectors[0] === 'all') {
    const routes = db.prepare(`${CHANNEL_ROUTE_SELECT} ORDER BY r.selector ASC`).all().filter((route) => availableRoute(route) && routeSupportsSend(route));
    if (routes.length === 0) {
      throw new TightbeamError('no_outbound_channels', 'no active send-capable channel routes are available');
    }
    return routes;
  }
  if (selectors[0] === 'origin') {
    if (!inReplyToMessageId) {
      throw new TightbeamError('origin_unavailable', 'origin selection requires in_reply_to_message_id', { field: 'in_reply_to_message_id' });
    }
    const inbound = db.prepare('SELECT origin_channel_route_id FROM messages WHERE id = ? AND conversation_id = ?').get(inReplyToMessageId, conversationId);
    if (!inbound?.origin_channel_route_id) {
      throw new TightbeamError('origin_unavailable', 'the replied-to message has no trusted channel origin', { field: 'in_reply_to_message_id' });
    }
    const route = db.prepare(`${CHANNEL_ROUTE_SELECT} AND r.id = ?`).get(inbound.origin_channel_route_id);
    if (!route || !availableRoute(route) || !routeSupportsSend(route)) {
      throw new TightbeamError('origin_unavailable', 'the replied-to channel origin is unavailable', { field: 'in_reply_to_message_id' });
    }
    return [route];
  }

  const resolved = [];
  for (const selector of selectors) {
    const route = db.prepare(`${CHANNEL_ROUTE_SELECT} AND r.selector = ?`).get(selector);
    if (!route) throw new TightbeamError('unknown_channel', `unknown channel selector "${selector}"`, { field: 'channel_selectors' });
    if (!availableRoute(route)) throw new TightbeamError('channel_unavailable', `channel selector "${selector}" is unavailable`, { field: 'channel_selectors' });
    if (!routeSupportsSend(route)) throw new TightbeamError('channel_capability_denied', `channel selector "${selector}" cannot send`, { field: 'channel_selectors' });
    resolved.push(route);
  }
  return resolved;
}

const RESUME_FAILURE_NOTICE = 'Tightbeam received your message but could not resume the agent. Your request remains open; you may retry after checking the agent provider.';

/**
 * Stages the one transport-neutral resume-failure notice through the
 * inbound message's immutable route, once per request.  It intentionally
 * has no lifecycle effect: failed recovery leaves the original work root
 * open and unread.  A request still backing off after a refused credential
 * gets it too, so the user hears at the first refusal; only a request that
 * already completed never does.
 */
export function stageTerminalResumeFailureNotice(db, { requestId }) {
  const request = db.prepare(
    `SELECT r.id, r.endpoint_id, r.conversation_id, r.message_id, m.app_id, m.sender_principal_id, m.origin_channel_route_id
       FROM resume_requests r JOIN messages m ON m.id = r.message_id
      WHERE r.id = ? AND r.state IN ('failed', 'claimed', 'pending')`,
  ).get(requestId);
  if (!request?.origin_channel_route_id) return null;
  const root = db.prepare(
    `SELECT id FROM obligations WHERE conversation_id = ? AND role = 'root' AND status = 'open' LIMIT 1`,
  ).get(request.conversation_id);
  if (!root) return null;
  const routes = resolveChannelRoutes(db, {
    selectors: ['origin'], conversationId: request.conversation_id, inReplyToMessageId: request.message_id,
  });
  const key = `resume-failure:${request.id}`;
  const hash = payloadHash({ body: RESUME_FAILURE_NOTICE, in_reply_to_message_id: request.message_id, channel_selectors: ['origin'] });
  return withIdempotency(db, { appId: request.app_id, idempotencyKey: key, hash }, () => {
    const messageId = insertMessage(db, {
      conversationId: request.conversation_id,
      appId: request.app_id,
      senderPrincipalId: request.sender_principal_id,
      kind: 'commit',
      body: RESUME_FAILURE_NOTICE,
      metadata: {},
      idempotencyKey: key,
      hash,
      origin: 'agent',
      inReplyToMessageId: request.message_id,
    });
    // The notice is delivered like any agent reply, so a reply-capable
    // route also binds the user's answer to the agent whose resume failed:
    // answering the notice is the retry the notice offers.
    const { liveDeliveries } = createDeliveriesForChannelRoutes(db, {
      conversationId: request.conversation_id,
      messageId,
      routes,
      replyTargetEndpointId: request.endpoint_id,
      replyTargetMustBeSender: false,
    });
    return { message_id: messageId, conversation_id: request.conversation_id, delivery_count: liveDeliveries.length, liveDeliveries };
  });
}

function validateInboundOrigin(db, { appId, senderPrincipalId, originChannelRouteId }) {
  if (originChannelRouteId === undefined || originChannelRouteId === null) return null;
  if (typeof originChannelRouteId !== 'string' || originChannelRouteId.length === 0) {
    throw new TightbeamError('malformed_request', 'origin_channel_route_id must be a non-empty string when present', { field: 'origin_channel_route_id' });
  }
  const route = db
    .prepare('SELECT r.id FROM channel_routes r JOIN endpoints e ON e.id = r.endpoint_id WHERE r.id = ? AND r.app_id = ? AND r.principal_id = ? AND e.created_by_app_id = ? AND e.principal_id = r.principal_id')
    .get(originChannelRouteId, appId, senderPrincipalId, appId);
  if (!route) {
    throw new TightbeamError('permission_denied', 'origin_channel_route_id must belong to the authenticated application and sender principal', { field: 'origin_channel_route_id' });
  }
  return route.id;
}

function validateInboundTargetEndpoint(db, { inboundTargetEndpointId, conversationId, senderPrincipalId }) {
  if (inboundTargetEndpointId === undefined || inboundTargetEndpointId === null) return null;
  if (typeof inboundTargetEndpointId !== 'string' || inboundTargetEndpointId.length === 0) {
    throw new TightbeamError('malformed_request', 'inbound_target_endpoint_id must be a non-empty string when present', { field: 'inbound_target_endpoint_id' });
  }
  const endpoint = db
    .prepare(
      `SELECT e.id FROM endpoints e
         JOIN conversation_participants cp ON cp.principal_id = e.principal_id
        WHERE e.id = ? AND cp.conversation_id = ? AND e.principal_id != ? AND e.state != 'closed'`,
    )
    .get(inboundTargetEndpointId, conversationId, senderPrincipalId);
  if (!endpoint) {
    throw new TightbeamError('permission_denied', 'inbound_target_endpoint_id must name an open non-sender participant endpoint in the conversation', { field: 'inbound_target_endpoint_id' });
  }
  return endpoint.id;
}

function conversationSubjectForUnreadAdmission(db, conversationId) {
  try {
    const subject = JSON.parse(db.prepare('SELECT metadata FROM conversations WHERE id = ?').get(conversationId)?.metadata ?? '{}')?.subject;
    return typeof subject === 'string' && subject.trim().length > 0 ? subject : '(untitled thread)';
  } catch {
    return '(untitled thread)';
  }
}

/**
 * The final outbound admission fence lives inside the message transaction:
 * a concurrent inbound delivery either wins and blocks this commit before it
 * writes, or this commit wins and the later delivery remains unread.
 */
function rejectUnreadForActingEndpoint(db, { appId, senderPrincipalId, conversationId, effect, sendBranch }) {
  if (sendBranch !== 'agent' || typeof effect.sender_endpoint_id !== 'string') return;
  requireActingEndpoint(db, {
    appId,
    senderPrincipalId,
    senderEndpointId: effect.sender_endpoint_id,
    processGeneration: effect.process_generation,
  });
  const rows = db
    .prepare(
      `SELECT m.id AS message_id, sender.display_name AS sender_display_name
         FROM deliveries d
         JOIN messages m ON m.id = d.message_id
         LEFT JOIN principals sender ON sender.id = m.sender_principal_id
        WHERE d.endpoint_id = ? AND m.conversation_id = ?
          AND d.read_at IS NULL AND d.acknowledged_at IS NULL
        ORDER BY m.created_at DESC, d.id DESC`,
    )
    .all(effect.sender_endpoint_id, conversationId);
  if (rows.length === 0) return;
  const latest = rows[0];
  throw new TightbeamError('blocked_unread', 'an unread message must be read before sending on this thread', {
    conversation_id: conversationId,
    latest_unread_message_id: latest.message_id,
    subject: conversationSubjectForUnreadAdmission(db, conversationId),
    sender_display_name: latest.sender_display_name ?? 'the sender',
    unread_count: rows.length,
    safe_action: `${tightbeamCommandName()} agent inbox --unread`,
  });
}

/**
 * The sending endpoint a committed message recorded, read from its immutable
 * effect audit. Every agent-authored effect declares `sender_endpoint_id`; an
 * inbound (channel) message has none. The endpoint must still belong to the
 * message's sender principal, so a hand-edited audit cannot redirect a wake.
 */
function senderEndpointOfMessage(db, messageId, effectFilter = null) {
  const row = db
    .prepare(
      `SELECT m.sender_principal_id AS principal_id, m.created_at AS created_at, me.effect_payload AS payload
         FROM messages m
         JOIN message_effects me ON me.message_id = m.id
        WHERE m.id = ? AND (? IS NULL OR me.effect = ?)
        LIMIT 1`,
    )
    .get(messageId, effectFilter, effectFilter);
  if (!row) return null;
  let endpointId = null;
  try {
    endpointId = JSON.parse(row.payload)?.declaration?.sender_endpoint_id ?? null;
  } catch {
    endpointId = null;
  }
  if (typeof endpointId !== 'string' || endpointId.length === 0) return null;
  const owned = db.prepare('SELECT 1 FROM endpoints WHERE id = ? AND principal_id = ?').get(endpointId, row.principal_id);
  return owned ? { principal_id: row.principal_id, endpoint_id: endpointId, anchor_at: row.created_at } : null;
}

/**
 * Item 44: the exact endpoint each recipient principal's copy of this message
 * answers, derived only from committed work facts. First binding per
 * principal wins, in this order:
 *
 *   1. open_target   an `open` names its target endpoint; custody lands there,
 *                    so only it may be woken (anchor: now). Its rows stay
 *                    principal-wide so each window keeps a copy (F19).
 *   2. in_reply_to   the replied-to message's own sending endpoint.
 *   3. work_requester any effect on an existing chain returns to the endpoint
 *                    that opened the chain's root (the requester), read from
 *                    the root's open-effect audit.
 *
 * A recipient principal with no binding is principal-addressed and wakes at
 * most one endpoint (message_shared.mjs selectRecipientEndpoints). Reads
 * only; never throws for a missing fact — no binding is the fallback.
 */
function resolveEndpointBindings(db, { effect, inReplyToMessageId, now }) {
  const bindings = new Map();
  const bind = (principalId, endpointId, source, anchorAt, rows = 'exact') => {
    if (!principalId || !endpointId || bindings.has(principalId)) return;
    bindings.set(principalId, { endpoint_id: endpointId, source, anchor_at: anchorAt, rows });
  };
  if (effect.type === 'open') bind(effect.target_principal_id, effect.target_endpoint_id, 'open_target', now, 'principal');
  if (inReplyToMessageId) {
    const replied = senderEndpointOfMessage(db, inReplyToMessageId);
    if (replied) bind(replied.principal_id, replied.endpoint_id, 'in_reply_to', replied.anchor_at);
  }
  if (typeof effect.obligation_id === 'string') {
    const rootId = chainRootOf(db, effect.obligation_id);
    const opening = db.prepare("SELECT message_id FROM message_effects WHERE effect = 'open' AND obligation_id = ?").get(rootId);
    const requester = opening ? senderEndpointOfMessage(db, opening.message_id, 'open') : null;
    if (requester) bind(requester.principal_id, requester.endpoint_id, 'work_requester', requester.anchor_at);
  }
  return bindings;
}

// ---------------------------------------------------------------------
// The commit entry point.

/**
 * Validates addressing, sender authority, and the single effect declaration,
 * then commits message + effect audit + lifecycle mutation + delivery routes
 * in one transaction with idempotent replay semantics. Live-event fan-out
 * happens only after a durable commit. Returns `{ result }`; throws
 * TightbeamError with the existing vocabulary on every rejection path.
 *
 * Internal engine behind the future public `message.commit` operation
 * (task 2.2); it registers no operation itself.
 */
export function commitMessageWithEffect(context, connection, request) {
  if (!request || typeof request !== 'object') {
    throw new TightbeamError('malformed_request', 'request is required and must be an object');
  }
  const senderPrincipalId = request.sender_principal_id;
  if (typeof senderPrincipalId !== 'string' || senderPrincipalId.length === 0) {
    throw new TightbeamError('malformed_request', 'sender_principal_id is required and must be a string', { field: 'sender_principal_id' });
  }
  validateBody(request.body);
  validateIdempotencyKey(request.idempotency_key);
  validateMetadata(request.metadata);
  const effect = validateEffect(request.obligation_effect);

  const hasConversationId = typeof request.conversation_id === 'string' && request.conversation_id.length > 0;
  const hasDestination = typeof request.destination_principal_id === 'string' && request.destination_principal_id.length > 0;
  if (hasConversationId === hasDestination) {
    throw new TightbeamError('malformed_request', 'exactly one of conversation_id or destination_principal_id is required', { field: 'conversation_id' });
  }
  // Only an opening message may address an implicit direct conversation;
  // every other effect names state that already lives in an existing one.
  if (hasDestination && effect.type !== 'open') {
    throw new TightbeamError('malformed_request', `the "${effect.type}" effect requires an explicit conversation_id`, { field: 'conversation_id' });
  }

  const inReplyToMessageId = request.in_reply_to_message_id;
  if (inReplyToMessageId !== undefined && inReplyToMessageId !== null && (typeof inReplyToMessageId !== 'string' || inReplyToMessageId.length === 0)) {
    throw new TightbeamError('malformed_request', 'in_reply_to_message_id must be a string when present', { field: 'in_reply_to_message_id' });
  }
  const channelSelectors = normalizeChannelSelectors(request.channel_selectors);
  const awaitReply = request.await_reply;
  const requestedOriginChannelRouteId = request.origin_channel_route_id;
  const requestedInboundTargetEndpointId = request.inbound_target_endpoint_id;

  const sender = requirePrincipal(context.db, senderPrincipalId, 'sender_principal_id');
  const sendBranch = resolveSendBranch(connection, sender);
  if (!sendBranch) {
    throw new TightbeamError('permission_denied', 'send_as_principal or publish_inbound_messages is required for this sender');
  }
  if (
    sendBranch === 'agent'
    && effect.type === 'open'
    && (typeof effect.sender_endpoint_id !== 'string' || !Number.isInteger(effect.process_generation))
  ) {
    throw new TightbeamError('malformed_request', 'an agent-authored open effect requires sender_endpoint_id and process_generation', { field: 'obligation_effect.sender_endpoint_id' });
  }
  if (requestedOriginChannelRouteId !== undefined && requestedOriginChannelRouteId !== null && sendBranch !== 'inbound') {
    throw new TightbeamError('permission_denied', 'origin_channel_route_id is reserved for publish_inbound_messages', { field: 'origin_channel_route_id' });
  }
  if (requestedInboundTargetEndpointId !== undefined && requestedInboundTargetEndpointId !== null && sendBranch !== 'inbound') {
    throw new TightbeamError('permission_denied', 'inbound_target_endpoint_id is reserved for publish_inbound_messages', { field: 'inbound_target_endpoint_id' });
  }

  const hash = payloadHash({
    conversation_id: request.conversation_id ?? null,
    destination_principal_id: request.destination_principal_id ?? null,
    sender_principal_id: senderPrincipalId,
    in_reply_to_message_id: inReplyToMessageId ?? null,
    body: request.body,
    metadata: request.metadata ?? null,
    conversation_metadata: request.conversation_metadata ?? null,
    obligation_effect: effect,
    channel_selectors: channelSelectors,
    origin_channel_route_id: requestedOriginChannelRouteId ?? null,
    inbound_target_endpoint_id: requestedInboundTargetEndpointId ?? null,
    await_reply: awaitReply ?? false,
  });

  const preChecked = findIdempotentReplay(context.db, { appId: connection.appId, idempotencyKey: request.idempotency_key, hash });
  if (preChecked) {
    return { result: reconstructResult(context.db, { messageId: preChecked.id, conversationId: preChecked.conversation_id, idempotentReplay: true }) };
  }

  const startedAt = Date.now();
  const outcome = withIdempotency(context.db, { appId: connection.appId, idempotencyKey: request.idempotency_key, hash }, () =>
    withTransaction(context.db, () => {
      let conversationId;
      if (hasConversationId) {
        const conversation = loadConversationOrUnknown(context.db, request.conversation_id);
        requireParticipant(context.db, conversation.id, senderPrincipalId);
        if (conversation.closed_at !== null) {
          throw new TightbeamError('conversation_closed', 'conversation is closed');
        }
        conversationId = conversation.id;
      } else {
        validateConversationMetadata(request.conversation_metadata, 'conversation_metadata');
        const destination = requirePrincipal(context.db, request.destination_principal_id, 'destination_principal_id');
        if (effect.target_principal_id !== destination.id) {
          throw new TightbeamError('malformed_request', "destination_principal_id must equal the open effect's target_principal_id", { field: 'destination_principal_id' });
        }
        conversationId = resolveOrCreateDirectConversation(context.db, {
          appId: connection.appId,
          principalA: senderPrincipalId,
          principalB: destination.id,
          metadata: request.conversation_metadata,
        });
      }

      if (inReplyToMessageId) {
        const target = context.db.prepare('SELECT id, conversation_id FROM messages WHERE id = ?').get(inReplyToMessageId);
        if (!target || target.conversation_id !== conversationId) {
          throw new TightbeamError('malformed_request', `in_reply_to_message_id "${inReplyToMessageId}" is not a message in this conversation`, {
            field: 'in_reply_to_message_id',
          });
        }
      }

      const originChannelRouteId = validateInboundOrigin(context.db, {
        appId: connection.appId,
        senderPrincipalId,
        originChannelRouteId: requestedOriginChannelRouteId,
      });
      const inboundTargetEndpointId = validateInboundTargetEndpoint(context.db, {
        inboundTargetEndpointId: requestedInboundTargetEndpointId,
        conversationId,
        senderPrincipalId,
      });
      const channelRoutes = resolveChannelRoutes(context.db, {
        selectors: channelSelectors,
        conversationId,
        inReplyToMessageId,
      });
      const createsReplyWait = validateAwaitReply(context.db, {
        awaitReply,
        sendBranch,
        effect,
        channelRoutes,
        appId: connection.appId,
        senderPrincipalId,
      });

      rejectUnreadForActingEndpoint(context.db, {
        appId: connection.appId,
        senderPrincipalId,
        conversationId,
        effect,
        sendBranch,
      });

      const now = new Date().toISOString();
      stampOwnerIfUnset(context.db, conversationId, senderPrincipalId);
      const messageId = insertMessage(context.db, {
        conversationId,
        appId: connection.appId,
        senderPrincipalId,
        kind: 'commit',
        body: request.body,
        metadata: request.metadata,
        idempotencyKey: request.idempotency_key,
        hash,
        origin: sendBranch,
        originChannelRouteId,
        inReplyToMessageId,
      });

      const writerResult =
        APPLY_BY_TYPE[effect.type](context.db, {
          appId: connection.appId,
          senderPrincipalId,
          eventBus: context.eventBus,
          stateRoot: context.stateRoot,
          logger: context.logger,
          conversationId,
          messageId,
          effect,
          now,
        }) ?? {};

      // Delivery routing per transitions.yaml: acceptance wakes no one;
      // writers that route their own single wake (decline, CHILD-RESULT)
      // return their deliveries, so the ordinary participant fan-out must
      // not double-deliver; every other effect fans out normally. A staged
      // delivery-confirmed close fans out to every participant too, but only
      // the RETURN route to the principal that opened the work is typed: a
      // bystander's copy is an ordinary delivery, so it can be read, claimed,
      // and completed while staying inert for closure (INV-07).
      let liveDeliveries = [];
      let presentations = [];
      let replyWaitCount = 0;
      if (channelRoutes.length > 0) {
        const routeReason = writerResult.stageDeliveryConfirmedRootId !== undefined
          ? DELIVERY_CONFIRMED_ROUTE_REASON
          : writerResult.stageAcknowledgementRootId !== undefined
            ? ACK_PROVIDER_CONFIRMED_ROUTE_REASON
            : null;
        const sourceObligationId = writerResult.stageDeliveryConfirmedRootId ?? writerResult.stageAcknowledgementRootId ?? null;
        if (writerResult.stageTerminalOriginRouteId && (channelRoutes.length !== 1 || channelRoutes[0].id !== writerResult.stageTerminalOriginRouteId)) {
          throw new TightbeamError('obligation_conflict', 'a user terminal outcome must use its immutable origin route', { field: 'channel_selectors' });
        }
        if (writerResult.acknowledgementOriginRouteId && (channelRoutes.length !== 1 || channelRoutes[0].id !== writerResult.acknowledgementOriginRouteId)) {
          throw new TightbeamError('obligation_conflict', 'an acknowledgement must use its immutable user origin route', { field: 'channel_selectors' });
        }
        ({ liveDeliveries } = createDeliveriesForChannelRoutes(context.db, {
          conversationId,
          messageId,
          routes: channelRoutes,
          replyTargetEndpointId: effect.sender_endpoint_id ?? null,
          routeReason,
          sourceObligationId,
        }));
        if (createsReplyWait) {
          replyWaitCount = createReplyWaitsForAwaitedMessage(context.db, { messageId, now });
        }
      }
      if (writerResult.liveDeliveries !== undefined) {
        liveDeliveries.push(...writerResult.liveDeliveries);
        presentations.push(...(writerResult.presentations ?? []));
      } else if (channelRoutes.length === 0 && effect.type !== 'handoff.accept') {
        if (writerResult.stageAcknowledgementRootId !== undefined) {
          throw new TightbeamError('obligation_conflict', 'an acknowledgement requires its immutable user origin route', { field: 'channel_selectors' });
        }
        if (writerResult.stageTerminalOriginRouteId) {
          throw new TightbeamError('obligation_conflict', 'a user terminal outcome requires its immutable origin route', { field: 'channel_selectors' });
        }
        const stagedRootId = writerResult.stageDeliveryConfirmedRootId ?? null;
        ({ liveDeliveries, presentations } = createDeliveriesForRecipients(context.db, {
          conversationId,
          messageId,
          senderPrincipalId,
          recipientEndpointId: inboundTargetEndpointId,
          routeReason: stagedRootId === null ? null : DELIVERY_CONFIRMED_ROUTE_REASON,
          sourceObligationId: stagedRootId,
          routeReasonPrincipalId: writerResult.stageConfirmationRecipientPrincipalId ?? null,
          endpointBindings: resolveEndpointBindings(context.db, { effect, inReplyToMessageId, now }),
          resumeStaleAfterMs: context.resumeStaleAfterMs,
          stateRoot: context.stateRoot,
          logger: context.logger,
        }));
        if (stagedRootId !== null) {
          const eligibleCount = context.db
            .prepare('SELECT COUNT(*) AS n FROM deliveries WHERE message_id = ? AND route_reason = ? AND source_obligation_id = ?')
            .get(messageId, DELIVERY_CONFIRMED_ROUTE_REASON, stagedRootId).n;
          if (eligibleCount === 0) {
            // Fail closed rather than stage a resolution whose confirmation
            // could never arrive: the whole commit rolls back to zero rows.
            // Other participants receiving the report is not enough — the
            // requester itself must have a non-closed endpoint to confirm on.
            throw new TightbeamError('obligation_conflict', `root "${stagedRootId}" staged no eligible delivery; a delivery-confirmed report needs a non-closed endpoint on the principal that opened the work`, {
              field: 'obligation_effect.type',
            });
          }
        }
      }

      const tachyonArmed = armTachyonFromCommittedEffect(context.db, { sendBranch, effect });
      context.logger?.info({ event: 'tachyon_arming_result', armed: tachyonArmed });

      return {
        message_id: messageId,
        conversation_id: conversationId,
        liveDeliveries,
        presentations,
        created: writerResult.created ?? null,
        reply_wait_count: replyWaitCount,
      };
    }),
  );

  if (!outcome.idempotent_replay) {
    if (outcome.reply_wait_count > 0) replyContinuityDiagnostic(context.logger, 'obligation_created', { count: outcome.reply_wait_count });
    context.logger?.info({
      event: 'lifecycle_transition_committed',
      params: { effect: effect.type, conversation_id: outcome.conversation_id, message_id: outcome.message_id },
      result: 'committed',
      status: 'ok',
      latency_ms: Date.now() - startedAt,
    });
    pushLiveDeliveryEvents(context, { conversationId: outcome.conversation_id, liveDeliveries: outcome.liveDeliveries });
    for (const presentation of outcome.presentations) publishPresentation(context, presentation);
  }

  const result = reconstructResult(context.db, {
    messageId: outcome.message_id,
    conversationId: outcome.conversation_id,
    idempotentReplay: Boolean(outcome.idempotent_replay),
  });
  return { result };
}

// ---------------------------------------------------------------------
// Explicit recovery (Project Relay parent 2.3; transitions.yaml
// RECOVERY-RETRY / RECOVERY-SWITCH).
//
// Recovery is administrative: an authorized caller names the exact root,
// its exact generation, and ONE explicitly selected target endpoint at its
// exact observed process generation. Nothing here ever selects, ranks, or
// falls back to a target — a missing or unauthorized explicit target is a
// rejection, never a substitution (plan «Technical Approach 5»,
// Out-of-Bounds 4). retry demands that NO healthy open attempt exists;
// switch supersedes the prior open attempt and its whole stale subtree
// (resolution `superseded` pointing at the root, watches silently closed)
// before admitting the replacement. Both admit AT MOST one new attempt
// generation and clear root attention inside the same transaction.
//
// There is deliberately no message row and no message_effects row: these
// are close.cancelled-style administrative transitions. Their idempotency
// identity therefore lives in lifecycle_commands (schema v8) — canonical
// payload hash for replay-vs-collision, stored result for faithful
// reconstruction, UNIQUE(app_id, operation, idempotency_key) so concurrent
// competing commands arbitrate on the index inside the admitting
// transaction and exactly one wins.

function requireRecoveryString(request, field) {
  const value = request?.[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TightbeamError('malformed_request', `${field} is required and must be a non-empty string`, { field });
  }
  return value;
}

function requireRecoveryPositiveInteger(request, field) {
  const value = request?.[field];
  if (!Number.isInteger(value) || value < 1) {
    throw new TightbeamError('malformed_request', `${field} is required and must be a positive integer`, { field });
  }
  return value;
}

function validateRecoveryRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TightbeamError('malformed_request', 'request is required and must be an object');
  }
  return {
    root_obligation_id: requireRecoveryString(request, 'root_obligation_id'),
    root_generation: requireRecoveryPositiveInteger(request, 'root_generation'),
    target_endpoint_id: requireRecoveryString(request, 'target_endpoint_id'),
    target_process_generation: requireRecoveryPositiveInteger(request, 'target_process_generation'),
    idempotency_key: requireRecoveryString(request, 'idempotency_key'),
  };
}

/**
 * The root must be visible to this application through its accountable
 * principal — the same non-leaking isolation rule as close.cancelled: an
 * unknown and a foreign-app root are indistinguishable.
 */
function requireRecoverableRoot(db, { appId, rootObligationId }) {
  const root = db.prepare('SELECT * FROM obligations WHERE id = ?').get(rootObligationId);
  const ownerApp = root && db.prepare('SELECT created_by_app_id FROM principals WHERE id = ?').get(root.accountable_principal_id);
  if (!root || !ownerApp || ownerApp.created_by_app_id !== appId) {
    throw new TightbeamError('permission_denied', 'recovery is not granted for this root obligation');
  }
  if (root.role !== 'root') {
    throw new TightbeamError('malformed_request', 'root_obligation_id must name a root obligation', { field: 'root_obligation_id' });
  }
  return root;
}

/**
 * The explicitly selected target: visible to this application (a foreign
 * and a nonexistent endpoint are indistinguishable), not closed, a
 * participant of the root's conversation, and sitting at the exact observed
 * process generation. A runtime nobody ever adopted (NULL process
 * generation) can never be targeted.
 */
function requireAuthorizedRecoveryTarget(db, { appId, root, request }) {
  const target = db.prepare('SELECT * FROM endpoints WHERE id = ? AND created_by_app_id = ?').get(request.target_endpoint_id, appId);
  if (!target) {
    throw new TightbeamError('endpoint_unknown', `no endpoint "${request.target_endpoint_id}" is visible to this application`, { field: 'target_endpoint_id' });
  }
  if (target.state === 'closed') {
    throw new TightbeamError('obligation_conflict', 'the selected endpoint is closed; re-read the root before recovering', { field: 'target_endpoint_id' });
  }
  try {
    requireParticipant(db, root.conversation_id, target.principal_id);
  } catch {
    throw new TightbeamError('permission_denied', 'the selected endpoint belongs to a principal outside the root\'s conversation; recovery targets are never selected automatically', {
      field: 'target_endpoint_id',
    });
  }
  if (target.process_generation === null || target.process_generation !== request.target_process_generation) {
    throw new TightbeamError('obligation_conflict', `endpoint "${target.id}" is at process generation ${target.process_generation}, not ${request.target_process_generation}`, {
      field: 'target_process_generation',
    });
  }
  return target;
}

/**
 * Deletes the root's attention record inside the admitting recovery
 * transaction (schema v9 storage; plan «Technical Approach 5»: "Both
 * commands clear root attention in the admitting transaction"). The
 * structured event below is the observable proof that the hook ran inside
 * the admitting transaction; its name is a stable suite contract.
 */
export function clearRootAttention(db, { rootId, operation, logger }) {
  const deleted = db.prepare('DELETE FROM root_attention WHERE root_obligation_id = ?').run(rootId);
  logger?.debug({
    event: 'recovery_root_attention_clear_requested',
    params: { root_obligation_id: rootId, operation },
    result: deleted.changes > 0 ? 'cleared' : 'no_attention_recorded',
    status: 'ok',
  });
}

function findCommandReplay(db, { appId, operation, idempotencyKey, hash }) {
  const row = db
    .prepare('SELECT payload_hash, result_payload FROM lifecycle_commands WHERE app_id = ? AND operation = ? AND idempotency_key = ?')
    .get(appId, operation, idempotencyKey);
  if (!row) return null;
  if (row.payload_hash !== hash) {
    throw new TightbeamError('idempotency_collision', `idempotency_key "${idempotencyKey}" was already used with a different payload`, { field: 'idempotency_key' });
  }
  return JSON.parse(row.result_payload);
}

/**
 * The recovery route re-delivers the ROOT'S OPENING MESSAGE to the target
 * endpoint as a fresh typed pending row (schema v6 split the delivery
 * uniqueness fence precisely so recovery could do this), plus a resume
 * request whenever routeDelivery says the endpoint needs waking. Stale
 * active routes for the same pair are retired first so exactly one live
 * admission route exists per command.
 */
function createRecoveryRoute(db, { root, openingMessageId, target, operation, stateRoot, logger, now }) {
  const staleDeliveries = db.prepare("SELECT id FROM deliveries WHERE message_id = ? AND endpoint_id = ? AND state IN ('pending', 'claimed')").all(openingMessageId, target.id);
  for (const delivery of staleDeliveries) {
    db.prepare("UPDATE deliveries SET state = 'failed', updated_at = ? WHERE id = ?").run(now, delivery.id);
    db.prepare("UPDATE claims SET state = 'released', outcome = 'failed', released_at = ? WHERE resource_type = 'delivery' AND resource_id = ? AND state = 'claimed'").run(now, delivery.id);
  }
  const staleResumes = db
    .prepare("SELECT id FROM resume_requests WHERE endpoint_id = ? AND message_id = ? AND state IN ('pending', 'claimed')")
    .all(target.id, openingMessageId);
  for (const resume of staleResumes) {
    db.prepare("UPDATE resume_requests SET state = 'failed', updated_at = ? WHERE id = ?").run(now, resume.id);
    db.prepare("UPDATE claims SET state = 'released', outcome = 'failed', released_at = ? WHERE resource_type = 'resume_request' AND resource_id = ? AND state = 'claimed'").run(now, resume.id);
  }

  // Recovery has no listener ownership hand-off in this phase. In
  // particular, a principal-wide subscription is never proof that the
  // selected endpoint process is alive or owns this recovery delivery.
  const route = routeDelivery({ endpointState: target.state, launchMode: target.launch_mode, hasExactListener: false });
  // The closed-endpoint guard above means 'skip' is unreachable here.
  const deliveryId = generateId('delivery');
  db.prepare(
    "INSERT INTO deliveries (id, message_id, endpoint_id, state, route_reason, source_obligation_id, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)",
  ).run(deliveryId, openingMessageId, target.id, operation, root.id, now, now);
  refreshSessionWatermark({ stateRoot, sessionId: target.provider_session_id, deliveryId, logger });
  if (route === 'resume_dead' || route === 'resume_idle') {
    db.prepare(
      `INSERT INTO resume_requests
        (id, endpoint_id, principal_id, session_id, conversation_id, message_id, reason, authority_reference, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(
      generateId('resume_request'),
      target.id,
      target.principal_id,
      target.provider_session_id,
      root.conversation_id,
      openingMessageId,
      route === 'resume_dead' ? 'endpoint_dead' : 'endpoint_idle',
      target.authority_reference,
      now,
      now,
    );
  }
  return [];
}

function runRecoveryCommand(context, connection, rawRequest, operation) {
  const request = validateRecoveryRequest(rawRequest);

  const hash = payloadHash({
    operation,
    root_obligation_id: request.root_obligation_id,
    root_generation: request.root_generation,
    target_endpoint_id: request.target_endpoint_id,
    target_process_generation: request.target_process_generation,
  });
  const replayed = findCommandReplay(context.db, { appId: connection.appId, operation, idempotencyKey: request.idempotency_key, hash });
  if (replayed) {
    return { result: { ...replayed, idempotent_replay: true } };
  }

  const startedAt = Date.now();
  let outcome;
  try {
    outcome = withTransaction(context.db, () => {
      const root = requireRecoverableRoot(context.db, { appId: connection.appId, rootObligationId: request.root_obligation_id });
      requireOpen(root);
      fenceGeneration(root, request.root_generation);
      if (hasActiveStagedResolution(context.db, root.id)) {
        // A staged delivery-confirmed resolution is neither custody loss nor
        // a healthy owner problem: it closes through its exact delivery or
        // withdraws through close.cancelled. Recovery vocabulary does not
        // apply while the provider receipt is still pending.
        throw new TightbeamError('obligation_conflict', `root "${root.id}" has a terminal resolution staged for delivery confirmation; recovery cannot displace it`, {
          field: 'root_obligation_id',
        });
      }
      const target = requireAuthorizedRecoveryTarget(context.db, { appId: connection.appId, root, request });

      const priorOpenAttempt = context.db.prepare("SELECT id FROM obligations WHERE parent_id = ? AND role = 'attempt' AND status = 'open'").get(root.id);
      if (operation === 'recovery.retry' && priorOpenAttempt) {
        // transitions.yaml rejects healthy_owner_exists: retry never displaces
        // live custody — that is switch's explicit job.
        throw new TightbeamError('obligation_conflict', `root "${root.id}" already has a healthy open attempt; retry requires none — use recovery.switch to displace it explicitly`, {
          field: 'root_obligation_id',
        });
      }

      const now = new Date().toISOString();
      const commandId = generateId('lifecycle_command');

      // Switch fences the WHOLE stale subtree (prior attempt plus any open
      // delegation beneath it) as superseded by the root; retry reaches this
      // point only when no open attempt exists. The superseded variant points
      // at the still-open root, which keeps FK ordering trivially satisfied.
      if (operation === 'recovery.switch') {
        supersedeOpenDescendants(context.db, { closingNodeId: root.id, source: `recovery.switch:${commandId}`, now });
      }

      clearRootAttention(context.db, { rootId: root.id, operation, logger: context.logger });

      const attemptGeneration =
        context.db.prepare("SELECT COALESCE(MAX(generation), 0) AS n FROM obligations WHERE parent_id = ? AND role = 'attempt'").get(root.id).n + 1;
      const attemptId = generateId('obligation');
      context.db
        .prepare(
          `INSERT INTO obligations (id, conversation_id, parent_id, role, status, generation, accountable_principal_id, custodian_endpoint_id, created_at, updated_at)
           VALUES (?, ?, ?, 'attempt', 'open', ?, ?, ?, ?, ?)`,
        )
        .run(attemptId, root.conversation_id, root.id, attemptGeneration, target.principal_id, target.id, now, now);

      const resultPayload = {
        root_obligation_id: root.id,
        root_generation: root.generation,
        attempt_id: attemptId,
        attempt_generation: attemptGeneration,
        endpoint_id: target.id,
      };
      context.db
        .prepare(
          `INSERT INTO lifecycle_commands (id, app_id, operation, idempotency_key, payload_hash, root_obligation_id, result_payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(commandId, connection.appId, operation, request.idempotency_key, hash, root.id, JSON.stringify(resultPayload), now);

      const openingEffect = context.db.prepare("SELECT message_id FROM message_effects WHERE effect = 'open' AND obligation_id = ?").get(root.id);
      if (!openingEffect) {
        // Unreachable for roots this engine created (every open effect writes
        // its audit row in the same transaction) — fail closed rather than
        // route a recovery without its originating message.
        throw new TightbeamError('obligation_conflict', `root "${root.id}" has no opening message to route the recovery admission against`);
      }
      const liveDeliveries = createRecoveryRoute(context.db, {
        root,
        openingMessageId: openingEffect.message_id,
        target,
        operation,
        stateRoot: context.stateRoot,
        logger: context.logger,
        now,
      });

      return { result: resultPayload, conversationId: root.conversation_id, liveDeliveries };
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      // Two competing commands passed their pre-checks concurrently; the
      // ledger's UNIQUE index arbitrates and the loser rolls back whole.
      throw new TightbeamError('obligation_conflict', `another competing ${operation} admission won; re-read the root before recovering`, {
        field: 'root_obligation_id',
      });
    }
    throw error;
  }

  context.logger?.info({
    event: 'recovery_command_committed',
    params: { operation, root_obligation_id: outcome.result.root_obligation_id, attempt_id: outcome.result.attempt_id, attempt_generation: outcome.result.attempt_generation },
    result: 'committed',
    status: 'ok',
    latency_ms: Date.now() - startedAt,
  });
  pushLiveDeliveryEvents(context, { conversationId: outcome.conversationId, liveDeliveries: outcome.liveDeliveries });
  return { result: { ...outcome.result, idempotent_replay: false } };
}

/**
 * Admits a new open attempt generation under an OPEN root whose current
 * attempt has ALREADY lost custody (closed failed/superseded/cancelled).
 * Rejects while a healthy open attempt exists. Administrative transition:
 * no message row, identity in lifecycle_commands.
 */
export function recoveryRetry(context, connection, request) {
  return runRecoveryCommand(context, connection, request, 'recovery.retry');
}

/**
 * Admits a replacement attempt under an OPEN root by explicitly superseding
 * the prior open attempt and its stale subtree (policy allows displacing
 * healthy custody because the caller names it exactly). Races with
 * MSG-CLOSE-FULFILLED: whichever transaction commits first wins, and the
 * other's in-transaction guards reject it whole.
 */
export function recoverySwitch(context, connection, request) {
  return runRecoveryCommand(context, connection, request, 'recovery.switch');
}

// ---------------------------------------------------------------------
// Idempotent Stop (Project Relay parent 3.2; transitions.yaml STOP-REQUEST;
// plan «Technical Approach 4» and «API Design — session.stop»).
//
// Stop is reduced to OBLIGATION SAFETY: one authenticated transaction
// fences the exact endpoint (+observed process generation), evaluates the
// work it holds, and returns ONLY block or allow — no interaction mode,
// listener eligibility, deadline, or session disposition exists anywhere in
// the contract (REQ-04). What allows:
//
//   STOP-ALLOW-NONE      no open owned work at all;
//   STOP-ALLOW-ACCEPTED  open work bound to exact custody — the endpoint's
//                        own attempt or a delegation it accepted;
//   STOP-ALLOW-WATCHED   every offer it made still sits behind its
//                        committed awaiting_acceptance watch.
//
// What blocks is STOP-BLOCK-UNOWNED: an offered delegation whose durable
// watch is MISSING (the LC-S05 structural gap — every committed offer
// writes its watch atomically, so this shape means custody is about to
// exist with no recovery record anywhere). The bounded escape leaves the
// work open and marks attention on its root: one root_attention row per
// root carries the visibility mark AND the anti-wedge counter, exhausted
// after three blocked Stops, whereupon the same decision force-allows —
// work still open, evidence still visible — because a gate that can wedge
// a session forever is worse than no gate. An allow marks the endpoint
// idle in the same transaction; whether the adapter then exits or keeps
// waiting is the adapter's choice, never Tightbeam's.
//
// Replay identity rides the lifecycle_commands ledger like recovery: same
// key + same payload returns the ORIGINAL decision without touching any
// counter; a changed field collides.

const SESSION_STOP_OPERATION = 'session.stop';

/**
 * Transport outcome advances only the daemon-owned wait associated with the
 * exact outbound reply binding. A token digest is the durable record that
 * this route application accepted the binding; delivery truth alone never
 * makes an old adapter's send listener-eligible.
 */
export function advanceReplyWaitForDelivery(db, { deliveryId, outcome, now }) {
  const binding = db.prepare('SELECT id FROM reply_bindings WHERE source_delivery_id = ?').get(deliveryId);
  if (!binding) return null;
  const wait = db.prepare("SELECT * FROM reply_waits WHERE binding_id = ? AND state = 'pending_delivery'").get(binding.id);
  if (!wait) return null;
  const timestamp = now instanceof Date ? now.toISOString() : now;
  if (outcome === 'failed') {
    db.prepare("UPDATE reply_waits SET state = 'failed', terminal_reason = 'delivery_failed', updated_at = ?, closed_at = ? WHERE id = ? AND state = 'pending_delivery'").run(
      timestamp,
      timestamp,
      wait.id,
    );
    db.prepare("UPDATE listeners SET state = 'ended', terminal_reason = 'delivery_failed', updated_at = ?, ended_at = ? WHERE reply_wait_id = ? AND state IN ('parked', 'attached')").run(timestamp, timestamp, wait.id);
    return { reply_wait_id: wait.id, state: 'failed' };
  }
  const accepted = db.prepare('SELECT 1 FROM reply_binding_tokens WHERE binding_id = ? AND retired_at IS NULL LIMIT 1').get(binding.id);
  if (!accepted) return null;
  db.prepare("UPDATE reply_waits SET state = 'eligible', updated_at = ? WHERE id = ? AND state = 'pending_delivery'").run(timestamp, wait.id);
  return { reply_wait_id: wait.id, state: 'eligible' };
}

// The bounded anti-wedge budget. Three blocked Stops per root, then the
// gate force-allows — the same bound the legacy obligation column CHECKed,
// now carried by root_attention.stop_block_count's own CHECK.
const STOP_BLOCK_CAP = 3;

// The exact request contract — nothing more. A key outside it is refused,
// not silently dropped: a dropped field never reaches the replay hash, so
// {...request, park:true} would admit as the original command and forbidden
// concepts would be accepted-and-ignored. The same strict extra-field
// convention validateEffect enforces per effect family.
const SESSION_STOP_FIELDS = ['endpoint_id', 'process_generation', 'idempotency_key'];

function validateSessionStopRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TightbeamError('malformed_request', 'request is required and must be an object');
  }
  for (const key of Object.keys(request)) {
    if (!SESSION_STOP_FIELDS.includes(key)) {
      throw new TightbeamError('malformed_request', `session.stop declares "${key}", which is not part of its three-field request contract`, { field: key });
    }
  }
  const processGeneration =
    request.process_generation === undefined || request.process_generation === null
      ? null
      : requireRecoveryPositiveInteger(request, 'process_generation');
  return {
    endpoint_id: requireRecoveryString(request, 'endpoint_id'),
    process_generation: processGeneration,
    idempotency_key: requireRecoveryString(request, 'idempotency_key'),
  };
}

/**
 * The Stop actor is an ENDPOINT, not a principal: it must belong to this
 * application, be non-terminal, and sit at the exact observed process
 * generation. The fence rejects POSITIVE staleness only — a recorded
 * observation that contradicts the claim. A NULL recording means no
 * runtime has adopted the endpoint yet (wave 4 stamps adoption), so there
 * is no observed process to contradict anything with.
 */
function requireStopEndpoint(db, { appId, endpointId, processGeneration }) {
  const endpoint = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(endpointId);
  if (!endpoint || endpoint.created_by_app_id !== appId) {
    throw new TightbeamError('obligation_conflict', 'the stopping endpoint is not visible to this application', { field: 'endpoint_id' });
  }
  if (endpoint.state === 'closed') {
    throw new TightbeamError('identity_conflict', `endpoint "${endpoint.id}" is closed; a Stop cannot be decided for it`, { field: 'endpoint_id' });
  }
  if (endpoint.process_generation !== null && endpoint.process_generation !== processGeneration) {
    throw new TightbeamError('obligation_conflict', `endpoint "${endpoint.id}" is at process generation ${endpoint.process_generation}, not ${processGeneration}`, {
      field: 'process_generation',
    });
  }
  return endpoint;
}

/** True when ANY ancestor of `parentId` sits in this endpoint's custody. */
function ancestryHoldsCustodian(db, parentId, endpointId) {
  let current = parentId;
  for (let depth = 0; current && depth < 64; depth += 1) {
    const node = db.prepare('SELECT parent_id, custodian_endpoint_id FROM obligations WHERE id = ?').get(current);
    if (!node) return false;
    if (node.custodian_endpoint_id === endpointId) return true;
    current = node.parent_id;
  }
  return false;
}

function chainRootOf(db, obligationId) {
  let current = obligationId;
  for (let depth = 0; depth < 64; depth += 1) {
    const row = db.prepare('SELECT id, parent_id FROM obligations WHERE id = ?').get(current);
    if (!row || !row.parent_id) return current;
    current = row.parent_id;
  }
  return current;
}

/**
 * The offers THIS endpoint made whose acceptance window has NO committed
 * awaiting_acceptance watch — the only unsafe shape the forward graph can
 * hold (STOP-BLOCK-UNOWNED).
 */
function findUntrackedOffers(db, endpointId) {
  const offers = db
    .prepare("SELECT id, conversation_id, parent_id FROM obligations WHERE role = 'delegation' AND status = 'open' AND custodian_endpoint_id IS NULL")
    .all();
  const untracked = [];
  for (const offer of offers) {
    if (!ancestryHoldsCustodian(db, offer.parent_id, endpointId)) continue;
    const watched = db.prepare("SELECT 1 FROM handoff_watches WHERE delegation_id = ? AND state = 'awaiting_acceptance'").get(offer.id);
    if (!watched) untracked.push({ id: offer.id, conversation_id: offer.conversation_id });
  }
  return untracked;
}

/** Bounded diagnostic naming what blocks the stop; the hook feeds stderr to the model. */
function renderUnsafeReason(untracked) {
  const listed = untracked
    .slice(0, 10)
    .map((offer) => `  - ${offer.id} (conversation ${offer.conversation_id})`)
    .join('\n');
  const more = untracked.length > 10 ? `\n  ...and ${untracked.length - 10} more` : '';
  return (
    `[tightbeam] Cannot stop: ${untracked.length} offered handoff(s) have no durable acceptance watch:\n${listed}${more}\n` +
    'The delegated work is tracked nowhere durable. Re-offer it through message.commit handoff.offer or cancel it explicitly, then stop again.'
  );
}

function recordBlockAttention(db, { rootId, now, listenerGeneration = null }) {
  const attentionSource = listenerGeneration === null
    ? 'session.stop.blocked'
    : `session.stop.blocked.listener:${listenerGeneration}`;
  const existing = db.prepare('SELECT attention_source FROM root_attention WHERE root_obligation_id = ?').get(rootId);
  // A continuation can re-enter Stop after the listener has delivered the
  // same turn. Charge that delivered listener generation once, rather than
  // spending the root's bounded escape budget on every hook re-entry.
  if (listenerGeneration !== null && existing?.attention_source === attentionSource) return false;
  db.prepare(
    `INSERT INTO root_attention (root_obligation_id, stop_block_count, attention_source, first_marked_at, last_block_at, updated_at)
       VALUES (?, 1, ?, ?, ?, ?)
       ON CONFLICT(root_obligation_id) DO UPDATE SET
         stop_block_count = stop_block_count + 1,
         attention_source = excluded.attention_source,
         last_block_at = excluded.last_block_at,
         updated_at = excluded.updated_at`,
  ).run(rootId, attentionSource, now, now, now);
  return true;
}

function markEndpointIdle(db, { endpointId, processGeneration, now }) {
  return db
    .prepare("UPDATE endpoints SET state = 'idle', updated_at = ? WHERE id = ? AND process_generation IS ? AND state != 'retiring'")
    .run(now, endpointId, processGeneration).changes === 1;
}

function activeListenerForStop(db, { endpointId, processGeneration }) {
  return db
    .prepare(
      `SELECT listener.* FROM listeners listener
        WHERE listener.endpoint_id = ? AND listener.process_generation = ? AND listener.state IN ('parked', 'attached', 'waking')
        ORDER BY listener_generation DESC
        LIMIT 1`,
    )
    .get(endpointId, processGeneration);
}

function oldestUnreadDeliveryForStop(db, { endpointId }) {
  return db
    .prepare(
      `SELECT d.id AS delivery_id, d.message_id
         FROM deliveries d
        WHERE d.endpoint_id = ? AND d.state != 'failed' AND d.read_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM listener_presentations p
             WHERE p.target_delivery_id = d.id AND p.state = 'pending'
          )
        ORDER BY d.created_at ASC, d.id ASC
        LIMIT 1`,
    )
    .get(endpointId);
}

function replyWaitForDelivery(db, { endpointId, processGeneration, deliveryId }) {
  return db
    .prepare(
      `SELECT rw.*
         FROM reply_waits rw
         JOIN reply_binding_events event ON event.binding_id = rw.binding_id
         JOIN deliveries d ON d.message_id = event.committed_message_id
        WHERE rw.endpoint_id = ? AND rw.process_generation = ? AND d.id = ?
          AND rw.state IN ('pending_delivery', 'eligible')
        ORDER BY rw.created_at ASC, rw.id ASC`,
    )
    .get(endpointId, processGeneration, deliveryId);
}

function oldestParkableWaitForStop(db, { endpointId, processGeneration }) {
  return db
    .prepare(
      `SELECT rw.*
         FROM reply_waits rw
        WHERE rw.endpoint_id = ? AND rw.process_generation = ? AND rw.state IN ('pending_delivery', 'eligible')
        ORDER BY rw.created_at ASC, rw.id ASC
        LIMIT 1`,
    )
    .get(endpointId, processGeneration);
}

function parkResult(listener, replyWaitState, endpoint) {
  return {
    decision: 'park',
    obligation_ids: [],
    endpoint_id: endpoint.id,
    provider_session_id: endpoint.provider_session_id,
    process_generation: listener.process_generation,
    listener_id: listener.id,
    listener_generation: listener.listener_generation,
    lease_expires_at: listener.lease_expires_at,
    park_deadline_at: listener.park_deadline_at,
    reply_wait_state: replyWaitState,
  };
}

function createParkedListener(db, { endpoint, wait = null, now }) {
  const currentGeneration = db.prepare('SELECT MAX(listener_generation) AS n FROM listeners WHERE endpoint_id = ?').get(endpoint.id)?.n ?? 0;
  const nowMs = Date.parse(now);
  const listener = {
    id: generateId('listener'),
    process_generation: endpoint.process_generation,
    listener_generation: currentGeneration + 1,
    lease_expires_at: new Date(nowMs + REPLY_BINDING_POLICY.listenerLeaseMs).toISOString(),
    park_deadline_at: new Date(nowMs + REPLY_BINDING_POLICY.maxParkMs).toISOString(),
  };
  db.prepare(
    `INSERT INTO listeners
       (id, reply_wait_id, endpoint_id, provider_session_id, process_generation, listener_generation, state,
        lease_expires_at, park_deadline_at, terminal_reason, created_at, updated_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, 'parked', ?, ?, NULL, ?, ?, NULL)`,
  ).run(
    listener.id,
    wait?.id ?? null,
    endpoint.id,
    endpoint.provider_session_id,
    endpoint.process_generation,
    listener.listener_generation,
    listener.lease_expires_at,
    listener.park_deadline_at,
    now,
    now,
  );
  return listener;
}

function lastDeliveredListenerGeneration(db, { endpointId, processGeneration }) {
  return db
    .prepare(
      `SELECT MAX(l.listener_generation) AS listener_generation
         FROM listeners l
         JOIN listener_presentations p ON p.listener_id = l.id AND p.listener_generation = l.listener_generation
        WHERE l.endpoint_id = ? AND l.process_generation = ? AND p.state = 'acked'`,
    )
    .get(endpointId, processGeneration)?.listener_generation ?? null;
}

// Item 42 C: the process that owns the row was started by the daemon's
// resumer — its registration stamped the launch token the resumer minted —
// so it is a headless turn even when the SESSION is interactive (a closed
// pane resumed in the background keeps launch_mode interactive). A headless
// process must not park its Stop for hours; it finishes, exits, and the
// owner reconciler turns that exit into the next resumable state.
function isHeadlessDaemonProcess(endpoint) {
  return typeof endpoint.owner_launch_token === 'string' && endpoint.owner_launch_token.length > 0;
}

function parkEligibleEndpoint(db, { endpoint, processGeneration, now, obligationIds = [] }) {
  if (endpoint.state === 'retiring') return { decision: 'allow', obligation_ids: obligationIds };
  if (endpoint.launch_mode === 'non_interactive' || isHeadlessDaemonProcess(endpoint) || !Number.isInteger(processGeneration)) {
    markEndpointIdle(db, { endpointId: endpoint.id, processGeneration, now });
    return { decision: 'allow', obligation_ids: obligationIds };
  }
  if (!isTachyonArmedForGeneration(endpoint, processGeneration)) {
    endUnsupportedTachyonListeners(db, { endpointId: endpoint.id, processGeneration, now });
    markEndpointIdle(db, { endpointId: endpoint.id, processGeneration, now });
    return { decision: 'allow', obligation_ids: obligationIds };
  }

  const existingListener = activeListenerForStop(db, { endpointId: endpoint.id, processGeneration });
  if (existingListener) {
    markEndpointIdle(db, { endpointId: endpoint.id, processGeneration, now });
    return { ...parkResult(existingListener, db.prepare('SELECT state FROM reply_waits WHERE id = ?').get(existingListener.reply_wait_id)?.state ?? null, endpoint), obligation_ids: obligationIds };
  }

  const delivery = oldestUnreadDeliveryForStop(db, { endpointId: endpoint.id });
  const wait = delivery
    ? replyWaitForDelivery(db, { endpointId: endpoint.id, processGeneration, deliveryId: delivery.delivery_id })
    : oldestParkableWaitForStop(db, { endpointId: endpoint.id, processGeneration });
  const listener = createParkedListener(db, { endpoint, wait, now });
  if (delivery) {
    createPendingPresentation(db, { listener, messageId: delivery.message_id, deliveryId: delivery.delivery_id, now });
    db.prepare("UPDATE listeners SET state = 'waking' WHERE id = ? AND state = 'parked'").run(listener.id);
  }
  markEndpointIdle(db, { endpointId: endpoint.id, processGeneration, now });
  return { ...parkResult(listener, wait?.state ?? null, endpoint), obligation_ids: obligationIds };
}

function runSessionStop(context, connection, rawRequest) {
  const request = validateSessionStopRequest(rawRequest);

  const hash = payloadHash({
    operation: SESSION_STOP_OPERATION,
    endpoint_id: request.endpoint_id,
    process_generation: request.process_generation,
  });
  const replayed = findCommandReplay(context.db, { appId: connection.appId, operation: SESSION_STOP_OPERATION, idempotencyKey: request.idempotency_key, hash });
  if (replayed) {
    return { result: { ...replayed, idempotent_replay: true } };
  }

  const startedAt = Date.now();
  let outcome;
  const replyDiagnosticOutcomes = [];
  try {
    outcome = withTransaction(context.db, () => {
      const endpoint = requireStopEndpoint(context.db, {
        appId: connection.appId,
        endpointId: request.endpoint_id,
        processGeneration: request.process_generation,
      });
      const untracked = findUntrackedOffers(context.db, endpoint.id);
      const now = new Date().toISOString();

      let resultPayload;
      if (untracked.length === 0) {
        resultPayload = parkEligibleEndpoint(context.db, { endpoint, processGeneration: request.process_generation, now });
        replyDiagnosticOutcomes.push(
          resultPayload.decision === 'park'
            ? 'parked'
            : endpoint.state === 'retiring'
              ? 'retiring_preserved'
              : endpoint.launch_mode === 'non_interactive'
                ? 'noninteractive_bypass'
                : !isTachyonArmedForGeneration(endpoint, request.process_generation)
                  ? 'unarmed_generation'
                  : 'noninteractive_bypass',
        );
      } else {
        const roots = [...new Set(untracked.map((offer) => chainRootOf(context.db, offer.id)))];
        const counts = roots.map(
          (rootId) => ({ rootId, count: context.db.prepare('SELECT stop_block_count AS n FROM root_attention WHERE root_obligation_id = ?').get(rootId)?.n ?? 0 }),
        );

        if (counts.every((entry) => entry.count >= STOP_BLOCK_CAP)) {
          // Bounded escape exhausted: leave the work open and visible and
          // allow the stop rather than wedge the session forever.
          for (const entry of counts) {
            context.db.prepare('UPDATE root_attention SET last_block_at = ?, updated_at = ? WHERE root_obligation_id = ?').run(now, now, entry.rootId);
          }
          resultPayload = parkEligibleEndpoint(context.db, {
            endpoint,
            processGeneration: request.process_generation,
            now,
            obligationIds: untracked.map((offer) => offer.id),
          });
        } else {
          for (const entry of counts) {
            if (entry.count >= STOP_BLOCK_CAP) continue;
            recordBlockAttention(context.db, {
              rootId: entry.rootId,
              now,
              listenerGeneration: lastDeliveredListenerGeneration(context.db, { endpointId: endpoint.id, processGeneration: request.process_generation }),
            });
          }
          resultPayload = { decision: 'block', obligation_ids: untracked.map((offer) => offer.id), reason: renderUnsafeReason(untracked) };
        }
      }

      context.db
        .prepare(
          `INSERT INTO lifecycle_commands (id, app_id, operation, idempotency_key, payload_hash, root_obligation_id, result_payload, created_at)
           VALUES (?, ?, 'session.stop', ?, ?, NULL, ?, ?)`,
        )
        .run(generateId('lifecycle_command'), connection.appId, request.idempotency_key, hash, JSON.stringify(resultPayload), now);

      return resultPayload;
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      // Two competing Stops presented one key; the ledger's UNIQUE index
      // picked a winner mid-transaction. Answer the loser with the winner's
      // decision instead of failing the turn.
      const winner = findCommandReplay(context.db, { appId: connection.appId, operation: SESSION_STOP_OPERATION, idempotencyKey: request.idempotency_key, hash });
      if (winner) return { result: { ...winner, idempotent_replay: true } };
      throw new TightbeamError('obligation_conflict', 'another competing session.stop admission won; retry the stop', { field: 'idempotency_key' });
    }
    throw error;
  }

  const forced = outcome.decision === 'allow' && outcome.obligation_ids.length > 0;
  for (const replyDiagnosticOutcome of replyDiagnosticOutcomes) replyContinuityDiagnostic(context.logger, replyDiagnosticOutcome);
  context.logger?.info({
    event: 'session_stop_decided',
    params: { endpoint_id: request.endpoint_id, decision: outcome.decision, escaped: outcome.obligation_ids.length },
    result: forced ? 'force_allowed' : outcome.decision === 'block' ? 'blocked' : 'allowed',
    status: 'ok',
    latency_ms: Date.now() - startedAt,
  });
  return { result: { ...outcome, idempotent_replay: false } };
}

/**
 * Decides Stop as obligation safety for one exact endpoint: block with the
 * bounded reason, or allow with the endpoint idled. Administrative
 * transition: no message row, identity in lifecycle_commands.
 */
export function sessionStop(context, connection, request) {
  return runSessionStop(context, connection, request);
}
