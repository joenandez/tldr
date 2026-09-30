// Where Tightbeam's state root lives, and the refusals that keep a fresh
// root from splitting state away from the one Joe already has (Phase E,
// docs/plans/phase-e-state-root-migration.md §4).
//
// The default is `~/.tldr-agents/tightbeam`, one subdirectory of the single
// tldr-agents root. `TIGHTBEAM_STATE_ROOT` and `--state-root` still win.
// Until item 36, `~/.tightbeam` may be a compatibility symlink into the new
// root; everything here tolerates that (the socket is `<root>/tightbeam.sock`
// and `connect()` follows symlinks).
//
// A protocol-layer module so the daemon, the CLI, and clients all resolve the
// same path: node builtins only.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const STATE_ROOT_MIGRATION_PENDING = 'STATE_ROOT_MIGRATION_PENDING';
export const STATE_ROOT_TEST_ISOLATION = 'STATE_ROOT_TEST_ISOLATION';

const UMBRELLA_DIR = '.tldr-agents';
const COMPONENT_DIR = 'tightbeam';
const LEGACY_DIR = '.tightbeam';

export function defaultStateRoot(home = os.homedir()) {
  return path.join(home, UMBRELLA_DIR, COMPONENT_DIR);
}

export function legacyStateRoot(home = os.homedir()) {
  return path.join(home, LEGACY_DIR);
}

/** `explicit` (a `--state-root` flag), else TIGHTBEAM_STATE_ROOT, else the default. */
export function resolveStateRoot({ explicit, env = process.env, home } = {}) {
  return explicit || env.TIGHTBEAM_STATE_ROOT || defaultStateRoot(home);
}

function lstatOrNull(file) {
  try {
    return fs.lstatSync(file);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

/**
 * The facts of a pending migration, or null. Pending means: `root` is this
 * home's default root, nothing exists there yet (not even a link), and the
 * legacy root is still a real directory (not the compatibility symlink).
 * Creating the root in that state would start a new database and a new
 * identity beside the live one.
 */
export function pendingStateRootMigration(root, { home = os.homedir() } = {}) {
  const target = defaultStateRoot(home);
  if (path.resolve(root) !== target) return null;
  if (lstatOrNull(target) !== null) return null;
  const legacy = legacyStateRoot(home);
  const legacyStat = lstatOrNull(legacy);
  if (legacyStat === null || legacyStat.isSymbolicLink() || !legacyStat.isDirectory()) return null;
  return { root: target, legacy };
}

function isWithin(candidate, dir) {
  return candidate === dir || candidate.startsWith(`${dir}${path.sep}`);
}

/**
 * Under `node --test` (NODE_TEST_CONTEXT), a root inside the real user's
 * `~/.tldr-agents` or `~/.tightbeam` is live state, whatever HOME says: the
 * account's home comes from the password database, not the environment.
 * Returns the offending facts, or null.
 */
export function testIsolationBreach(root, { env = process.env } = {}) {
  if (!env.NODE_TEST_CONTEXT) return null;
  let realHome;
  try {
    realHome = os.userInfo().homedir;
  } catch {
    return null;
  }
  if (!realHome) return null;
  const resolved = path.resolve(root);
  const live = [path.join(realHome, UMBRELLA_DIR), legacyStateRoot(realHome)].find((dir) => isWithin(resolved, dir));
  return live === undefined ? null : { root: resolved, live };
}

function stderrLog(fields) {
  process.stderr.write(`${JSON.stringify({ component: 'tightbeam-state-root', level: 'error', ts: new Date().toISOString(), ...fields })}\n`);
}

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

/**
 * Called by every path that may create a state root (the daemon's
 * ensureStateRoot, the bootstrap lock, and ensureDaemon before it spawns).
 * Read-only paths never call it, because they never create a root.
 * Throws a coded error and logs one structured line when creation must not
 * happen; returns nothing otherwise.
 */
export function assertStateRootCreatable(root, { home = os.homedir(), env = process.env, site = 'unknown', log = stderrLog } = {}) {
  const breach = testIsolationBreach(root, { env });
  if (breach !== null) {
    log({ event: 'state_root_refused', status: 'refused', params: { site, root: breach.root }, result: { code: STATE_ROOT_TEST_ISOLATION, live: breach.live } });
    throw codedError(
      STATE_ROOT_TEST_ISOLATION,
      `refusing to use ${breach.root} under node --test: it is inside the live ${breach.live}. ` +
        'Set TIGHTBEAM_STATE_ROOT (or HOME) to a temporary directory in this test',
      breach,
    );
  }
  const pending = pendingStateRootMigration(root, { home });
  if (pending !== null) {
    log({ event: 'state_root_refused', status: 'refused', params: { site, root: pending.root }, result: { code: STATE_ROOT_MIGRATION_PENDING, legacy: pending.legacy } });
    throw codedError(
      STATE_ROOT_MIGRATION_PENDING,
      `the Tightbeam state root ${pending.root} does not exist, but the legacy root ${pending.legacy} is still a real directory. ` +
        'Refusing to create a fresh state root, which would start a new database and a new identity. ' +
        `Move the legacy root first (npm run local:migrate-state-root), or set TIGHTBEAM_STATE_ROOT=${pending.legacy} to keep using it`,
      pending,
    );
  }
}
