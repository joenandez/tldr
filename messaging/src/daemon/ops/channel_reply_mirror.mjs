import { TightbeamError } from "../../protocol/envelope.mjs";
import { withTransaction } from "../db.mjs";
import { createDeliveriesForChannelRoutes } from "./message_shared.mjs";

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
