import { openHookClient } from "./email_intent_send_commit.mjs";
import { readOne } from "./slack_channel_map.mjs";
import { resolveStateRoot } from "../../messaging/src/protocol/state_root_location.mjs";

// The endpoint list is capped (1,000, newest first) and sees only one app's
// endpoints, so a recipient missing from it is not proof of anything. Each omitted
// recipient is read by its exact id (endpoint.list's endpoint_id filter, as the app
// that registered it): the placeholder or session it is, closed or not, else
// "unknown", which keeps the status and never asserts non-receipt.

// {ok, endpoint}: endpoint is the row, or null when no such endpoint exists.
async function hookLookup(endpointId, { env = process.env } = {}) {
  const client = await openHookClient(resolveStateRoot({ env }));
  try {
    const listed = await client.request("endpoint.list", {
      endpoint_id: endpointId,
      include_closed: true,
      limit: 1,
    });
    const found = (listed.endpoints ?? []).find(
      (row) => row.endpoint_id === endpointId,
    );
    return { ok: true, endpoint: found ?? null };
  } finally {
    await client.close();
  }
}

async function lookupEndpoint(ctx, endpointId) {
  try {
    return await (ctx.lookupEndpoint ?? hookLookup)(endpointId, ctx);
  } catch (error) {
    ctx.logger?.({
      event: "slack_working_endpoint_lookup_failed",
      status: "warn",
      params: { endpoint_id: endpointId },
      result: { code: error.code ?? null, message: error.message },
    });
    return { ok: false };
  }
}

// An endpoint this daemon registered as a placeholder (thread_launch holds it by
// endpoint, not by thread key).
function registeredHere(ctx, endpointId) {
  try {
    return Boolean(
      readOne(
        ctx.home,
        "SELECT 1 AS hit FROM thread_launch WHERE endpoint_id = ?",
        endpointId,
      ),
    );
  } catch {
    return false; // an old table without endpoint_id registered none
  }
}

// Where the lookup puts a recipient: a session row, or a placeholder state.
function placed({ rows, placeholders }, id, found) {
  const endpoint = found.ok ? found.endpoint : null;
  if (!endpoint) return placeholders.set(id, "unknown");
  if (endpoint.provider_session_id) {
    const updated = Date.parse(endpoint.updated_at ?? "");
    return rows.push({
      endpoint_id: id,
      state: endpoint.state,
      state_since: Number.isFinite(updated) ? updated : null,
    });
  }
  return placeholders.set(id, endpoint.state ?? "unknown");
}

// The list with every recipient it lacks that cannot be called gone resolved by an
// exact lookup: all of them when the list is truncated, and ours when it is complete
// (a complete list still cannot see what another identity registered). A complete
// list that lacks a recipient we never registered stays "gone".
export async function withLookups(ctx, deliveries, list) {
  if (!list) return list;
  const present = (id) =>
    list.placeholders.has(id) || list.rows.some((s) => s.endpoint_id === id);
  const omitted = [...new Set(deliveries.map((d) => d.endpoint_id))].filter(
    (id) => !present(id) && (list.truncated || registeredHere(ctx, id)),
  );
  if (!omitted.length) return list;
  const next = {
    ...list,
    rows: [...list.rows],
    placeholders: new Map(list.placeholders),
  };
  const found = await Promise.all(omitted.map((id) => lookupEndpoint(ctx, id)));
  omitted.forEach((id, i) => placed(next, id, found[i]));
  return next;
}
