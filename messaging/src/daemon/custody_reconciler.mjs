// The shared custody-loss reconciler (Project Relay parent 4.1, subtask
// 4.1.1; docs/lifecycle-control-plane/transitions.yaml ENDPOINT-DEATH;
// plan «Technical Approach 5» "Factor the resumer's exact-attempt failure
// classification into a shared reconciler").
//
// ONE decision path for BOTH authorized death evidence sources:
//
//   - supervised child error/exit and terminal lease exhaustion, wired from
//     the resumer tick with the exact-custody capture taken at launch time;
//   - authorized `endpoint.state.set(dead)` naming the observed process
//     generation (ops/endpoint_state_set.mjs).
//
// One transaction per endpoint decides everything (INV-12/INV-13/INV-14):
// mark the endpoint dead → close ONLY the exact open attempt/delegation
// rows the evidence captured as `failed` (death never cascades to
// descendants — deliberate-close cascade stays a different path) → leave
// the root open → close EVERY closed delegation's handoff watch with
// outcome child_failed → route ONE typed immediate-parent custody-loss
// delivery PER closed delegation (route_reason 'endpoint.custody_lost',
// source_obligation_id = that failed delegation, re-delivering its own
// offer message) OR a root_attention record for a chain with no routable
// parent — never both for one chain, and never two of either.
//
// The notification duty is per CHILD, not per death
// (docs/lifecycle-control-plane/contract.md §3.6). One endpoint can hold
// several accepted delegations, and its death fails all of them: each owes
// its own wake and its own watch reference, and a root keeps its attention
// record while ANY unit it holds lacks a durable parent delivery — a
// sibling's successful route covers only the sibling.
//
// Fencing (plan «Risks»: "Require endpoint process generation and
// obligation generation together"):
//
//   - Process fence. Evidence names the process generation it observed;
//     a recorded generation that contradicts it (both non-null, unequal)
//     means a NEWER runtime owns the endpoint, so the evidence is stale
//     and writes NOTHING. A NULL recording means no runtime ever adopted
//     the endpoint, so there is no newer custodian to protect — the same
//     transitional positive-staleness-only rule session.stop's fence uses
//     until wave-4 adoption stamps every row. Supervised launches capture
//     the PREDICTED next generation (COALESCE(recorded, 0) + 1): exactly
//     the value an adopting or reviving runtime will stamp, which makes a
//     normal first-spawn exit current and any pre-adoption exit admissible
//     against the NULL recording, while an old exit arriving after a newer
//     adoption names a lower generation and fences inert.
//
//   - Launch-ownership fence (schema v12, the launch-collision repair).
//     Generation equality cannot separate two supervised launches of one
//     endpoint made before either registered: both captures legitimately
//     predict the same next generation. Neither can the owner epoch —
//     both siblings read the same PRE-registration epoch, so fencing on it
//     silences the launch that went on to register just as thoroughly as
//     the zombie, and the custody that launch really owned would stay open
//     forever. The endpoint row instead records WHICH launch owns it, and
//     supervised evidence carries two facts about that column: the token
//     of the launch that produced the evidence, and the token the row held
//     when the launch captured its custody. Positive staleness only, like
//     the process fence: evidence is inert when the recorded token is
//     NEITHER this launch's own (it registered and owns the row) NOR the
//     one the capture saw (nothing has re-stamped the row since). A losing
//     sibling satisfies neither — the winner's registration replaced the
//     token it captured — while a launch whose session never re-registered
//     still speaks for custody nobody else has taken. This runs BESIDE the
//     generation rule, never instead of it.
//
//   - Owner-epoch fence (schema v11), the fallback for a row whose owner
//     arrived without a token (an interactive session, an
//     application-registered target). Those seams leave nothing to compare
//     tokens on, so the capture is checked against the epoch it launched
//     under: any registration since advanced it and makes the capture
//     stale. Evidence that owns the recorded token skips this rule by
//     construction — its pre-registration epoch is the expected shape of
//     owning the row. Authorized state.set evidence carries no capture
//     instant (it is decided against the live rows), so it passes none of
//     these values and the generation fence does all its work.
//   - Obligation fence. Captured nodes are re-checked under a full CAS
//     (id + status='open' + custodian_endpoint_id + generation). A retry
//     or switch replaces the attempt ROW, so late evidence for the old
//     custody finds it closed and drops out; duplicate evidence across
//     restarts finds everything decided and becomes a zero-write no-op.
//     A terminal result that won the race leaves nothing open either —
//     the death evidence loses whole and clean.
//
// Obligation age, acknowledgement age, endpoint silence, and a missing
// listener have NO evidence shape here at all: nothing may call this
// reconciler without positive evidence, and the endpoint.state.set gate
// rejects generation-less dead asserts from driving reconciliation.

import { withTransaction } from './db.mjs';
import { createParentResultDelivery, pushLiveDeliveryEvents } from './ops/message_shared.mjs';
import { findOfferMessageId } from './watch_reconciler.mjs';

export const CUSTODY_LOST_ROUTE_REASON = 'endpoint.custody_lost';
export const CUSTODY_ATTENTION_SOURCE = 'endpoint.custody_lost';

// The failed-resolution vocabulary for custody loss: reason is constant,
// source carries the typed evidence kind plus the endpoint, satisfying the
// schema's failed variant (reason AND source together, nothing else).
export const DEATH_RESOLUTION_REASON = 'endpoint_death';

/** Walks any attempt/delegation up to its chain's root obligation id. */
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
 * Re-resolves the evidence's captured custody UNDER THE DECISION
 * TRANSACTION. Without a capture (authorized state.set evidence) the
 * currently-open owned nodes ARE the observation; with one (supervised
 * evidence) each captured node must STILL sit open in this endpoint's
 * custody at the SAME obligation generation, or it drops out.
 */
function resolveCapturedNodes(db, { endpointId, capturedNodes }) {
  const candidates =
    capturedNodes ??
    db.prepare("SELECT id, generation FROM obligations WHERE custodian_endpoint_id = ? AND status = 'open'").all(endpointId);
  const surviving = [];
  for (const node of candidates) {
    const stillOwned = db
      .prepare("SELECT id FROM obligations WHERE id = ? AND status = 'open' AND custodian_endpoint_id = ? AND generation = ?")
      .get(node.id, endpointId, node.generation);
    if (stillOwned) surviving.push({ id: node.id, generation: node.generation });
  }
  return surviving;
}

/** One visibility mark per root; the Stop anti-wedge counter is untouched. */
function markRootAttention(db, { rootId, now }) {
  const nowIso = now instanceof Date ? now.toISOString() : now;
  db.prepare(
    `INSERT INTO root_attention (root_obligation_id, stop_block_count, attention_source, first_marked_at, last_block_at, updated_at)
       VALUES (?, 1, '${CUSTODY_ATTENTION_SOURCE}', ?, ?, ?)
       ON CONFLICT(root_obligation_id) DO UPDATE SET
         attention_source = excluded.attention_source,
         last_block_at = excluded.last_block_at,
         updated_at = excluded.updated_at`,
  ).run(rootId, nowIso, nowIso, nowIso);
}

/**
 * Routes ONE closed delegation's custody-loss wake to its own immediate
 * parent, inside the decision transaction, or reports null when this chain
 * has no durable route: no offer audit to re-deliver (a broken chain may
 * never abort the custody decision), no parent custodian, or a parent that
 * can no longer drain a delivery. A null return is what sends this chain to
 * its attention fallback — never a silent loss.
 */
function routeCustodyLossToParent(db, context, node) {
  // The wake re-delivers real history: the offer message that created THIS
  // delegation's watch.
  let offerMessageId = null;
  try {
    offerMessageId = findOfferMessageId(db, node.id);
  } catch {
    offerMessageId = null;
  }
  if (!offerMessageId) return null;

  const parentEndpointId = db.prepare('SELECT custodian_endpoint_id AS id FROM obligations WHERE id = ?').get(node.parent_id)?.id ?? null;
  if (!parentEndpointId) return null;

  const routed = createParentResultDelivery(db, {
    conversationId: node.conversation_id,
    messageId: offerMessageId,
    senderPrincipalId: node.accountable_principal_id,
    parentEndpointId,
    routeReason: CUSTODY_LOST_ROUTE_REASON,
    sourceObligationId: node.id,
    eventBus: context.eventBus,
    stateRoot: context.stateRoot,
    logger: context.logger,
    ifParentExists: true,
  });
  // Routed means a durable delivery ROW exists. A parent that cannot drain
  // a wake (closed or gone) leaves none, and this chain's visibility falls
  // back to its attention record instead.
  const parentDeliveryId = db.prepare('SELECT id FROM deliveries WHERE message_id = ? AND endpoint_id = ?').get(offerMessageId, parentEndpointId)?.id ?? null;
  if (!parentDeliveryId) return null;

  // Each watch references its OWN wake, written under a CAS so a replayed
  // decision cannot point one watch at a second delivery (the column is
  // UNIQUE: exactly-once evidence, per child).
  db.prepare('UPDATE handoff_watches SET parent_delivery_id = ? WHERE delegation_id = ? AND parent_delivery_id IS NULL').run(parentDeliveryId, node.id);
  return {
    route: { kind: 'parent_delivery', delivery_id: parentDeliveryId, source_obligation_id: node.id },
    liveDeliveries: routed.liveDeliveries ?? [],
  };
}

const NOOP = (reason) => ({ decided: false, reason, closed: [], route: null, routes: [], liveDeliveries: [] });

/**
 * Decides one positive custody-loss observation, or reports a fenced /
 * idempotent no-op. Everything durable rides ONE transaction; only the
 * best-effort live-event push happens after commit. Never throws for a
 * fenced or already-decided observation — those are counted no-ops.
 */
export function reconcileCustodyLoss(context, { endpointId, evidenceKind, observedProcessGeneration = null, observedOwnerEpoch = null, observedOwnerToken = null, capturedOwnerToken = null, capturedNodes = null, now = new Date() }) {
  const db = context.db;

  let outcome;
  try {
    outcome = withTransaction(db, () => {
      const endpoint = db.prepare('SELECT id, state, process_generation, owner_epoch, owner_launch_token FROM endpoints WHERE id = ?').get(endpointId);
      if (!endpoint) return NOOP('endpoint_unknown');
      if (endpoint.state === 'closed') return NOOP('endpoint_closed');

      // Process fence: positive staleness only. A NULL recording has no
      // observed process to contradict anything (session.stop's rule).
      const recorded = endpoint.process_generation;
      if (recorded !== null && observedProcessGeneration !== null && observedProcessGeneration !== recorded) {
        context.logger?.info({
          event: 'TEMP DEATH custody_loss_fenced_stale_generation',
          params: { endpoint_id: endpointId, evidence_kind: evidenceKind, observed_process_generation: observedProcessGeneration, recorded_process_generation: recorded },
          result: 'inert_zero_writes',
          status: 'ok',
        });
        return NOOP('stale_generation');
      }

      // Launch-ownership fence, positive staleness only. A launch speaks
      // for the endpoint while it either OWNS the recorded regime (its own
      // registration stamped the token) or nothing has re-stamped the
      // column since it looked. Anything else means another launch took
      // ownership in between, and this evidence is that launch's loser.
      const recordedToken = endpoint.owner_launch_token ?? null;
      const ownsRecordedRegime = observedOwnerToken !== null && observedOwnerToken === recordedToken;
      if (observedOwnerToken !== null && !ownsRecordedRegime && recordedToken !== capturedOwnerToken) {
        context.logger?.info({
          event: 'TEMP DEATH custody_loss_fenced_stale_owner_token',
          params: {
            endpoint_id: endpointId,
            evidence_kind: evidenceKind,
            observed_owner_token: observedOwnerToken,
            captured_owner_token: capturedOwnerToken,
            recorded_owner_token: recordedToken,
          },
          result: 'inert_zero_writes',
          status: 'ok',
        });
        return NOOP('stale_owner_token');
      }

      // Owner-epoch fence, for a row whose owner left no token to compare.
      // Equality is required even against a NULL-generation recording —
      // every row has an epoch, so a stale capture can never pass merely
      // because nothing stamped the generation it predicted. Evidence that
      // owns the recorded token is exempt: its capture necessarily predates
      // the registration that advanced the epoch, which is exactly what
      // owning the row looks like.
      const recordedEpoch = endpoint.owner_epoch ?? 0;
      if (!ownsRecordedRegime && observedOwnerEpoch !== null && observedOwnerEpoch !== recordedEpoch) {
        context.logger?.info({
          event: 'TEMP DEATH custody_loss_fenced_stale_owner_epoch',
          params: { endpoint_id: endpointId, evidence_kind: evidenceKind, observed_owner_epoch: observedOwnerEpoch, recorded_owner_epoch: recordedEpoch },
          result: 'inert_zero_writes',
          status: 'ok',
        });
        return NOOP('stale_owner_epoch');
      }

      const surviving = resolveCapturedNodes(db, { endpointId, capturedNodes });
      // Authorized state.set evidence always records the terminal state
      // fact even with nothing to close; supervised evidence without open
      // owned work is a pure no-op (the ordinary finished-exit shape), as
      // is any duplicate observation that finds the decision already made.
      if (surviving.length === 0 && !(evidenceKind === 'endpoint_state_dead' && endpoint.state !== 'dead')) {
        context.logger?.debug({
          event: 'TEMP DEATH custody_loss_noop_already_decided',
          params: { endpoint_id: endpointId, evidence_kind: evidenceKind, surviving: surviving.length },
          result: 'inert_zero_writes',
          status: 'ok',
        });
        return NOOP('no_owned_open_work');
      }

      const nowIso = now.toISOString();
      if (endpoint.state !== 'dead') {
        db.prepare("UPDATE endpoints SET state = 'dead', updated_at = ? WHERE id = ? AND state <> 'closed'").run(nowIso, endpointId);
      }

      const closed = [];
      for (const node of surviving) {
        const failed = db
          .prepare(
            `UPDATE obligations
                SET status = 'closed', resolution = 'failed', resolution_reason = ?, resolution_source = ?, updated_at = ?
              WHERE id = ? AND status = 'open' AND custodian_endpoint_id = ? AND generation = ?`,
          )
          .run(DEATH_RESOLUTION_REASON, `${evidenceKind}:${endpointId}`, nowIso, node.id, endpointId, node.generation);
        if (failed.changes === 1) closed.push(node.id);
      }

      // Watches belong to delegations: every closed delegation's armed
      // watch closes truthfully as child_failed (its child can never
      // produce a result now), and each one is an independent custody unit
      // owed its own parent notification.
      const closedDelegations = [];
      for (const nodeId of closed) {
        const node = db.prepare('SELECT id, role, parent_id, conversation_id, accountable_principal_id FROM obligations WHERE id = ?').get(nodeId);
        if (node.role !== 'delegation') continue;
        db.prepare("UPDATE handoff_watches SET state = 'closed', outcome = 'child_failed', closed_at = ?, updated_at = ? WHERE delegation_id = ? AND state <> 'closed'").run(
          nowIso,
          nowIso,
          nodeId,
        );
        closedDelegations.push(node);
      }

      const routes = [];
      const liveDeliveries = [];
      const routedNodeIds = new Set();
      for (const node of closedDelegations) {
        const routed = routeCustodyLossToParent(db, context, node);
        if (!routed) continue;
        routes.push(routed.route);
        liveDeliveries.push(...routed.liveDeliveries);
        routedNodeIds.add(node.id);
      }

      // Attention covers exactly what routing did not. A root keeps its
      // visibility mark while ANY node this decision closed has no durable
      // parent delivery of its own: an attempt (whose parent is the root —
      // there is no endpoint to wake) or a delegation whose wake could not
      // be made. The FULL affected set is disclosed either way — routing is
      // delivery mechanics, while every touched root is the operator fact.
      const attentionRoots = new Set();
      const allAttentionRoots = new Set();
      for (const nodeId of closed) {
        const rootId = chainRootOf(db, nodeId);
        allAttentionRoots.add(rootId);
        if (!routedNodeIds.has(nodeId)) attentionRoots.add(rootId);
      }
      for (const rootId of attentionRoots) markRootAttention(db, { rootId, now });

      // `route` stays the decision's primary route for callers that name a
      // single one; `routes` is the per-child truth.
      const route = routes[0] ?? (attentionRoots.size > 0 ? { kind: 'root_attention', roots: [...attentionRoots] } : null);

      return { decided: true, reason: 'reconciled', closed, route, routes, liveDeliveries, attentionRoots: [...allAttentionRoots] };
    });
  } catch (error) {
    // A reconciliation failure must never crash the resumer tick or fail a
    // transport op after the fact; the durable facts stay undecided and the
    // next positive observation re-decides them.
    context.logger?.error({
      event: 'custody_loss_reconciliation_failed',
      params: { endpoint_id: endpointId, evidence_kind: evidenceKind },
      message: error.message,
      stack: error.stack,
    });
    return NOOP('reconciliation_failed');
  }

  if (outcome.decided) {
    context.logger?.info({
      event: 'TEMP DEATH custody_loss_reconciled',
      params: { endpoint_id: endpointId, evidence_kind: evidenceKind, closed: outcome.closed, route: outcome.route, routes: outcome.routes },
      result: 'reconciled',
      status: 'ok',
    });
    pushLiveDeliveryEvents(context, { liveDeliveries: outcome.liveDeliveries });
  }
  return outcome;
}
