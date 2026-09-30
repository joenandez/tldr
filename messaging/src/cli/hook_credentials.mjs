// How a hook authenticates.
//
// A hook is not special: it performs the same `protocol.handshake` with an
// app id and app secret that every other application does
// (docs/security-model.md "Identifier kinds"). What is special is that a
// hook is started by the runtime, not by an operator, so it inherits no
// shell environment worth relying on — a session started from Finder, from
// a launchd job, or from another agent has whatever env its parent had.
//
// So the credential comes from a file the operator writes once:
//
//   <state-root>/hook-app.json   mode 0600
//   { "app_id": "app_…", "app_secret": "…", "authority_name": "…",
//     "principal_ref": "…" (optional), "runtime": "…" (optional) }
//
// This adds no new trust: the state root is already 0700 owner-only and
// already holds the database and the admin bootstrap nonce
// (the architecture contract §3, §4), so a process that can read this file can
// already read every message in the database directly. It weakens nothing
// either — the daemon still verifies the secret against its scrypt hash,
// the app still holds only the permissions an admin granted it, and the
// daemon never reads this file. Flags and environment variables keep
// precedence for callers that do have a controlled environment.

import fs from 'node:fs';
import path from 'node:path';

export const HOOK_CREDENTIALS_FILENAME = 'hook-app.json';

export function hookCredentialsPath(stateRoot) {
  return path.join(stateRoot, HOOK_CREDENTIALS_FILENAME);
}

/**
 * Reads the hook credential file, or returns null when it does not exist.
 * A file readable by group or other is refused rather than used: an app
 * secret with loose permissions is a finding, and silently accepting it
 * would make the 0700 state root's guarantee untrue.
 */
export function readHookCredentials(stateRoot) {
  const file = hookCredentialsPath(stateRoot);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (stat.mode & 0o077) {
    throw new Error(`${file} is readable beyond its owner (mode ${(stat.mode & 0o777).toString(8)}); chmod 600 it before use`);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`failed to parse ${file}: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} must contain a JSON object`);
  }
  return parsed;
}
