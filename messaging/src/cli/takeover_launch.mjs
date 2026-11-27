// ac-x09n0: the hook's endpoint cache is per provider session, but its process
// generation belongs to one launch, and every launch of the session shares the
// file. An availability-takeover successor whose SessionStart register was
// lost (bootstrap timeout, a refused claim) found the predecessor's cache and
// sent its old generation from every hook, so the endpoint stayed
// takeover_pending for good, and a fenced predecessor got an error per prompt.
// A launch that finds another launch's cache asks the daemon to adopt a
// pending takeover and nothing else (endpoint.register takeover_only, decided
// atomically there); any other endpoint state keeps the cache as before.
// Nothing about the fence is written locally: the shared file would hand it to
// the other launch. A request refused because a pending takeover or another
// launch's newer process generation owns the endpoint is one warn line, never
// an error.
import { createHash } from "node:crypto";
import { appendLog } from "./detach_log.mjs";
import { DETACHED_LAUNCH_TOKEN } from "./prompt_busy.mjs";

/** Another launch wrote this cache. A cache written before launches were recorded is trusted, as before. */
export function fromOtherLaunch(cached, identity) {
  return (
    cached.launch_token !== undefined &&
    cached.launch_token !== (identity?.launch_token ?? null)
  );
}

/**
 * The prompt foreground's owner process, captured only when this launch will re-register: the detached
 * worker cannot see the runtime process, and an adoption with no owner leaves the endpoint unwakeable.
 */
export function adoptionOwnerProcess(cached, identity, capture) {
  return cached && fromOtherLaunch(cached, identity) ? capture() : null;
}

function warn(ctx, log, fields) {
  const line = { level: "warn", status: "refused", ...fields };
  appendLog(ctx.paths, line);
  log(line);
}

function notOwner(cached, { ctx, log }, refusal) {
  warn(ctx, log, {
    event: "session_launch_not_owner",
    params: {
      session_id: ctx.identity.session_id,
      endpoint_id: cached.endpoint_id,
      ...refusal,
    },
  });
  return { ...cached, fenced: true };
}

async function adopt({ client, ctx, register, log }) {
  const endpoint = await register(client, {
    ...ctx,
    identity: { ...ctx.identity, takeover_only: true },
  });
  log({
    event: "session_reregistered_for_launch",
    session_id: ctx.identity.session_id,
    endpoint_id: endpoint.endpoint_id,
    process_generation: endpoint.process_generation,
    state: endpoint.state,
  });
  return endpoint;
}

function refusedAdoption(error, cached, deps) {
  if (error?.code !== "identity_conflict") throw error;
  // Not a pending takeover: the cache as before (a pane reopened on the session, an adopted successor's cache).
  if (error.details?.reason === "endpoint_not_takeover_pending") return cached;
  return notOwner(cached, deps, {
    reason: error.details?.reason ?? null,
    message: error.message,
  });
}

/**
 * Adopt a pending takeover under this launch. Without owner evidence (a detached worker, a Copilot prompt)
 * it never asks and keeps the cache, as before; a refused request is then classified by unlessSuperseded.
 * A refused adoption returns the cache marked fenced in memory only, and the hook stays quiet.
 */
export async function registerThisLaunch(cached, deps) {
  if (!deps.ctx.identity.owner_process) return cached;
  return adopt(deps).catch((error) => refusedAdoption(error, cached, deps));
}

/**
 * ac-os0zc: the request field naming this launch, so the daemon refuses a request built on another running
 * launch's cached generation. A worker that was not told its launch names none: absent is unchecked, as before.
 */
export function callerLaunch(ctx) {
  return ctx.launchUnknown || ctx.identity?.launch_token === undefined
    ? {}
    : { caller_launch_token: ctx.identity.launch_token ?? null };
}

/** A detached worker's env has no session vars (Codex r1 F1): its launch rides the payload, or is unknown. */
export function workerLaunch(identity, payload) {
  return Object.hasOwn(payload ?? {}, DETACHED_LAUNCH_TOKEN)
    ? {
        identity: { ...identity, launch_token: payload[DETACHED_LAUNCH_TOKEN] },
      }
    : { launchUnknown: true };
}

const OWNERSHIP_REFUSALS = new Set([
  "identity_conflict",
  "obligation_conflict",
  "permission_denied",
]);
// The digest endpoint.list projects for the row's owner launch token (null without one).
function launchDigest(token) {
  return token
    ? `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`
    : null;
}

// Read from the row alone, so it does not wait on the other launch's cache write. The generation only moves
// forward. A moved generation fences this process only when a takeover's launch holds the row (a takeover
// always records a token): this launch's own revival records its token or none (a token another Codex thread
// holds is dropped), and that refusal stays an error, as before (Codex r4, r6). No digest (an older daemon): as before.
function superseded(endpoint, row, { ctx }) {
  if (row?.state === "takeover_pending") return true;
  return (
    Number.isSafeInteger(row?.process_generation) &&
    row.process_generation !== endpoint.process_generation &&
    typeof row.owner_launch_digest === "string" &&
    row.owner_launch_digest !== launchDigest(ctx.identity?.launch_token)
  );
}

/**
 * send() for this process's endpoint, or null (one warn line) when it is fenced, or the daemon refused it
 * because a pending takeover or a newer process generation owns the endpoint. Any other error is thrown.
 */
export async function unlessSuperseded(endpoint, send, deps) {
  const { client, ctx, stored, log } = deps;
  if (endpoint.fenced) return null;
  try {
    return await send();
  } catch (error) {
    if (!OWNERSHIP_REFUSALS.has(error?.code)) throw error;
    // ac-os0zc: the daemon saw another launch of this session own the endpoint and run; no row read needed.
    const notOwnerLaunch = error.details?.reason === "launch_not_owner";
    const row = notOwnerLaunch
      ? null
      : await stored(client, ctx.identity).catch(() => null);
    if (!notOwnerLaunch && !superseded(endpoint, row, deps)) throw error;
    warn(ctx, log, {
      event: "endpoint_takeover_fenced",
      message:
        "another launch owns or is taking over this session; this process is fenced and does not report state",
      params: {
        session_id: ctx.identity.session_id,
        endpoint_id: endpoint.endpoint_id,
        process_generation: endpoint.process_generation,
        endpoint_state: row?.state ?? null,
        code: error.code,
        reason: error.details?.reason ?? null,
      },
    });
    return null;
  }
}

/** endpoint.state.set, quiet when this process is fenced or superseded. */
export async function setStateUnlessFenced(endpoint, request, deps) {
  const result = await unlessSuperseded(
    endpoint,
    () => deps.client.request("endpoint.state.set", request),
    deps,
  );
  return (
    result ?? {
      endpoint_id: endpoint.endpoint_id,
      state: "takeover_pending",
      takeover_fenced: true,
    }
  );
}

/** The drain's message.notification.next, or null when this process is fenced or superseded. */
export function nextNotificationUnlessFenced(endpoint, request, deps) {
  return unlessSuperseded(
    endpoint,
    () => deps.client.request("message.notification.next", request),
    deps,
  );
}

// ac-os0zc: a launch's own lane of the session dir (detach payloads and locks, the prompt record).
const LANE = /^l-(none|[0-9a-f]{12})$/;

/** The session paths keyed to one launch: its token's digest, or `l-none` for a launch with none. */
export function launchPaths(paths, launchToken) {
  const lane = launchToken
    ? `l-${createHash("sha256").update(launchToken, "utf8").digest("hex").slice(0, 12)}`
    : "l-none";
  return { ...paths, lane };
}

/** The paths a worker was spawned for (`--detach-lane`); an unknown lane is refused, never used in a file name. */
export function workerPaths(paths, lane) {
  if (lane === undefined) return paths;
  if (!LANE.test(lane))
    throw new Error(`invalid --detach-lane: ${JSON.stringify(lane)}`);
  return { ...paths, lane };
}
