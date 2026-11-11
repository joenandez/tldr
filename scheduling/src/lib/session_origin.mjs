// session_origin — `assignments session-origin --session <id>`: the directory a
// session worked in, cheap enough for a click path.
//
// Primary: the session's Tightbeam endpoint (one `tightbeam endpoint list
// --session` call; authority_reference is the cwd the session registered with).
// Fallback: the origin.json Helm writes when it spawns a session (one file
// read). resolveOriginForSession's agent-run scan is never used here: it reads
// every run file and is too slow for a request path.

import { readSessionOrigin } from "./agent_run_session.mjs";
import { fail, output } from "./json_io.mjs";
import { listTightbeamSessions } from "./tightbeam_sessions.mjs";

// A provider session id: no path separators, no leading dash.
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export const isValidSessionId = (value) =>
  typeof value === "string" && SESSION_ID.test(value);

// A slow Tightbeam must not hold a click; past this the spawn record answers.
export const TIGHTBEAM_TIMEOUT_MS = 2_000;

// A resumed session can leave closed endpoints behind: the open one is where it
// works now, else the most recently updated.
function currentEndpoint(sessions, sessionId) {
  const matches = sessions
    .filter((s) => s.session_id === sessionId && s.cwd)
    .sort((a, b) => (b.state_since ?? 0) - (a.state_since ?? 0));
  return matches.find((s) => s.state !== "closed") || matches[0] || null;
}

// Resolves to { ok: true, origin } or { ok: false, code, details }. Never throws.
export async function resolveSessionOrigin(
  sessionId,
  { lookupTightbeam = listTightbeamSessions } = {},
) {
  const helm = readSessionOrigin(sessionId);
  const origin = (cwd, source, runtime = null) => ({
    session_id: sessionId,
    cwd,
    source,
    runtime,
    job_id: helm?.origin_job_id ?? null,
    run_id: helm?.origin_run_id ?? null,
  });
  const tightbeam = await lookupTightbeam(
    { sessionId, includeClosed: true },
    { hookApp: true, timeoutMs: TIGHTBEAM_TIMEOUT_MS },
  );
  const endpoint = tightbeam.ok
    ? currentEndpoint(tightbeam.sessions, sessionId)
    : null;
  if (endpoint) {
    return {
      ok: true,
      origin: origin(endpoint.cwd, "tightbeam", endpoint.runtime),
    };
  }
  if (helm?.cwd) return { ok: true, origin: origin(helm.cwd, "helm_run") };
  return tightbeam.ok
    ? {
        ok: false,
        code: "origin_not_found",
        details: { session_id: sessionId },
      }
    : {
        ok: false,
        code: "origin_lookup_failed",
        details: { session_id: sessionId, tightbeam_error: tightbeam.error },
      };
}

const MESSAGES = {
  origin_not_found:
    "neither Tightbeam nor Helm's spawn records know this session",
  origin_lookup_failed:
    "Tightbeam could not be read and Helm has no spawn record for this session",
};

export async function handleSessionOrigin(flags, pretty) {
  const cmd = "session-origin";
  if (!isValidSessionId(flags.session)) {
    fail(
      cmd,
      "session_id_invalid",
      "--session <id> is required: a provider session id with no path separators",
      {},
      pretty,
    );
    process.exit(2);
  }
  const result = await resolveSessionOrigin(flags.session);
  if (result.ok) {
    output(cmd, true, result.origin, [], pretty);
    return;
  }
  fail(cmd, result.code, MESSAGES[result.code], result.details, pretty);
  process.exit(1);
}
