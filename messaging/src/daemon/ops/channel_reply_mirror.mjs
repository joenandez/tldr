import { TightbeamError } from "../../protocol/envelope.mjs";
import { withTransaction } from "../db.mjs";
import { endpointHasWakingUnreadSql } from "../lifecycle_transition.mjs";
import {
  createDeliveriesForChannelRoutes,
  maybeCreateResumeRequest,
} from "./message_shared.mjs";
import { LIMIT_BACKOFF_OUTCOME, USAGE_LIMIT_REASON } from "./resume_fail.mjs";

// Mirror of inbound channel replies to the Subspace routes that hold the thread. Shared by
// channel.reply.publish (live) and the recovery.mirror_replies backfill, so both pick routes by one
// rule and write delivery rows through the same path.
// Mirror rule: an active route whose selector is 'subspace' or 'subspace-*' (substr, not LIKE:
// LIKE is case-insensitive), with a live endpoint and the 'send' capability, that is not the
// origin route and ALREADY holds a delivery in this conversation. No principal scoping: holding
// the thread is the scope. `agentOnlyEvidence` ignores deliveries of inbound messages (mirrors),
// so the backfill's own writes never make a route a holder.
export function holderRoutesForReply(
  db,
  { conversationId, originRouteId, agentOnlyEvidence = false },
) {
  return db
    .prepare(
      `SELECT r.id, r.app_id, r.principal_id, r.endpoint_id, r.selector, r.capabilities, e.state AS endpoint_state
         FROM channel_routes r
         JOIN applications a ON a.id = r.app_id
         JOIN endpoints e ON e.id = r.endpoint_id
        WHERE r.state = 'active' AND (r.selector = 'subspace' OR substr(r.selector, 1, 9) = 'subspace-') AND r.id <> ?
          AND a.status = 'active' AND e.state IN ('idle', 'busy')
          AND EXISTS (
            SELECT 1 FROM deliveries d JOIN messages m ON m.id = d.message_id
             WHERE d.endpoint_id = r.endpoint_id AND m.conversation_id = ? ${agentOnlyEvidence ? "AND m.origin = 'agent'" : ""})
        ORDER BY r.selector ASC`,
    )
    .all(originRouteId, conversationId)
    .filter((route) => {
      try {
        return JSON.parse(route.capabilities).includes("send");
      } catch {
        return false;
      }
    });
}

// No reply target and no route reason: a mirror creates no reply binding, obligation, or ack.
export function mirrorToHolderRoutes(
  db,
  { binding, messageId, conversationId },
) {
  const routes = holderRoutesForReply(db, {
    conversationId,
    originRouteId: binding.channel_route_id,
  });
  if (routes.length > 0)
    createDeliveriesForChannelRoutes(db, { conversationId, messageId, routes });
  return routes.length;
}

function backfillMirrors(db, { dryRun }) {
  const messages = db
    .prepare(
      `SELECT id, conversation_id, origin_channel_route_id FROM messages
        WHERE origin = 'inbound' AND origin_channel_route_id IS NOT NULL ORDER BY created_at ASC, id ASC`,
    )
    .all();
  // Any state counts: the partial unique index only guards pending/claimed deliveries.
  const hasDelivery = db.prepare(
    "SELECT 1 FROM deliveries WHERE message_id = ? AND endpoint_id = ? LIMIT 1",
  );
  const perRoute = new Map();
  for (const message of messages) {
    const routes = holderRoutesForReply(db, {
      conversationId: message.conversation_id,
      originRouteId: message.origin_channel_route_id,
      agentOnlyEvidence: true,
    }).filter((route) => !hasDelivery.get(message.id, route.endpoint_id));
    if (routes.length === 0) continue;
    if (!dryRun)
      createDeliveriesForChannelRoutes(db, {
        conversationId: message.conversation_id,
        messageId: message.id,
        routes,
      });
    for (const route of routes) {
      const entry = perRoute.get(route.id) ?? {
        route_id: route.id,
        selector: route.selector,
        count: 0,
      };
      entry.count += 1;
      perRoute.set(route.id, entry);
    }
  }
  const routes = [...perRoute.values()].sort((a, b) =>
    a.selector.localeCompare(b.selector),
  );
  return {
    messages_scanned: messages.length,
    routes,
    total: routes.reduce((sum, r) => sum + r.count, 0),
  };
}

export function runMirrorBackfill(db, { dryRun }) {
  return dryRun
    ? backfillMirrors(db, { dryRun })
    : withTransaction(db, () => backfillMirrors(db, { dryRun }));
}

export const recoveryMirrorRepliesOp = {
  name: "recovery.mirror_replies",
  allowedScopes: ["admin"],
  permission: null,
  handler(context, payload) {
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      Object.keys(payload).some((key) => key !== "dry_run")
    ) {
      throw new TightbeamError(
        "malformed_request",
        "recovery.mirror_replies accepts only dry_run",
        { field: "payload" },
      );
    }
    if (typeof payload.dry_run !== "boolean") {
      throw new TightbeamError(
        "malformed_request",
        "dry_run is required and must be a boolean",
        { field: "dry_run" },
      );
    }
    const startedAt = Date.now();
    const result = {
      dry_run: payload.dry_run,
      ...runMirrorBackfill(context.db, { dryRun: payload.dry_run }),
    };
    context.logger?.info?.({
      event: "recovery_mirror_replies",
      params: { dry_run: result.dry_run },
      result: {
        messages_scanned: result.messages_scanned,
        total: result.total,
        routes: result.routes.length,
      },
      latency: Date.now() - startedAt,
      status: "ok",
    });
    return { result };
  },
};

// ac-jfv.165 `recovery rewake`: an operator (or an agent for its user) asks again for wakes a usage
// limit ended. (a) A failed wake whose message still wakes gets a FRESH request (the failed row is
// never reset). (b) A wake held for a limit is released so the next resumer tick relaunches it.
const ISO_FIELDS = ["since", "until"];
function isoOrNull(value, field) {
  if (value === undefined || value === null) return null;
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  if (Number.isFinite(ms)) return new Date(ms).toISOString();
  throw new TightbeamError(
    "malformed_request",
    `${field} must be an ISO-8601 time`,
    { field },
  );
}

// The skip reason and the why are decided in SQL, beside the resumer's own "still wakes" predicate.
function rewakeCandidates(db, { since, until }) {
  return db
    .prepare(
      `SELECT r.id, r.endpoint_id, r.principal_id, r.session_id, r.conversation_id, r.message_id, r.reason, r.authority_reference,
              CASE WHEN r.replacement_failure_reason IS NULL THEN 'failed_unclassified_in_window' ELSE 'failed_usage_limit' END AS why,
              CASE
                WHEN EXISTS (SELECT 1 FROM resume_requests a WHERE a.endpoint_id = r.endpoint_id AND a.message_id = r.message_id AND a.state IN ('pending', 'claimed')) THEN 'active_request_exists'
                WHEN EXISTS (SELECT 1 FROM resume_requests s WHERE s.endpoint_id = r.endpoint_id AND s.replacement_endpoint_id IS NOT NULL) THEN 'superseded_endpoint'
                WHEN NOT (EXISTS (SELECT 1 FROM deliveries d WHERE d.endpoint_id = r.endpoint_id AND d.message_id = r.message_id AND d.state != 'failed' AND d.read_at IS NULL)
                          AND ${endpointHasWakingUnreadSql("r.endpoint_id")}) THEN 'message_not_waking'
              END AS skip
         FROM resume_requests r
        WHERE r.state = 'failed'
          AND (r.replacement_failure_reason = ?
               OR (r.replacement_failure_reason IS NULL AND r.updated_at >= ? AND r.updated_at <= ?))
        ORDER BY r.created_at ASC, r.id ASC`,
    )
    .all(USAGE_LIMIT_REASON, since ?? (until ? "" : "9999"), until ?? "9999"); // shortcut: ISO strings sort as text; no window at all means no unclassified rows match
}

// A fresh request through the shared writer; null when it declines (e.g. a superseded endpoint).
function refire(db, row, logger) {
  return maybeCreateResumeRequest(db, {
    endpoint: {
      id: row.endpoint_id,
      principal_id: row.principal_id,
      session_id: row.session_id,
      authority_reference: row.authority_reference,
    },
    conversationId: row.conversation_id,
    messageId: row.message_id,
    reason: row.reason,
    logger,
  });
}

function decideFailed(db, row, { seen, dryRun, logger }) {
  const key = `${row.endpoint_id}|${row.message_id}`;
  const skip = row.skip ?? (seen.has(key) ? "duplicate_failed_request" : null);
  seen.add(key);
  const entry = {
    request_id: row.id,
    message_id: row.message_id,
    endpoint_id: row.endpoint_id,
    why: row.why,
  };
  if (skip || dryRun) return { skip, entry };
  entry.new_request_id = refire(db, row, logger);
  return {
    skip: entry.new_request_id ? null : "declined_by_resume_request_writer",
    entry,
  };
}

// Only a claim whose outcome is 'limit_backoff' is a held wake: a NULL outcome is a live launch.
function releaseHeld(db, { dryRun, nowIso }) {
  const held = db
    .prepare(
      `SELECT c.id AS claim_id, r.id AS request_id, r.message_id, r.endpoint_id, 'held_for_limit' AS why
         FROM claims c JOIN resume_requests r ON r.id = c.resource_id
        WHERE c.resource_type = 'resume_request' AND c.state = 'claimed' AND c.outcome = ? AND c.lease_expires_at > ?
        ORDER BY r.created_at ASC, r.id ASC`,
    )
    .all(LIMIT_BACKOFF_OUTCOME, nowIso);
  const release = db.prepare(
    "UPDATE claims SET lease_expires_at = ? WHERE id = ? AND state = 'claimed' AND outcome = ?",
  );
  return held.map(({ claim_id: claimId, ...entry }) => {
    if (!dryRun) release.run(nowIso, claimId, LIMIT_BACKOFF_OUTCOME);
    return entry;
  });
}

function rewake(db, { dryRun, since, until, logger }) {
  const rewoken = [];
  const skipped = [];
  const seen = new Set();
  const decision = (entry, result) =>
    logger?.info?.({
      event: "recovery.rewake.decision",
      params: {
        request_id: entry.request_id,
        endpoint_id: entry.endpoint_id,
        message_id: entry.message_id,
        dry_run: dryRun,
      },
      result,
      status: "ok",
    });
  for (const row of rewakeCandidates(db, { since, until })) {
    const { skip, entry } = decideFailed(db, row, { seen, dryRun, logger });
    if (skip) skipped.push({ request_id: row.id, reason: skip });
    else rewoken.push(entry);
    decision(entry, {
      decision: skip ? "skipped" : "rewake",
      reason: skip,
      why: entry.why,
    });
  }
  for (const entry of releaseHeld(db, {
    dryRun,
    nowIso: new Date().toISOString(),
  })) {
    rewoken.push(entry);
    decision(entry, { decision: "rewake", why: entry.why });
  }
  return {
    dry_run: dryRun,
    rewoken,
    skipped,
    counts: { rewoken: rewoken.length, skipped: skipped.length },
  };
}

export const recoveryRewakeOp = {
  name: "recovery.rewake",
  allowedScopes: ["admin"],
  permission: null,
  handler(context, payload) {
    const keys = ["dry_run", ...ISO_FIELDS];
    if (
      !payload ||
      typeof payload !== "object" ||
      Object.keys(payload).some((key) => !keys.includes(key))
    )
      throw new TightbeamError(
        "malformed_request",
        "recovery.rewake accepts only dry_run, since and until",
        { field: "payload" },
      );
    if (typeof payload.dry_run !== "boolean")
      throw new TightbeamError(
        "malformed_request",
        "dry_run is required and must be a boolean",
        { field: "dry_run" },
      );
    const [since, until] = ISO_FIELDS.map((field) =>
      isoOrNull(payload[field], field),
    );
    const args = {
      dryRun: payload.dry_run,
      since,
      until,
      logger: context.logger,
    };
    const params = { dry_run: payload.dry_run, since, until };
    const startedAt = Date.now();
    try {
      const run = () => rewake(context.db, args);
      const result = payload.dry_run ? run() : withTransaction(context.db, run);
      context.logger?.info?.({
        event: "recovery.rewake",
        params,
        result: result.counts,
        latency: Date.now() - startedAt,
        status: "ok",
      });
      return { result };
    } catch (error) {
      context.logger?.error?.({
        event: "recovery.rewake",
        params,
        error: { message: error.message, stack: error.stack },
        latency: Date.now() - startedAt,
        status: "error",
      });
      throw error;
    }
  },
};
