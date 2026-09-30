// Canonical state root resolution, layout, and the exclusive daemon lock.
// the architecture contract §3, the state ownership contract "State root layout".

import fs from 'node:fs';
import path from 'node:path';

import { assertStateRootCreatable, resolveStateRoot as resolveConfiguredStateRoot } from '../protocol/state_root_location.mjs';

// TIGHTBEAM_STATE_ROOT, else ~/.tldr-agents/tightbeam (Phase E). The daemon's
// --state-root flag is applied by its caller (bin/tightbeam-daemon).
export function resolveStateRoot() {
  return resolveConfiguredStateRoot();
}

export function statePaths(root) {
  return {
    root,
    db: path.join(root, 'tightbeam.db'),
    socket: path.join(root, 'tightbeam.sock'),
    lock: path.join(root, 'daemon.lock'),
    adminDir: path.join(root, 'admin'),
    adminNonce: path.join(root, 'admin', 'bootstrap.nonce'),
    runtimesDir: path.join(root, 'runtimes'),
    log: path.join(root, 'daemon.log'),
  };
}

/**
 * Creates <root>/, <root>/admin/, and <root>/runtimes/ at mode 0700
 * (owner-only), idempotently. Refuses (STATE_ROOT_MIGRATION_PENDING) to
 * create the default root while the legacy ~/.tightbeam is still a real
 * directory, so a daemon can never start a fresh database and identity
 * beside the live ones. A root that is a symlink to a directory is used as
 * is: mkdir -p and chmod both follow it.
 */
export function ensureStateRoot(root) {
  assertStateRootCreatable(root, { site: 'daemon.ensure_state_root' });
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  const { adminDir, runtimesDir } = statePaths(root);
  fs.mkdirSync(adminDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(adminDir, 0o700);
  fs.mkdirSync(runtimesDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(runtimesDir, 0o700);
  return statePaths(root);
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by another user: treat
    // as alive (fail closed) rather than assume it is safe to reclaim.
    return err.code === 'EPERM';
  }
}

function readLockFile(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeLockFile(fd) {
  const contents = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() });
  fs.writeSync(fd, contents);
}

function createLockFile(lockPath) {
  const fd = fs.openSync(lockPath, 'wx', 0o600);
  writeLockFile(fd);
  fs.closeSync(fd);
}

/**
 * F7: `fs.rmSync` + `fs.openSync(path, 'wx')` (the stale-lock reclaim
 * path, below) is two separate syscalls, not one atomic operation — a
 * second daemon racing the same reclaim window could recreate the lock
 * file between our `rm` and our `open`. Read the lock file back
 * immediately after creating it and verify it records THIS process's pid;
 * abort (fail closed) if it does not, rather than proceed believing we
 * hold a lock we may not actually hold alone.
 */
function verifyOwnLock(lockPath) {
  const recorded = readLockFile(lockPath);
  if (!recorded || recorded.pid !== process.pid) {
    const error = new Error(
      `lock file at "${lockPath}" no longer records this process after reclaim; another daemon may have won the race — refusing to proceed`,
    );
    error.code = 'DAEMON_LOCK_HELD';
    error.pid = recorded && recorded.pid;
    throw error;
  }
}

/**
 * Acquires the exclusive per-state-root daemon lock (the architecture contract
 * §3). A live pid already holding the lock fails closed; a dead pid's
 * stale lock is reclaimable. Returns { lockPath, release() }.
 */
export function acquireDaemonLock(root) {
  const { lock: lockPath } = statePaths(root);

  try {
    createLockFile(lockPath);
    return { lockPath, release: () => releaseLock(lockPath) };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  const existing = readLockFile(lockPath);
  if (existing && isPidAlive(existing.pid)) {
    const error = new Error(
      `another tightbeam-daemon is already running for state root "${root}" (pid ${existing.pid})`,
    );
    error.code = 'DAEMON_LOCK_HELD';
    error.pid = existing.pid;
    throw error;
  }

  // Stale lock from a dead pid: reclaim it.
  fs.rmSync(lockPath, { force: true });
  createLockFile(lockPath);
  verifyOwnLock(lockPath);
  return { lockPath, release: () => releaseLock(lockPath) };
}

function releaseLock(lockPath) {
  fs.rmSync(lockPath, { force: true });
}
