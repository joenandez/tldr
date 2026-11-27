// A usage limit that cuts a launch off AFTER it took its message (ac-4p2j0).
//
// The launch's own message.receive completed its resume request and released
// the claim, so ac-jfv.165's hold (which needs a claimed request) never sees
// the refusal, and a nonzero exit reads as the holder's death. It is not one:
// the provider refused the turn. The read request is left exactly as the
// receipt made it (completed, its delivery read, its admission stamped), so the
// sender's delivery ladder cannot step back and the receipt cannot repeat.
// Instead each open request the endpoint still holds gets one fresh
// "you were cut off by a usage limit" note, to the holder only, and that note's
// resume request is held through the same .165 hold: nothing launches before
// reset + 60 s, the held launch delivers the note exactly once, and no
// requester or user channel hears anything.
//
// The 24 h horizon is one clock across cycles: the note's held claim carries
// the earliest limit_refused_at of the exiting request's claims. The exiting
// claim is stamped as well (it is a refusal too). Past the horizon nothing is
// held and the caller's ordinary exit handling applies.
//
// It reads the schema, the shared message and claim helpers and the custody
// reconciler's launch fence, so it stands on any tree that has the .165 hold.
// A launch that no longer speaks for the endpoint (r31) makes no write here.

import { launchFenceStale } from "./custody_reconciler.mjs";
import { launchIdentity } from "./resume_children.mjs";
import { withTransaction } from "./db.mjs";
import { hasActiveStagedResolution } from "./held_request_stop.mjs";
import { acquireClaim } from "./ops/claims_shared.mjs";
import { publishPresentation } from "./ops/listener_operations.mjs";
import {
  createDeliveriesForRecipients,
  insertMessage,
  payloadHash,
  pushLiveDeliveryEvents,
} from "./ops/message_shared.mjs";
import { holdClaimForLimit, limitOutcome } from "./ops/resume_fail.mjs";
import { SCHEDULED_WAKE_ROUTE_REASON } from "./scheduled_wakes.mjs";

export const LIMIT_KEY_PREFIX = "holder-limit:";
export const limitKey = (nodeId, requestId) =>
  `${LIMIT_KEY_PREFIX}${nodeId}:${requestId}`;

const noteBody = (rootId) =>
  `A provider usage limit cut your session off while you held request ${rootId}. The limit has reset, so you are being resumed. Pick up where you stopped: answer, or say what you're doing and when you'll report back; \`reply\` keeps the request open; only \`complete\` closes it; \`delegate --at\` parks it.`;

// The open work this endpoint holds that a limit leaves unattended: not handed
// on (no open child), not parked (no unfired wake), under a root that is open
// with no staged resolution. Each with its root and the message that opened it.
function heldWork(db, endpointId) {
  const nodes = db
    .prepare(
      `SELECT o.* FROM obligations o
        WHERE o.custodian_endpoint_id = ? AND o.role IN ('attempt', 'delegation') AND o.status = 'open'
          AND NOT EXISTS (SELECT 1 FROM obligations c WHERE c.parent_id = o.id AND c.status = 'open')
          AND NOT EXISTS (SELECT 1 FROM scheduled_wakes w WHERE w.attempt_id = o.id AND w.fired_at IS NULL AND w.cancelled_at IS NULL)
        ORDER BY o.id`,
    )
    .all(endpointId);
  return nodes.flatMap((node) => {
    let root = node;
    while (root && root.role !== "root" && root.parent_id)
      root = db
        .prepare("SELECT * FROM obligations WHERE id = ?")
        .get(root.parent_id);
    const opening =
      root?.role === "root" &&
      root.status === "open" &&
      !hasActiveStagedResolution(db, root.id)
        ? db
            .prepare(
              `SELECT m.id, m.app_id, m.sender_principal_id, me.effect_payload
                 FROM message_effects me JOIN messages m ON m.id = me.message_id
                WHERE me.obligation_id = ? AND me.effect = 'open' ORDER BY m.rowid LIMIT 1`,
            )
            .get(root.id)
        : null;
    if (!opening) return [];
    let requesterEndpointId = null;
    try {
      requesterEndpointId =
        JSON.parse(opening.effect_payload)?.declaration?.sender_endpoint_id ??
        null;
    } catch {
      // An unreadable audit leaves the requester unknown; the note still goes out.
    }
    return [{ node, root, opening, requesterEndpointId }];
  });
}

// Inside the transaction: the note for one held node, delivered to the holder
// only, and its resume request claimed and held until the limit should be over.
function holdNote(context, work, args) {
  const { db } = context;
  const { endpointId, requestId, limit, firstAt, resetsAtMs, now } = args;
  const { node, root, opening } = work;
  const key = limitKey(node.id, requestId);
  const body = noteBody(root.id);
  const messageId = insertMessage(db, {
    conversationId: root.conversation_id,
    appId: opening.app_id,
    senderPrincipalId: opening.sender_principal_id,
    kind: "commit",
    body,
    metadata: { notice: "holder_limit" },
    idempotencyKey: key,
    hash: payloadHash({ key, body }),
    origin: "agent",
    inReplyToMessageId: opening.id,
  });
  const sent = createDeliveriesForRecipients(db, {
    conversationId: root.conversation_id,
    messageId,
    senderPrincipalId: opening.sender_principal_id,
    senderEndpointId: work.requesterEndpointId,
    recipientEndpointId: endpointId,
    routeReason: SCHEDULED_WAKE_ROUTE_REASON,
    sourceObligationId: root.id,
    routeReasonEndpointIds: new Set([endpointId]),
    stateRoot: context.stateRoot,
    logger: context.logger,
  });
  const request = db
    .prepare(
      "SELECT id FROM resume_requests WHERE message_id = ? AND endpoint_id = ? AND state = 'pending'",
    )
    .get(messageId, endpointId);
  if (!request) throw new Error(`no resume request for limit note ${key}`);
  const claim = acquireClaim(db, {
    resourceType: "resume_request",
    resourceId: request.id,
    leaseMs: limit.delayMs,
    now,
  });
  db.prepare(
    "UPDATE resume_requests SET state = 'claimed', updated_at = ? WHERE id = ?",
  ).run(now.toISOString(), request.id);
  const row = db
    .prepare("SELECT * FROM claims WHERE token = ?")
    .get(claim.token);
  db.prepare("UPDATE claims SET limit_refused_at = ? WHERE id = ?").run(
    firstAt,
    row.id,
  );
  holdClaimForLimit(db, { row, limit, resetsAtMs, now });
  return {
    sent,
    key,
    requestId: request.id,
    conversationId: root.conversation_id,
  };
}

// The completed claim of the launch that took its message under `token`.
function exitingClaim(db, request, token) {
  return db
    .prepare(
      `SELECT c.id AS claim_id FROM claims c JOIN resume_requests r ON r.id = c.resource_id
        WHERE c.resource_type = 'resume_request' AND c.resource_id = ? AND c.token = ?
          AND c.state = 'released' AND c.outcome = 'completed' AND r.state = 'completed'`,
    )
    .get(request.id, token);
}

// At the horizon the work ends terminal: the endpoint's other limit notes (one per earlier
// refusal) would only wake a dead session, so they end unlaunched, as an operator cancel ends a root's.
function retireLimitNotes(db, endpointId, now) {
  const own = `SELECT r.id FROM resume_requests r JOIN messages m ON m.id = r.message_id
    WHERE r.endpoint_id = ? AND r.state IN ('pending', 'claimed') AND substr(m.idempotency_key, 1, ${LIMIT_KEY_PREFIX.length}) = '${LIMIT_KEY_PREFIX}'`;
  const at = now.toISOString();
  db.prepare(
    `UPDATE claims SET state = 'released', outcome = 'failed', released_at = ?
      WHERE resource_type = 'resume_request' AND state = 'claimed' AND resource_id IN (${own})`,
  ).run(at, endpointId);
  db.prepare(
    `UPDATE resume_requests SET state = 'failed', updated_at = ? WHERE id IN (${own})`,
  ).run(at, endpointId);
}

// One transaction: stamp the refusal, then hold a note per held node.
function holdNotes(context, args) {
  const { db } = context;
  const { request, exiting, resetsAtMs, now } = args;
  const limit = limitOutcome(db, {
    rateLimited: true,
    unavailable: false,
    requestId: request.id,
    claimId: exiting.claim_id,
    nowMs: now.getTime(),
    resetsAtMs,
  });
  if (!limit?.delayMs) {
    if (limit?.expired) retireLimitNotes(db, request.endpoint_id, now);
    return { expired: Boolean(limit?.expired), notes: [] };
  }
  const notes = heldWork(db, request.endpoint_id).map((work) =>
    holdNote(context, work, {
      endpointId: request.endpoint_id,
      requestId: request.id,
      limit,
      firstAt: limit.firstAt,
      resetsAtMs,
      now,
    }),
  );
  return { expired: false, notes, delayMs: limit.delayMs };
}

// Every write needs a launch that still speaks for the endpoint (r31, r33): the custody reconciler's fence
// plus launch identity, read inside the transaction before any stamp, note or retirement. A stale exit makes
// none. Once identity passes, heldWork still covers the endpoint's CURRENT open work (a root opened during
// the launch is held too, r29); identity is what stops a NEWER owner's work being held by an old launch.
function holdIfSpeaking(context, args) {
  const { db } = context;
  const { request, evidence, capture } = args;
  const endpoint = db
    .prepare(
      "SELECT id, process_generation, owner_epoch, owner_launch_token, owner_process_pid, owner_process_start_identity FROM endpoints WHERE id = ?",
    )
    .get(request.endpoint_id);
  let stale = "endpoint_unknown";
  if (endpoint)
    stale =
      launchFenceStale(context, endpoint, {
        evidenceKind: "usage_limit",
        ...evidence,
      }) ?? (launchIdentity(endpoint, capture) ? null : "not_owner");
  return stale ? { fenced: stale } : holdNotes(context, args);
}

function announce(context, request, held) {
  for (const { sent, conversationId } of held.notes) {
    pushLiveDeliveryEvents(context, {
      conversationId,
      liveDeliveries: sent.liveDeliveries ?? [],
    });
    for (const presentation of sent.presentations ?? [])
      publishPresentation(context, presentation);
  }
  context.logger?.info?.({
    event: "resume.limit_note_held",
    params: {
      resume_request_id: request.id,
      endpoint_id: request.endpoint_id,
      resets_at: held.resetsAtMs,
    },
    result: {
      expired: held.expired,
      notes: held.notes.map((note) => note.key),
      delay_ms: held.delayMs ?? null,
    },
    status: held.notes.length > 0 ? "held" : "skipped",
  });
}

/**
 * One supervised exit. "held": the exit is a usage limit that cut off a launch
 * which had already taken its message (its request completed under `token`)
 * and at least one held request got its note, held until the reset. "expired":
 * the same, but the 24 h no-reset horizon is over, so nothing is held and the
 * caller must end the work as a terminal usage-limit failure (never a death
 * retry). null leaves the exit to the caller's ordinary handling (a pre-receipt
 * refusal, nothing held, or any error here). `settle` marks the busy endpoint
 * resumable before the note is delivered, as the exit's own handling would.
 * Never throws.
 */
export function holdLimitedLaunch(
  context,
  {
    request,
    token,
    rateLimited,
    resetsAtMs = null,
    now,
    settle,
    evidence,
    capture,
  },
) {
  const { db, logger } = context;
  let held = null;
  try {
    const exiting =
      rateLimited && request.reason !== "availability_takeover"
        ? exitingClaim(db, request, token)
        : null;
    if (exiting) {
      settle();
      const result = withTransaction(db, () =>
        holdIfSpeaking(context, {
          request,
          exiting,
          resetsAtMs,
          now,
          evidence,
          capture,
        }),
      );
      if (result.fenced) {
        logger?.info?.({
          event: "resume.limit_note_fenced",
          params: {
            resume_request_id: request.id,
            endpoint_id: request.endpoint_id,
          },
          result: { reason: result.fenced },
          status: "skipped",
        });
      } else {
        announce(context, request, { ...result, resetsAtMs });
        if (result.notes.length > 0) held = "held";
        else if (result.expired) held = "expired";
      }
    }
  } catch (error) {
    logger?.error?.({
      event: "resume.limit_note_failed",
      params: { resume_request_id: request.id },
      result: { message: error.message, stack: error.stack },
      status: "error",
    });
  }
  return held;
}
