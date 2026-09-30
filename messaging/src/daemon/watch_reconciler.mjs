// The handoff-watch expiry reconciler (Project Relay parent 3.2, subtask
// 3.2.1; docs/lifecycle-control-plane/transitions.yaml HANDOFF-EXPIRE; plan
// «Technical Approach 3» "Run expiry reconciliation beside the existing
// resumer using its bounded tick, durable scan, and CAS discipline").
//
// One bounded pass selects every watch still `awaiting_acceptance` whose
// absolute deadline has passed and whose delegation is STILL open and
// endpointless, and decides each inside one transaction:
//
//   1. CAS the delegation open+endpointless → closed failed
//      (resolution_reason 'acceptance_expired');
//   2. CAS the watch awaiting_acceptance → closed acceptance_expired;
//   3. create exactly ONE typed immediate-parent delivery
//      (route_reason 'handoff.acceptance.expired',
//      source_obligation_id = delegation) against the ORIGINAL offer
//      message — no principal-authored text is synthesized and no
//      replacement agent is chosen — with its resume-if-idle/dead route.
//
// Acceptance races this through the same winner-decider CAS the accept
// effect holds on `awaiting_acceptance` (test/unit/lifecycle_handoff.test.mjs):
// whichever transaction commits first wins, in both orders. A watch already
// decided — accepted, declined, resulted, or silently closed child_failed by
// supersession — never re-enters the scan, so duplicate evidence and daemon
// restarts can produce at most one parent delivery (INV-10/INV-11/INV-16).
// Like decline, the wake is best-effort when the parent endpoint can no
// longer drain one: the custody decision commits, the delivery is skipped.
// Live-event fan-out happens only after a decision commits, mirroring
// message.commit ordering.

import { TightbeamError } from '../protocol/envelope.mjs';
import { withTransaction } from './db.mjs';
import { createParentResultDelivery, pushLiveDeliveryEvents } from './ops/message_shared.mjs';

// A memory bound on one SELECT, mirroring the resumer's candidate bound: it
// caps how many rows a single pass materialises and nothing is withheld from
// execution by it — every candidate returned is decided in this pass, and a
// pass behind the bound simply continues on the next tick.
export const WATCH_SCAN_LIMIT = 1000;

/**
 * Indexes every committed handoff.offer audit row ONCE: delegation id →
 * creating offer's message id. First match wins and an unreadable payload
 * cannot match — exactly findOfferMessageId's scan semantics. Built before
 * the decision loop so a pass costs one scan instead of one full
 * SELECT-and-JSON-parse per expired candidate held inside BEGIN IMMEDIATE.
 */
function indexOfferAudits(db) {
  const offers = db.prepare("SELECT message_id, effect_payload FROM message_effects WHERE effect = 'handoff.offer'").all();
  const index = new Map();
  for (const row of offers) {
    try {
      const delegationId = JSON.parse(row.effect_payload)?.created?.delegation_id;
      if (delegationId && !index.has(delegationId)) index.set(delegationId, row.message_id);
    } catch {
      // An unreadable payload cannot match any delegation; keep scanning.
    }
  }
  return index;
}

/** The fail-closed rejection for a delegation whose offer audit is gone. */
function missingOfferAuditError(delegationId) {
  return new TightbeamError('obligation_conflict', `delegation "${delegationId}" has no committed offer audit to route its expiry against`);
}

/**
 * Locates the offer message that created this delegation's watch, so the
 * parent wake re-delivers real history instead of synthesized text. Every
 * engine-committed offer wrote its audit row in the offer's own transaction,
 * so a miss means the invariant broke: fail closed rather than route a wake
 * with no message behind it. Exported for the custody-loss reconciler
 * (parent 4.1), whose typed parent wake follows the same discipline — but
 * treats a missing audit as unroutable-parent fallback rather than an
 * abort, so one broken chain can never strand a death decision.
 */
export function findOfferMessageId(db, delegationId) {
  const offerMessageId = indexOfferAudits(db).get(delegationId);
  if (offerMessageId === undefined) throw missingOfferAuditError(delegationId);
  return offerMessageId;
}

/**
 * Decides one expired watch, or reports `null` when the winner-decider CAS
 * shows another transition got there first. Everything durable rides ONE
 * transaction; only the best-effort event push happens after commit.
 * `offerIndex` is the pass-level delegation→offer-message map, read here
 * inside the transaction without rescanning the audit table.
 */
function decideExpiredWatch(context, { watchId, delegationId, now, offerIndex }) {
  const db = context.db;
  const nowIso = now.toISOString();
  return withTransaction(db, () => {
    // Winner-decider CAS #1 — the delegation must still be open AND
    // endpointless. An accepted delegation (custody bound) or an already
    // decided one makes this a counted zero: skip without touching anything.
    const failed = db
      .prepare(
        `UPDATE obligations
            SET status = 'closed', resolution = 'failed', resolution_reason = 'acceptance_expired',
                resolution_source = ?, updated_at = ?
          WHERE id = ? AND status = 'open' AND custodian_endpoint_id IS NULL`,
      )
      .run(`acceptance_expired:${watchId}`, nowIso, delegationId);
    if (failed.changes !== 1) return null;

    // Winner-decider CAS #2 — the same predicate the accept effect advances.
    // Reaching here with a non-awaiting watch would mean the two pivots
    // disagreed mid-decision; fail closed and roll the whole step back.
    const expired = db
      .prepare("UPDATE handoff_watches SET state = 'closed', outcome = 'acceptance_expired', closed_at = ?, updated_at = ? WHERE id = ? AND state = 'awaiting_acceptance'")
      .run(nowIso, nowIso, watchId);
    if (expired.changes !== 1) {
      throw new TightbeamError('obligation_conflict', `handoff watch "${watchId}" raced a decided acceptance window`);
    }

    // One immediate-parent delivery for the terminal outcome, riding THIS
    // transaction; best-effort exactly like decline when the parent endpoint
    // is gone or closed (ifParentExists).
    const delegation = db.prepare('SELECT id, conversation_id, accountable_principal_id, parent_id FROM obligations WHERE id = ?').get(delegationId);
    const parent = db.prepare('SELECT custodian_endpoint_id FROM obligations WHERE id = ?').get(delegation.parent_id);
    const offerMessageId = offerIndex.get(delegationId);
    if (offerMessageId === undefined) throw missingOfferAuditError(delegationId);
    const { liveDeliveries } = createParentResultDelivery(db, {
      conversationId: delegation.conversation_id,
      messageId: offerMessageId,
      senderPrincipalId: delegation.accountable_principal_id,
      parentEndpointId: parent?.custodian_endpoint_id,
      routeReason: 'handoff.acceptance.expired',
      sourceObligationId: delegationId,
      eventBus: context.eventBus,
      stateRoot: context.stateRoot,
      logger: context.logger,
      ifParentExists: true,
    });

    // Exactly-once evidence: the watch references the single delivery row
    // that reports its expiry (NULL when no routable parent remains).
    const parentDeliveryId = db.prepare('SELECT id FROM deliveries WHERE message_id = ? AND endpoint_id = ?').get(offerMessageId, parent?.custodian_endpoint_id)?.id ?? null;
    db.prepare('UPDATE handoff_watches SET parent_delivery_id = ? WHERE id = ?').run(parentDeliveryId, watchId);

    context.logger?.info({
      event: 'handoff_watch_expired',
      params: { watch_id: watchId, delegation_id: delegationId, offer_message_id: offerMessageId, parent_delivery_id: parentDeliveryId },
      result: parentDeliveryId ? 'routed' : 'decided_unroutable_parent',
      status: 'ok',
    });
    return { conversationId: delegation.conversation_id, liveDeliveries };
  });
}

/**
 * One bounded reconciliation pass. Returns how many watches the scan saw and
 * how many this pass decided; every decision is its own transaction, so a
 * failure mid-pass leaves earlier decisions committed and later ones to the
 * next tick.
 */
export function runWatchReconciliation(context, { now = new Date(), limit = WATCH_SCAN_LIMIT } = {}) {
  const candidates = context.db
    .prepare(
      `SELECT w.id AS watch_id, w.delegation_id AS delegation_id
         FROM handoff_watches w
         JOIN obligations o ON o.id = w.delegation_id
        WHERE w.state = 'awaiting_acceptance'
          AND w.acceptance_deadline_at <= ?
          AND o.status = 'open'
          AND o.custodian_endpoint_id IS NULL
        ORDER BY w.acceptance_deadline_at ASC, w.id ASC
        LIMIT ?`,
    )
    .all(now.toISOString(), limit);

  // One scan per pass, outside every per-watch transaction: the offer audit
  // table is read-only to this pass, so hoisting keeps the write lock held
  // for the decision's CAS + delivery writes only.
  const offerIndex = indexOfferAudits(context.db);

  let expired = 0;
  for (const candidate of candidates) {
    // Per-candidate isolation mirrors the resumer's spawn-failure handling:
    // one broken watch (imported or tampered state with no committed offer
    // audit, say) stays undecided and visible instead of throwing out of
    // the pass and starving every later candidate — and, because the scan
    // re-selects it every tick, every subsequent daemon resume.
    let decided;
    try {
      decided = decideExpiredWatch(context, { watchId: candidate.watch_id, delegationId: candidate.delegation_id, now, offerIndex });
    } catch (err) {
      context.logger?.warn({
        event: 'watch_expiry_candidate_failed',
        params: { watch_id: candidate.watch_id, delegation_id: candidate.delegation_id },
        result: 'undecided',
        status: 'error',
        code: err.code,
        message: err.message,
      });
      continue;
    }
    if (!decided) continue;
    expired += 1;
    pushLiveDeliveryEvents(context, { conversationId: decided.conversationId, liveDeliveries: decided.liveDeliveries });
  }

  if (candidates.length > 0) {
    context.logger?.debug({
      event: 'watch_expiry_scan_complete',
      params: { scanned: candidates.length, expired },
      status: 'ok',
    });
  }
  return { scanned: candidates.length, expired };
}
