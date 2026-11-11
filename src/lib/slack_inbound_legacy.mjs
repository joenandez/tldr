import { readFileSync } from "node:fs";
import { join } from "node:path";

import { listTightbeamSessions } from "../../scheduling/src/lib/tightbeam_sessions.mjs";
import {
  THREAD_PREPARING,
  lookupThreadLaunch,
  recordThreadLaunch,
  write,
} from "./slack_channel_map.mjs";

// Past this since the first attempt to start it a post that still cannot be
// delivered counts as failed, so one stuck post never blocks the drain.
const LAUNCH_DEADLINE_MS = 60_000;

export const nowIso = (ctx) => new Date((ctx.now ?? Date.now)()).toISOString();

export const leftMs = (ctx, launchedAt) =>
  Math.max(
    0,
    Date.parse(launchedAt) + LAUNCH_DEADLINE_MS - (ctx.now ?? Date.now)(),
  );

// {retry} or, past the deadline, {expired} for an old row's session id that
// cannot be read now (the id file, the lookup). The first failure is stored on the row (retry_since), so a
// daemon restart does not restart the wait.
function waitOrExpire(ctx, launched) {
  const key = { channelId: launched.channel_id, rootTs: launched.root_ts };
  write(ctx.home, (db) =>
    db
      .prepare(
        "UPDATE thread_launch SET retry_since = COALESCE(retry_since, ?) WHERE channel_id = ? AND root_ts = ?",
      )
      .run(nowIso(ctx), key.channelId, key.rootTs),
  );
  const since = lookupThreadLaunch(ctx.home, key).retry_since;
  return leftMs(ctx, since) > 0 ? { retry: true } : { expired: true };
}

// A Codex row's thread id is in a file the old launcher saved. Missing is a
// fact ({id: null}); any other read error is not, so it is logged and retried.
function readSidecar(ctx, launched) {
  const file = join(
    ctx.home,
    "slack",
    "launches",
    `${launched.session_key}.id`,
  );
  try {
    return { id: readFileSync(file, "utf8").trim() };
  } catch (error) {
    if (error.code === "ENOENT") return { id: null };
    ctx.logger?.({
      event: "slack_inbound_legacy_sidecar_unreadable",
      status: "warn",
      params: { channel: launched.channel_id, ts: launched.root_ts },
      result: { code: error.code, message: error.message },
    });
    return { unreadable: true };
  }
}

// A row written before the upgrade names its session by provider id: Claude's
// launch uuid, or the Codex thread id the old launcher saved under the home.
// {id}, or {retry} / {expired} when it cannot be read now, or {} when it is gone.
function legacyProviderId(ctx, launched) {
  const read =
    launched.runtime === "codex"
      ? readSidecar(ctx, launched)
      : { id: launched.session_key };
  if (read.id) return { id: read.id };
  if (read.unreadable) return waitOrExpire(ctx, launched);
  return leftMs(ctx, launched.launched_at) > 0 ? { retry: true } : {};
}

// The old session's exact endpoint, by provider id only (never "newest by
// name"): {endpointId, principalId}, {retry} / {expired} when it cannot be told
// now, or {} when the session is gone.
async function resolveLegacySession(ctx, launched) {
  const { id: providerId, ...wait } = legacyProviderId(ctx, launched);
  if (!providerId) return wait;
  const list =
    ctx.listSessions ??
    ((filters) =>
      listTightbeamSessions(filters, { env: ctx.env, hookApp: true }));
  const found = await list({ sessionId: providerId });
  if (!found.ok) return waitOrExpire(ctx, launched);
  const session = found.sessions.find(
    (row) => row.session_id === providerId && row.endpoint_id,
  );
  return session
    ? { endpointId: session.endpoint_id, principalId: session.principal_id }
    : {};
}

const endpointOf = (row) =>
  row.endpoint_id
    ? { endpointId: row.endpoint_id, principalId: row.principal_id }
    : {};

// The endpoint a started thread's replies go to. A row written before upgrade
// has none: resolve it once and store it on the row. {endpointId}, {retry} or {}.
export async function launchedEndpoint(ctx, launched, key) {
  // A post whose placeholder was never prepared owns no session to reply to.
  if (launched.endpoint_id || launched.session_key === THREAD_PREPARING)
    return endpointOf(launched);
  const legacy = await resolveLegacySession(ctx, launched);
  ctx.logger?.({
    event: "slack_inbound_legacy_launch_resolved",
    status: legacy.retry ? "retry" : "ok",
    params: key,
    result: { found: Boolean(legacy.endpointId) },
  });
  // Another drain may have stored this root's endpoint while we awaited: use it.
  const stored = lookupThreadLaunch(ctx.home, key);
  if (!stored?.endpoint_id && legacy.endpointId) {
    recordThreadLaunch(ctx.home, {
      ...key,
      ...legacy,
      runtime: launched.runtime,
      launchedAt: launched.launched_at,
    });
  }
  return stored?.endpoint_id ? endpointOf(stored) : legacy;
}
