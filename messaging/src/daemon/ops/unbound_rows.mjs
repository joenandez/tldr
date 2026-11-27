// Which endpoints of one recipient principal get a delivery row when an agent
// post has no target or binding (ac-jfv.209). Before, every open endpoint got
// one: a single post wrote 471 rows and 463 were never read. It imports nothing
// from message_shared.mjs (no import cycle).

export function timestampMs(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/**
 * The endpoint's last recorded activity: `endpoints.updated_at`, which the
 * lifecycle hook transitions, listener attach, registration and replay, and
 * supervised death all bump. A reply binding may contribute its own anchor
 * (sending is activity the endpoint row does not record).
 */
export function lastActivityMs(endpoint, anchorAt = null) {
  return Math.max(
    timestampMs(endpoint.updated_at),
    timestampMs(endpoint.created_at),
    timestampMs(anchorAt),
  );
}

// Newest activity first, then newest created_at, then endpoint id.
export function byMostRecentActivity(a, b) {
  return (
    lastActivityMs(b) - lastActivityMs(a) ||
    timestampMs(b.created_at) - timestampMs(a.created_at) ||
    (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  );
}

const LIVE_STATES = new Set(["busy", "idle"]);

// Busy or idle, owner not seen exiting, and active within the resume window:
// a frozen or exited session may never read its row.
function isLive(endpoint, { nowMs, staleAfterMs }) {
  if (!LIVE_STATES.has(endpoint.state) || endpoint.owner_process_exited_at)
    return false;
  // No clock (pure callers): never stale, as isStaleResumeTarget treats it.
  if (!Number.isFinite(nowMs) || !Number.isFinite(staleAfterMs)) return true;
  return nowMs - lastActivityMs(endpoint) <= staleAfterMs;
}

// Fallback order: live busy (reads at its next Stop), live idle, the rest.
function liveThenRecent(clock) {
  const tier = (endpoint) =>
    !isLive(endpoint, clock) ? 2 : endpoint.state === "busy" ? 0 : 1;
  return (a, b) => tier(a) - tier(b) || byMostRecentActivity(a, b);
}

// Mirrors session_host.mjs maybeRequestHostWake: the post-commit fan-out
// host-wakes an idle interactive hosted session that holds a row.
function isHostedIdle(endpoint, route) {
  if (route !== "enqueue_only" || endpoint.state !== "idle") return false;
  if (!endpoint.host_name || endpoint.owner_process_exited_at) return false;
  return endpoint.launch_mode !== "non_interactive";
}

// A dead interactive or unknown session resumes only with exit proof.
const isUncertainResume = (endpoint, route) =>
  route === "resume_dead" && endpoint.launch_mode !== "non_interactive";

function wakeBasis({ endpoint, route, resumeEndpointId, hostWokenIds }) {
  if (route === "stage_presentation") return "presented";
  if (hostWokenIds.has(endpoint.id)) return "host_wake";
  return endpoint.id === resumeEndpointId ? "resumed" : null;
}

// A presented session reads at once; a host-woken or thread session (holds
// open work in the conversation, or sent its agent's latest message there)
// when it is live; a resumed one unless its launch is uncertain.
function rowBasis(input) {
  const { endpoint, route, threadIds, clock } = input;
  const thread = threadIds.has(endpoint.id);
  const liveThread = thread && isLive(endpoint, clock);
  const basis = wakeBasis(input) ?? (thread ? "thread_session" : null);
  if (basis === null) return null;
  const sure =
    liveThread ||
    basis === "presented" ||
    (basis === "host_wake" && isLive(endpoint, clock)) ||
    (basis === "resumed" && !isUncertainResume(endpoint, route));
  return { basis, sure };
}

// Hosted idle sessions the commit will host-wake: all of them when the post
// host-wakes, else only those already holding unread host-waking mail.
function hostWokenEndpointIds({
  endpoints,
  routes,
  hostWakes,
  pendingHostWakeIds,
}) {
  const ids = endpoints
    .filter((endpoint) => isHostedIdle(endpoint, routes.get(endpoint.id)))
    .map((endpoint) => endpoint.id);
  if (hostWakes || ids.length === 0) return new Set(ids);
  return pendingHostWakeIds ? pendingHostWakeIds(ids) : new Set();
}

/**
 * Rows go only to the endpoints the post wakes or that work its thread:
 * every live presentation, every session the commit host-wakes, the resumed
 * endpoint, and the thread sessions (`threadEndpointIds()`, computed only
 * here). When none of them is a sure reader, one more row goes to the most
 * recently active live busy, else live idle, else any endpoint so the message
 * stays in the agent's inbox. `nowMs`/`staleAfterMs` define live (the resume window).
 */
export function narrowUnboundRows({
  endpoints,
  routes,
  resumeEndpointId,
  threadEndpointIds = null,
  hostWakes = true,
  pendingHostWakeIds = null,
  nowMs = Number.NaN,
  staleAfterMs = Number.NaN,
}) {
  const clock = { nowMs, staleAfterMs };
  const hostWokenIds = hostWokenEndpointIds({
    endpoints,
    routes,
    hostWakes,
    pendingHostWakeIds,
  });
  const threadIds = threadEndpointIds?.() ?? new Set();
  const kept = [];
  const bases = new Set();
  let sure = false;
  for (const endpoint of endpoints) {
    const row = rowBasis({
      endpoint,
      route: routes.get(endpoint.id),
      resumeEndpointId,
      hostWokenIds,
      threadIds,
      clock,
    });
    if (!row) continue;
    kept.push(endpoint);
    bases.add(row.basis);
    sure ||= row.sure;
  }
  if (!sure) {
    const fallback = endpoints
      .filter((endpoint) => !kept.includes(endpoint))
      .sort(liveThenRecent(clock))[0];
    if (fallback) {
      kept.push(fallback);
      bases.add("newest_fallback");
    }
  }
  return {
    rowEndpoints: kept,
    rowBasis: [...bases].sort().join("+") || "none",
  };
}

/**
 * The sessions working this conversation for one recipient agent: custodians
 * of open work, and the endpoint that sent the agent's latest agent-authored
 * message there (daemon notices excluded; inbound mail has no sender endpoint).
 */
export function threadSessionEndpointIds(db, conversationId, principalId) {
  const ids = new Set(
    db
      .prepare(
        "SELECT custodian_endpoint_id AS id FROM obligations WHERE conversation_id = ? AND status = 'open' AND custodian_endpoint_id IS NOT NULL",
      )
      .all(conversationId)
      .map((row) => row.id),
  );
  const speaker = db
    .prepare(
      `SELECT json_extract(me.effect_payload, '$.declaration.sender_endpoint_id') AS endpoint_id
         FROM messages m JOIN message_effects me ON me.message_id = m.id
        WHERE m.conversation_id = ? AND m.origin = 'agent' AND m.sender_principal_id = ?
          AND json_extract(me.effect_payload, '$.notice') IS NULL
        ORDER BY m.created_at DESC, m.id DESC LIMIT 1`,
    )
    .get(conversationId, principalId);
  if (typeof speaker?.endpoint_id === "string") ids.add(speaker.endpoint_id);
  return ids;
}
