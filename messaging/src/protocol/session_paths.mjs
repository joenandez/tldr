// Per-session hook scratch layout under the state root. Shared vocabulary
// only: the daemon may write a compatibility watermark when it writes a
// delivery, while exact receipt remains daemon-authorized — so the layout lives in
// src/protocol/, the one directory both sides may import
// (the architecture contract §5 import boundary rule).
//
//   <state-root>/sessions/<session_id>/
//     inbox.watermark      written by the daemon on every delivery write
//     inbox.seen           retired compatibility marker; never receipt
//     pending-inject.jsonl retired compatibility artifact; never a body
//     inject-quarantine.jsonl retired compatibility artifact
//     endpoint.json        the session's registered identity (a cache)
//
// Ported from helm/hooks/helm-prefetch-session-inbox.sh:29-33, whose
// per-session directory under ~/.helm/sessions/<id>/ carried the former
// injection roles. Tightbeam retains their paths only for compatibility;
// durable deliveries are never stored there.

import path from 'node:path';

// A session id becomes a directory name, so it is constrained to
// characters that cannot escape the sessions directory or confuse a shell
// hook: no separators, no leading dot, no whitespace. Both runtimes issue
// UUIDs, which fit comfortably.
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeSessionId(value) {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value) && !value.includes('..');
}

export function sessionsDir(stateRoot) {
  return path.join(stateRoot, 'sessions');
}

/**
 * Absolute paths for one session's hook scratch files. Throws rather than
 * returning a path built from an unvalidated session id — a hostile
 * `session_id` in a hook payload must never select the file that gets
 * written.
 */
export function sessionPaths(stateRoot, sessionId) {
  if (!isSafeSessionId(sessionId)) {
    throw new Error(`unsafe session id: ${JSON.stringify(sessionId)}`);
  }
  const dir = path.join(sessionsDir(stateRoot), sessionId);
  return {
    dir,
    watermark: path.join(dir, 'inbox.watermark'),
    seen: path.join(dir, 'inbox.seen'),
    pending: path.join(dir, 'pending-inject.jsonl'),
    quarantine: path.join(dir, 'inject-quarantine.jsonl'),
    action: path.join(dir, 'current-action-id'),
    endpoint: path.join(dir, 'endpoint.json'),
    recovery: path.join(dir, 'recovery-context.json'),
  };
}
