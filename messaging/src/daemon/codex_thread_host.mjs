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
// The probe itself (lsof, async) lives in process_table.mjs with the daemon's
// other process probes; the synchronous observer the deciders call reads a
// per-lock-path cache of it (`cachedHolderObserver`, holder_cache.mjs) and
// never waits on lsof.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { cachedHolderObserver } from './holder_cache.mjs';

export { cachedHolderObserver };

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

export const HOLDER_PROBE_PENDING = 'holder_probe_pending';
// Takeover's final check: the lock read unheld once, and a second, later probe has not confirmed it yet.
export const HOLDER_RECHECK_PENDING = 'holder_recheck_pending';

/** True for the host answer that means "no probe answer yet" (never "unanswered"). */
export const isHostProbePending = (host) => host?.hosted === null && host.reason === HOLDER_PROBE_PENDING;


let shared = null;
const sharedHolders = () => (shared ??= cachedHolderObserver());

/**
 * Whether a live process hosts this Codex thread.
 *   hosted true   the lock file exists and `holder_pids` hold it open
 *   hosted false  no lock file, or one nobody holds (stale)
 *   hosted null   unknown: unsafe session id, or the holder probe could not answer
 *                 (reason `holder_probe_unavailable`), or has not answered yet
 *                 (reason `holder_probe_pending`: a probe is running; not a failure)
 * `observeFileHolders` is a synchronous parameter so tests drive every answer.
 * `confirm` is takeover's final check: an unheld lock counts as `hosted: false`
 * only when the holder cache confirmed it with two distinct probes; until then
 * the answer is `hosted: null`, reason `holder_recheck_pending`.
 */
export function observeCodexThreadHost({ sessionId, env = process.env, home = os.homedir(), observeFileHolders = sharedHolders(), confirm = false } = {}) {
  const lockPath = threadWriterLockPath(resolveCodexHome(env, home), sessionId);
  if (lockPath === null) return { hosted: null, reason: 'unsafe_session_id', lock_path: null };
  if (!fs.existsSync(lockPath)) return { hosted: false, reason: 'no_lock_file', lock_path: lockPath };
  let observed;
  try {
    observed = observeFileHolders(lockPath, { confirm });
  } catch (error) {
    return { hosted: null, reason: 'holder_probe_unavailable', lock_path: lockPath, error: error.message };
  }
  if (observed?.pending) return { hosted: null, reason: HOLDER_PROBE_PENDING, lock_path: lockPath };
  if (!observed || observed.unavailable || !Array.isArray(observed.pids)) return { hosted: null, reason: 'holder_probe_unavailable', lock_path: lockPath };
  if (observed.pids.length === 0) {
    if (confirm && observed.confirmed !== true) return { hosted: null, reason: HOLDER_RECHECK_PENDING, lock_path: lockPath };
    return { hosted: false, reason: 'lock_unheld', lock_path: lockPath };
  }
  return { hosted: true, reason: 'lock_held_by_live_process', lock_path: lockPath, holder_pids: observed.pids };
}

const observersByContext = new WeakMap();
const wakersByContext = new WeakMap();

/** Run `wake` whenever a holder probe of this context lands (the listener pass, the resumer tick); returns its remover. */
export function onHostProbeLanded(context, wake) {
  if (!wakersByContext.has(context)) wakersByContext.set(context, new Set());
  wakersByContext.get(context).add(wake);
  return () => wakersByContext.get(context).delete(wake);
}

/** Run this context's holder readers now (the observer calls this once per coalesced landing burst). */
export function wakeHostProbeReaders(context) {
  for (const wake of [...(wakersByContext.get(context) ?? [])]) wake();
}

/** The daemon's default host observer: this context's environment decides which Codex home is asked. */
export function threadHostObserverFor(context) {
  // One cache per daemon context: this is called every tick as a default argument.
  if (context && !observersByContext.has(context)) observersByContext.set(context, cachedHolderObserver({ wakeReaders: () => wakeHostProbeReaders(context) }));
  const observeFileHolders = context ? observersByContext.get(context) : sharedHolders();
  return ({ sessionId, confirm = false }) => observeCodexThreadHost({ sessionId, env: context?.env ?? process.env, observeFileHolders, confirm });
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
