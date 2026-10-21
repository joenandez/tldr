// F34: who holds a Codex thread right now.
//
// Since Codex 0.161 a TUI runs its thread inside one managed `codex
// app-server` that outlives the TUI (a /exit, a crash, a SIGKILL) and keeps
// the thread's writer lock, CODEX_HOME/thread-writer-locks/<id>.lock, until
// it unloads the thread. `codex exec resume <id>` opens its own thread store
// and is refused by Codex with "thread <id> already has an active writer"
// (live proof pass 6: 8 failing launches in ~10 s, message stranded). Codex
// refusing is correct; the daemon must not be the second writer, and must
// not burn a retry budget on a launch that cannot succeed.
//
// A session is HOSTED when that lock file exists and a live process holds it
// open. The lock file alone is not evidence (an app-server killed hard
// leaves it behind), and an unanswerable probe is unknown, never permission.
// The probe itself (lsof) lives in retirement_executor.mjs with the daemon's
// other fixed process probes; it is injected here so every answer is testable.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { observeFileHolders as defaultObserveFileHolders } from './retirement_executor.mjs';

// What a provider session id may look like on its way into a file name: a
// plain token, no separators, no leading dot or dash.
const SAFE_SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/;

// Codex's own words when a second writer opens a thread an app-server holds
// (captured live, Codex 0.162, in both the log line and the final error).
const WRITER_CONFLICT = /thread\s+(\S+)\s+already has an active writer/gi;

/** The Codex home this daemon (and so every child it launches) uses. */
export function resolveCodexHome(env = process.env, home = os.homedir()) {
  const configured = env?.CODEX_HOME;
  if (typeof configured === 'string' && path.isAbsolute(configured)) return configured;
  return path.join(home, '.codex');
}

/** Absolute path of one thread's writer lock, or null when the id could not be a plain file name. */
export function threadWriterLockPath(codexHome, sessionId) {
  if (typeof sessionId !== 'string' || !SAFE_SESSION_ID.test(sessionId)) return null;
  return path.join(codexHome, 'thread-writer-locks', `${sessionId}.lock`);
}

/**
 * Whether a live process hosts this Codex thread.
 *   hosted true   the lock file exists and `holder_pids` hold it open
 *   hosted false  no lock file, or one nobody holds (stale)
 *   hosted null   unknown: unsafe session id, or the holder probe could not answer
 * `observeFileHolders` is a parameter so tests drive every answer.
 */
export function observeCodexThreadHost({ sessionId, env = process.env, home = os.homedir(), observeFileHolders = defaultObserveFileHolders } = {}) {
  const lockPath = threadWriterLockPath(resolveCodexHome(env, home), sessionId);
  if (lockPath === null) return { hosted: null, reason: 'unsafe_session_id', lock_path: null };
  if (!fs.existsSync(lockPath)) return { hosted: false, reason: 'no_lock_file', lock_path: lockPath };
  let observed;
  try {
    observed = observeFileHolders(lockPath);
  } catch (error) {
    return { hosted: null, reason: 'holder_probe_unavailable', lock_path: lockPath, error: error.message };
  }
  if (!observed || observed.unavailable || !Array.isArray(observed.pids)) return { hosted: null, reason: 'holder_probe_unavailable', lock_path: lockPath };
  if (observed.pids.length === 0) return { hosted: false, reason: 'lock_unheld', lock_path: lockPath };
  return { hosted: true, reason: 'lock_held_by_live_process', lock_path: lockPath, holder_pids: observed.pids };
}

/** The daemon's default host observer: this context's environment decides which Codex home is asked. */
export function threadHostObserverFor(context) {
  return ({ sessionId }) => observeCodexThreadHost({ sessionId, env: context?.env ?? process.env });
}

// Codex's words when `codex queue` finds no app-server session for the thread
// (captured live, Codex 0.162, for a thread an IDE or pane hosts over stdio).
const NO_ACTIVE_SESSION = /No active session found/i;

/**
 * Why `codex queue` was refused, from its stderr: `no_active_session` is the
 * managed app-server saying it does not host the thread (another app holds
 * the lock, and that does not change while the app stays open) and is the
 * only answer that counts toward the refusal limit; `unclassified` is anything
 * else (a reset connection, a permission error) and has its own, time-based bound.
 */
export function classifyQueueRefusal(stderr) {
  return typeof stderr === 'string' && NO_ACTIVE_SESSION.test(stderr) ? 'no_active_session' : 'unclassified';
}

/** True when child stderr is Codex refusing a second writer on THIS thread. */
export function isThreadWriterConflict(stderr, sessionId) {
  if (typeof stderr !== 'string' || typeof sessionId !== 'string' || sessionId.length === 0) return false;
  for (const match of stderr.matchAll(WRITER_CONFLICT)) if (match[1] === sessionId) return true;
  return false;
}
