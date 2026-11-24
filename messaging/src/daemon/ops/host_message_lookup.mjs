// host.message.lookup — session_hosts.message_lookup.v1 (docs/protocol.md
// «host.message.lookup»). A host reads messages delivered to, or sent from,
// endpoints bound to it or their lineage predecessors. Strictly read-only:
// SELECTs only, never message.read (which marks read, completes resume
// requests and satisfies reply waits).

import { TightbeamError } from "../../protocol/envelope.mjs";
import { computeDeliveryState, conversationSubject } from "./inbox_list.mjs";

const MAX_IDS = 50;
const MAX_ID_LENGTH = 128;
// Encoded-entry budget, under MAX_FRAME_BYTES (1 MiB) with room for the envelope.
const ENCODED_BUDGET = 768 * 1024;

function validatedIds(payload) {
  const ids = payload?.message_ids;
  const valid =
    Array.isArray(ids) &&
    ids.length >= 1 &&
    ids.length <= MAX_IDS &&
    ids.every(
      (id) =>
        typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH,
    );
  if (!valid) {
    throw new TightbeamError(
      "malformed_request",
      `message_ids must be an array of 1 to ${MAX_IDS} non-empty strings of at most ${MAX_ID_LENGTH} characters`,
      { field: "message_ids" },
    );
  }
  return ids;
}

// Every endpoint ever bound to the host (endpoint_host_bindings, so a headless
// resume clearing endpoints.host_name does not hide its messages), plus the
// lineage on both sides, in one query. Same walk as predecessorEndpointIds
// (thread_list.mjs): follow resume_requests.replacement_endpoint_id backwards
// to predecessors, and forwards to recovery replacements (the daemon creates
// one with no host_name), only through endpoints created by the hosted
// endpoint's app. UNION dedups, so a cycle terminates.
function authorizedEndpointIds(db, hostName) {
  if (typeof hostName !== "string") return new Set();
  const rows = db
    .prepare(
      `WITH RECURSIVE lineage(id, app_id) AS (
         SELECT e.id, e.created_by_app_id FROM endpoint_host_bindings b JOIN endpoints e ON e.id = b.endpoint_id WHERE b.host_name = ?
         UNION
         SELECT rr.endpoint_id, lineage.app_id
           FROM resume_requests rr
           JOIN lineage ON rr.replacement_endpoint_id = lineage.id
           JOIN endpoints e ON e.id = rr.endpoint_id AND e.created_by_app_id = lineage.app_id
         UNION
         SELECT rr.replacement_endpoint_id, lineage.app_id
           FROM resume_requests rr
           JOIN lineage ON rr.endpoint_id = lineage.id
           JOIN endpoints e ON e.id = rr.replacement_endpoint_id AND e.created_by_app_id = lineage.app_id
       )
       SELECT DISTINCT id FROM lineage`,
    )
    .all(hostName);
  return new Set(rows.map((row) => row.id));
}

function senderEndpointId(effectPayload) {
  try {
    const id = JSON.parse(effectPayload ?? "{}")?.declaration
      ?.sender_endpoint_id;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

function prepareQueries(db) {
  return {
    message: db.prepare(
      `SELECT m.id, m.conversation_id, m.body, m.created_at, m.in_reply_to_message_id, m.sender_principal_id,
              c.metadata AS conversation_metadata, origin.selector AS origin_channel_selector,
              sp.display_name AS sender_display_name, me.effect_payload AS effect_payload
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         LEFT JOIN channel_routes origin ON origin.id = m.origin_channel_route_id
         LEFT JOIN principals sp ON sp.id = m.sender_principal_id
         LEFT JOIN message_effects me ON me.message_id = m.id
        WHERE m.id = ?`,
    ),
    // Same joins and orders as message.delivery.list.
    endpointDeliveries: db.prepare(
      `SELECT d.id AS delivery_id, d.endpoint_id, d.state, d.read_at, d.acknowledged_at,
              e.principal_id, rp.display_name
         FROM deliveries d
         LEFT JOIN endpoints e ON e.id = d.endpoint_id
         LEFT JOIN principals rp ON rp.id = e.principal_id
        WHERE d.message_id = ? AND d.channel_route_id IS NULL
        ORDER BY d.created_at ASC, d.rowid ASC`,
    ),
    channelDeliveries: db.prepare(
      `SELECT d.id AS delivery_id, d.endpoint_id, d.state, d.read_at, d.acknowledged_at, r.selector, r.label
         FROM deliveries d
         JOIN channel_routes r ON r.id = d.channel_route_id
        WHERE d.message_id = ?
        ORDER BY r.selector ASC, d.id ASC`,
    ),
  };
}

function lookupEntry(queries, authorized, messageId) {
  const denied = { message_id: messageId, status: "denied" };
  const message = queries.message.get(messageId);
  if (!message) return denied;
  const endpointRows = queries.endpointDeliveries.all(messageId);
  const channelRows = queries.channelDeliveries.all(messageId);
  const senderEndpoint = senderEndpointId(message.effect_payload);
  const visible =
    [...endpointRows, ...channelRows].some((row) =>
      authorized.has(row.endpoint_id),
    ) ||
    (senderEndpoint !== null && authorized.has(senderEndpoint));
  if (!visible) return denied;
  return {
    message_id: message.id,
    status: "ok",
    conversation_id: message.conversation_id,
    subject: conversationSubject(message.conversation_metadata),
    created_at: message.created_at,
    body: message.body,
    in_reply_to_message_id: message.in_reply_to_message_id ?? null,
    origin_channel_selector: message.origin_channel_selector ?? null,
    sender: {
      principal_id: message.sender_principal_id ?? null,
      display_name: message.sender_display_name ?? null,
      endpoint_id: senderEndpoint,
    },
    body_truncated: false,
    deliveries_truncated: false,
    deliveries: [
      ...endpointRows.map((row) => ({
        delivery_id: row.delivery_id,
        recipient: {
          principal_id: row.principal_id ?? null,
          endpoint_id: row.endpoint_id,
          display_name: row.display_name ?? null,
        },
        delivery_state: computeDeliveryState(row),
      })),
      ...channelRows.map((row) => ({
        delivery_id: row.delivery_id,
        channel: { selector: row.selector, label: row.label },
        delivery_state: computeDeliveryState(row),
      })),
    ],
  };
}

const encodedSize = (entry) => Buffer.byteLength(JSON.stringify(entry), "utf8");

// The largest n in [0, max] whose build(n) fits the budget (or build(0)).
// Binary search: JSON escaping makes encoded size non-linear in length.
function longestFitting(max, build) {
  let low = 0;
  let high = max;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (encodedSize(build(mid)) <= ENCODED_BUDGET) low = mid;
    else high = mid - 1;
  }
  return build(low);
}

// An oversized first entry: cut body at a code-point boundary; if the entry
// still overflows with an empty body, keep the delivery prefix that fits.
function fitFirstEntry(entry) {
  const body = entry.body;
  const withBody = (length) => {
    let end = length;
    if (end > 0 && end < body.length && /[\uD800-\uDBFF]/.test(body[end - 1]))
      end -= 1;
    return {
      ...entry,
      body: body.slice(0, end),
      body_truncated: end < body.length,
    };
  };
  const cut = longestFitting(body.length, withBody);
  if (encodedSize(cut) <= ENCODED_BUDGET) return cut;
  const deliveries = entry.deliveries;
  // shortcut: subject is not cut; a subject near MAX_FRAME_BYTES fails the frame. Cut it if metadata ever gets a size bound or this is seen.
  return longestFitting(deliveries.length, (count) => ({
    ...cut,
    body: "",
    deliveries: deliveries.slice(0, count),
    deliveries_truncated: true,
  }));
}

export const hostMessageLookupOp = {
  name: "host.message.lookup",
  allowedScopes: ["agent"],
  permission: "host_sessions",
  handler(context, payload, connection) {
    const ids = validatedIds(payload);
    const hostName =
      context.db
        .prepare("SELECT name FROM applications WHERE id = ?")
        .get(connection.appId)?.name ?? null;
    const authorized = authorizedEndpointIds(context.db, hostName);
    const queries = prepareQueries(context.db);

    const messages = [];
    let used = 0;
    let truncated = false;
    for (const messageId of ids) {
      let entry = lookupEntry(queries, authorized, messageId);
      if (
        messages.length === 0 &&
        entry.status === "ok" &&
        encodedSize(entry) > ENCODED_BUDGET
      )
        entry = fitFirstEntry(entry);
      const size = encodedSize(entry);
      // The first entry is always returned, so a re-request always progresses.
      if (messages.length > 0 && used + size > ENCODED_BUDGET) {
        truncated = true;
        break;
      }
      messages.push(entry);
      used += size;
    }

    const ok = messages.filter((entry) => entry.status === "ok").length;
    context.logger?.info({
      event: "host.message_lookup",
      params: { requested: ids.length, host_name: hostName },
      result: { ok, denied: messages.length - ok, truncated },
      status: "ok",
    });
    return { result: { messages, truncated } };
  },
};
