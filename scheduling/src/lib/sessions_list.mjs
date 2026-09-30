// Sessions list view for `helm-tasks sessions list`.
//
// Read-only. Session facts come from Tightbeam's session endpoints
// (`tightbeam endpoint list`, see tightbeam_sessions.mjs). Sessions that
// registered only through Helm's retired hooks are still listed from their
// legacy ~/.helm/sessions/<id>/identity.json + state.json files for one
// release, marked `source: "helm_legacy"`; when Tightbeam knows a session,
// Tightbeam's facts win. Session identity is the full session_id.

import { listSessions, readIdentity, readState } from "./identity_state.mjs";
import { listTightbeamSessions } from "./tightbeam_sessions.mjs";

// endpoint.list's maximum page. Newest sessions first, so a cut-off list
// drops the oldest; the result reports it as `tightbeam_truncated`.
const TIGHTBEAM_SESSION_PAGE = 1000;

function defaultAdapters() {
  return {
    listTightbeamSessions,
    listSessions,
    readIdentity,
    readState,
  };
}

function entryFromTightbeam(session) {
  return {
    session_id: session.session_id,
    runtime: session.runtime,
    runtime_version: null,
    install_path: session.cwd,
    pid: session.pid,
    controlling_tty: null,
    launch_mode: session.launch_mode,
    session_started_at: session.session_started_at,
    state: session.state,
    state_since: session.state_since,
    last_pid: session.pid,
    source: "tightbeam",
  };
}

function entryFromLegacy(sessionId, identity, stateRow) {
  return {
    session_id: sessionId,
    runtime: identity.runtime || null,
    runtime_version: identity.runtime_version || null,
    install_path: identity.install_path || null,
    pid: identity.pid || null,
    controlling_tty: identity.controlling_tty || null,
    launch_mode: identity.launch_mode || null,
    session_started_at: identity.session_started_at || null,
    state: stateRow?.state || null,
    state_since: stateRow?.since || null,
    last_pid: stateRow?.last_pid || null,
    source: "helm_legacy",
  };
}

export async function listSessionsForCli({
  state = null,
  limit = null,
  adapters: injectedAdapters = null,
} = {}) {
  const adapters = { ...defaultAdapters(), ...(injectedAdapters || {}) };
  const tightbeam = await adapters.listTightbeamSessions({
    limit: TIGHTBEAM_SESSION_PAGE,
  });
  const all = [];
  const known = new Set();
  if (tightbeam.ok) {
    for (const session of tightbeam.sessions) {
      if (known.has(session.session_id)) continue;
      known.add(session.session_id);
      all.push(entryFromTightbeam(session));
    }
  }
  let legacyCount = 0;
  for (const sessionId of adapters.listSessions()) {
    if (known.has(sessionId)) continue;
    const identity = adapters.readIdentity(sessionId) || {};
    const stateRow = adapters.readState(sessionId) || null;
    all.push(entryFromLegacy(sessionId, identity, stateRow));
    legacyCount += 1;
  }
  const sessions = state ? all.filter((entry) => entry.state === state) : all;
  sessions.sort((a, b) =>
    (b.session_started_at || "").localeCompare(a.session_started_at || ""),
  );
  const parsedLimit = limit ? Number(limit) : null;
  const limited = parsedLimit ? sessions.slice(0, parsedLimit) : sessions;
  return {
    sessions: limited,
    total: sessions.length,
    truncated: parsedLimit ? sessions.length > parsedLimit : false,
    session_source: {
      tightbeam: tightbeam.ok ? "ok" : tightbeam.error,
      tightbeam_truncated: tightbeam.ok ? tightbeam.truncated : false,
      legacy_sessions: legacyCount,
    },
  };
}
