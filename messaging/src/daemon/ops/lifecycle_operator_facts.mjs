// The operator-only facts of a lifecycle.view chain (drive-liveness T5):
// when the work last moved, when its holder last reported, and what the
// scheduled-wake pass has done since. Pure reads; the plain view never calls this.

import { TightbeamError } from "../../protocol/envelope.mjs";
import { SCHEDULED_WAKE_ROUTE_REASON } from "../scheduled_wakes.mjs";
import { LIMIT_BACKOFF_OUTCOME } from "./resume_fail.mjs";
import { holderNoteVisibleSql } from "./reserved_notice.mjs";
import { stagedResolutionFacts } from "./staged_resolution_facts.mjs";

// A holder's progress on the work: an update (an ack is one), a delegate, a complete.
const PROGRESS_EFFECTS = ["update", "handoff.offer", "close.fulfilled"];

/** The `operator` request flag of lifecycle.view: absent or a boolean. */
export function withOperatorFlag(request) {
  if (request.operator !== undefined && typeof request.operator !== "boolean") {
    throw new TightbeamError(
      "malformed_request",
      "operator must be a boolean when present",
      { field: "operator" },
    );
  }
  return request;
}

const marks = (ids) => ids.map(() => "?").join(", ");

// The usage-limit hold (resume_fail.mjs holdClaimForLimit): a resume claim kept 'claimed' with
// outcome limit_backoff until the limit should be over. The earliest unexpired one on a message
// of this chain is when the work can next run.
function heldUntil(db, { conversationId, ids }) {
  if (ids.length === 0) return null;
  return (
    db
      .prepare(
        `SELECT MIN(c.lease_expires_at) AS at
           FROM claims c JOIN resume_requests r ON r.id = c.resource_id
          WHERE c.resource_type = 'resume_request' AND c.state = 'claimed' AND c.outcome = ?
            AND c.lease_expires_at > ? AND r.conversation_id = ?
            AND (r.message_id IN (SELECT message_id FROM message_effects WHERE obligation_id IN (${marks(ids)}))
              OR r.message_id IN (SELECT message_id FROM deliveries WHERE source_obligation_id IN (${marks(ids)})))`,
      )
      .get(
        LIMIT_BACKOFF_OUTCOME,
        new Date().toISOString(),
        conversationId,
        ...ids,
        ...ids,
      ).at ?? null
  );
}

/**
 * @param {{root: object, nodes: object[], attention: object|null}} chain the rows projectionForRoot already read
 * @returns {{updated_at: string, last_progress_at: string|null, held_until: string|null, wakes: {since_progress: number, next_at: string|null, last_reason: string|null}, attention: 'needs_attention'|null, staged_resolution: object|null}}
 */
export function operatorFacts(db, { root, nodes, attention }) {
  const ids = nodes.map((node) => node.id);
  const progress = ids.length
    ? db
        .prepare(
          `SELECT MAX(m.created_at) AS at FROM message_effects me JOIN messages m ON m.id = me.message_id
            WHERE me.effect IN (${marks(PROGRESS_EFFECTS)}) AND me.obligation_id IN (${marks(ids)})`,
        )
        .get(...PROGRESS_EFFECTS, ...ids).at
    : null;
  // A wake that fired and was not cancelled since: progress cancels every wake of its holder node
  // (an attempt, or a delegation parked by an update); wakes are keyed by node id, so every node is read.
  const live = ids.length
    ? db
        .prepare(
          `SELECT reason, wake_at, fired_at FROM scheduled_wakes
            WHERE attempt_id IN (${marks(ids)}) AND cancelled_at IS NULL ORDER BY wake_at, wake_id`,
        )
        .all(...ids)
    : [];
  const pending = live.filter((wake) => wake.fired_at === null);
  // Emissions, not rows: the one-hour re-wake reuses its row and sends another wake delivery.
  const emitted = db
    .prepare(
      `SELECT COUNT(DISTINCT d.message_id) AS n FROM deliveries d JOIN messages m ON m.id = d.message_id
        WHERE ${holderNoteVisibleSql("m", [])} AND d.route_reason = ? AND d.source_obligation_id = ? AND d.created_at > ?`,
    )
    .get(SCHEDULED_WAKE_ROUTE_REASON, root.id, progress ?? "").n;
  return {
    updated_at: nodes.reduce(
      (newest, node) => (node.updated_at > newest ? node.updated_at : newest),
      root.updated_at,
    ),
    last_progress_at: progress ?? null,
    held_until: heldUntil(db, { conversationId: root.conversation_id, ids }),
    wakes: {
      since_progress: emitted,
      next_at: pending[0]?.wake_at ?? null,
      last_reason: live.at(-1)?.reason ?? null,
    },
    attention: attention && root.status === "open" ? "needs_attention" : null,
    staged_resolution:
      root.status === "open" ? stagedResolutionFacts(db, root.id) : null,
  };
}
