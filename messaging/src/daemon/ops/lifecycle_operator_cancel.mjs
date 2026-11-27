// lifecycle.operator_cancel (drive-liveness T5): an operator, outside any
// session, cancels a whole work chain so its wakes stop. Like the recovery
// commands it is an administrative transition: no message row, no holder
// notice (waking a dead holder is what it prevents). The root closes as
// cancelled with the operator and reason on record, its open attempts and
// delegations close as superseded, its wakes are cancelled, and a wake the
// daemon already staged for the old holder is failed so nothing resumes it.

import { TightbeamError } from "../../protocol/envelope.mjs";
import { withTransaction } from "../db.mjs";
import { hasActiveStagedResolution } from "../held_request_stop.mjs";
import { stagedResolutionFacts } from "./staged_resolution_facts.mjs";
import {
  channelOriginOfRoot,
  requireRecoverableRoot,
  supersedeOpenDescendants,
} from "../lifecycle_transition.mjs";
import { SCHEDULED_WAKE_ROUTE_REASON } from "../scheduled_wakes.mjs";
import { applyWakeEffects } from "../update_wakes.mjs";

const FIELDS = ["root_obligation_id", "reason", "operator"];

function parseRequest(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TightbeamError(
      "malformed_request",
      "request is required and must be an object",
    );
  }
  for (const key of Object.keys(payload)) {
    if (!FIELDS.includes(key))
      throw new TightbeamError(
        "malformed_request",
        `lifecycle.operator_cancel declares "${key}", which is not part of its request contract`,
        { field: key },
      );
  }
  for (const field of FIELDS) {
    if (
      typeof payload[field] !== "string" ||
      payload[field].trim().length === 0
    ) {
      throw new TightbeamError(
        "malformed_request",
        `${field} is required and must be a non-empty string`,
        { field },
      );
    }
  }
  return payload;
}

function cancelRoot(context, appId, request) {
  const { db } = context;
  const root = requireRecoverableRoot(db, {
    appId,
    rootObligationId: request.root_obligation_id,
  });
  if (root.status !== "open") {
    const how =
      root.resolution === "cancelled"
        ? "cancelled"
        : root.resolution === "fulfilled"
          ? "done"
          : root.resolution;
    throw new TightbeamError(
      "obligation_conflict",
      `work ${root.id} is already ${how}; nothing to cancel`,
      {
        field: "root_obligation_id",
        reason: "work_closed",
        resolution: root.resolution,
      },
    );
  }
  // Main's rule (applyCloseCancelled, then stageDeliveryConfirmedTerminal): a channel-origin root
  // with a staged terminal resolution closes only through that exact delivery. Once the delivery
  // fails the predicate is false and cancel proceeds (the staged-failure attention covers it).
  // Any other root closes at once, as a requester's cancel does.
  if (channelOriginOfRoot(db, root) && hasActiveStagedResolution(db, root.id)) {
    const staged = stagedResolutionFacts(db, root.id);
    throw new TightbeamError(
      "obligation_conflict",
      `work ${root.id} is already resolving: its result is staged and the work closes through that result's delivery, so it cannot be cancelled`,
      {
        field: "root_obligation_id",
        reason: "resolution_staged",
        staged_message_id: staged?.message_id ?? null,
        staged_resolution: staged,
      },
    );
  }
  const now = new Date().toISOString();
  const source = `operator_cancel:${request.operator}`;
  const wakesBefore = db
    .prepare(
      "SELECT COUNT(*) AS n FROM scheduled_wakes WHERE cancelled_at IS NULL AND attempt_id IN (WITH RECURSIVE t(id) AS (SELECT ? UNION SELECT o.id FROM obligations o JOIN t ON o.parent_id = t.id) SELECT id FROM t)",
    )
    .get(root.id).n;
  const closed = db
    .prepare(
      "UPDATE obligations SET status = 'closed', resolution = 'cancelled', resolution_reason = ?, resolution_source = ?, updated_at = ? WHERE id = ? AND status = 'open'",
    )
    .run(request.reason, source, now, root.id);
  if (closed.changes !== 1)
    throw new TightbeamError(
      "obligation_conflict",
      `work ${root.id} cannot be cancelled`,
      { field: "root_obligation_id", reason: "work_closed" },
    );
  supersedeOpenDescendants(db, { closingNodeId: root.id, source, now });
  applyWakeEffects(db, {
    effect: { type: "close.cancelled", obligation_id: root.id },
    now,
  });
  db.prepare(
    "UPDATE deliveries SET state = 'failed', updated_at = ? WHERE source_obligation_id = ? AND route_reason = ? AND read_at IS NULL AND state = 'pending'",
  ).run(now, root.id, SCHEDULED_WAKE_ROUTE_REASON);
  // Only resumes for this work's own messages: another root in the conversation keeps its wake.
  // A deferred hold (a claimed resume whose claim carries an outcome: backoff, takeover_backoff,
  // limit_backoff, hosted_backoff) is retired too, or the reaper re-pends it when the lease lapses.
  // A launch that is running now (claim outcome NULL) keeps its claim and its request.
  const scope = `WITH RECURSIVE t(id) AS (SELECT ? UNION SELECT o.id FROM obligations o JOIN t ON o.parent_id = t.id)`;
  const ownResumes = `SELECT id FROM resume_requests WHERE conversation_id = ?
          AND (message_id IN (SELECT message_id FROM message_effects WHERE obligation_id IN t)
            OR message_id IN (SELECT message_id FROM deliveries WHERE source_obligation_id IN t))`;
  db.prepare(
    `${scope}
     UPDATE claims SET state = 'released', outcome = 'failed', released_at = ?
      WHERE resource_type = 'resume_request' AND state = 'claimed' AND outcome IS NOT NULL
        AND resource_id IN (${ownResumes})`,
  ).run(root.id, now, root.conversation_id);
  db.prepare(
    `${scope}
     UPDATE resume_requests SET state = 'failed', updated_at = ?
      WHERE id IN (${ownResumes})
        AND (state = 'pending' OR (state = 'claimed' AND NOT EXISTS (
              SELECT 1 FROM claims c WHERE c.resource_type = 'resume_request' AND c.resource_id = resume_requests.id AND c.state = 'claimed')))`,
  ).run(root.id, now, root.conversation_id);
  return {
    root_obligation_id: root.id,
    conversation_id: root.conversation_id,
    work_status: "cancelled",
    cancelled_wakes: wakesBefore,
    reason: request.reason,
    source,
  };
}

export const lifecycleOperatorCancelOp = {
  name: "lifecycle.operator_cancel",
  allowedScopes: ["agent"],
  permission: "manage_obligations",
  handler(context, payload, connection) {
    const request = parseRequest(payload);
    const startedAt = Date.now();
    const result = withTransaction(context.db, () =>
      cancelRoot(context, connection.appId, request),
    );
    context.logger?.info({
      event: "operator_cancel_committed",
      params: {
        root_obligation_id: result.root_obligation_id,
        operator: request.operator,
      },
      result: { cancelled_wakes: result.cancelled_wakes },
      status: "ok",
      latency_ms: Date.now() - startedAt,
    });
    return { result };
  },
};
