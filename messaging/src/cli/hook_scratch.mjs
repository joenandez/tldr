import fs from "node:fs";
import path from "node:path";

// The session scratch lock (non-blocking mkdir lock) and PostToolUse's
// pid-named claim of the staged batch, shared by every hook that touches
// pending-inject.jsonl or the shown ledger.

const SCRATCH_LOCK_STALE_MS = 30_000;

function scratchLockPath(paths) {
  return path.join(paths.dir, ".pending-inject.lock");
}

function tryMkdirLock(lock) {
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

// True once this process holds the lock; false while a fresh holder has it.
function acquireScratchLock(lock) {
  if (tryMkdirLock(lock)) return true;
  try {
    const stale =
      Date.now() - fs.statSync(lock).mtimeMs > SCRATCH_LOCK_STALE_MS;
    if (stale) fs.rmdirSync(lock);
    return stale && tryMkdirLock(lock);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export function withScratchLock(paths, work) {
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const lock = scratchLockPath(paths);
  if (!acquireScratchLock(lock)) return null;
  try {
    return work();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

function claimFileName() {
  return `.pending-inject.claim-${process.pid}`;
}

function claimNames(paths) {
  try {
    return fs
      .readdirSync(paths.dir)
      .filter((name) => name.startsWith(".pending-inject.claim-"))
      .sort();
  } catch {
    return [];
  }
}

function activeClaim(paths) {
  return claimNames(paths)[0] ?? null;
}

/** Every claimed batch still on disk: entries PostToolUse is rendering or will recover. */
export function claimedBatchFiles(paths) {
  return claimNames(paths).map((name) => path.join(paths.dir, name));
}

function isLiveClaim(name) {
  const pid = Number(name.slice(".pending-inject.claim-".length));
  if (!Number.isSafeInteger(pid) || pid < 1 || pid === process.pid)
    return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Claim only the bytes PostToolUse will render.  New PreToolUse writes go to
// a fresh pending file, so this Post cleanup cannot erase them.
export function claimStagedBatch(paths) {
  return withScratchLock(paths, () => {
    const prior = activeClaim(paths);
    if (prior) return isLiveClaim(prior) ? null : path.join(paths.dir, prior);
    try {
      const claim = path.join(paths.dir, claimFileName());
      fs.renameSync(paths.pending, claim);
      return claim;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  });
}
