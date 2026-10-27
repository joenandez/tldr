import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  observeCurrentProcessIdentity,
  observeOwnerInstance,
  ownerProcessAlive,
} from "./agent_action_lock_identity.mjs";

function readTokenOwner(lock, token) {
  try {
    const raw = fs.readFileSync(path.join(lock, token), "utf8");
    try {
      const owner = JSON.parse(raw);
      if (owner && typeof owner === "object") {
        return {
          token,
          owner: Number(owner.pid),
          startIdentity:
            typeof owner.startIdentity === "string" && owner.startIdentity
              ? owner.startIdentity
              : null,
        };
      }
    } catch {
      // Older locks contain only the PID.
    }
    return {
      token,
      owner: Number(raw),
      startIdentity: null,
    };
  } catch {
    return { token, owner: null, startIdentity: null };
  }
}

function observeOwnerlessLock(lock) {
  try {
    const legacyOwner = Number(
      fs.readFileSync(path.join(lock, "owner"), "utf8"),
    );
    return { token: "owner", owner: legacyOwner, startIdentity: null };
  } catch (error) {
    try {
      const stat = fs.statSync(lock);
      const recentlyCreated = Date.now() - stat.mtimeMs < 100;
      return { token: null, owner: recentlyCreated ? process.pid : 0 };
    } catch {
      return { token: null, owner: 0, missing: error?.code === "ENOENT" };
    }
  }
}

function lockOwner(lock) {
  let entries;
  try {
    entries = fs.readdirSync(lock);
  } catch {
    return { token: null, owner: 0, missing: true };
  }
  const token = entries.find((entry) => entry.startsWith("owner-"));
  return token ? readTokenOwner(lock, token) : observeOwnerlessLock(lock);
}

function sameLockOwner(lock, observed) {
  const current = lockOwner(lock);
  return (
    current.token === observed.token &&
    current.owner === observed.owner &&
    current.startIdentity === observed.startIdentity
  );
}

function reclaimDeadActionStoreLock(lock, observed) {
  if (!observed.token || !sameLockOwner(lock, observed)) return;
  try {
    fs.unlinkSync(path.join(lock, observed.token));
    fs.rmdirSync(lock);
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error;
  }
}

function newLockReservation(lock) {
  return {
    prepared: `${lock}.prepared.${process.pid}.${randomUUID()}`,
    token: `owner-${process.pid}-${randomUUID()}`,
  };
}

function prepareActionStoreLock({ prepared, token, owner }) {
  fs.mkdirSync(prepared, { mode: 0o700 });
  fs.writeFileSync(path.join(prepared, token), JSON.stringify(owner), {
    mode: 0o600,
    flag: "wx",
  });
}

function reapStaleOwner(lock, owner, previousIdentityCheck) {
  let reclaimed = false;
  let identityCheck = previousIdentityCheck;
  if (!ownerProcessAlive(owner.owner)) {
    reclaimDeadActionStoreLock(lock, owner);
    reclaimed = true;
    identityCheck = null;
  } else if (owner.startIdentity?.startsWith("ps-lstart-utc-v1:")) {
    const observed = observeOwnerInstance(owner, identityCheck);
    identityCheck = observed.checked;
    if (observed.differentInstance) {
      reclaimDeadActionStoreLock(lock, owner);
      reclaimed = true;
      identityCheck = null;
    }
  }
  return { reclaimed, identityCheck };
}

function publishPreparedLock(lock, prepared, token) {
  const deadline = Date.now() + 5000;
  const sleep = new Int32Array(new SharedArrayBuffer(4));
  let identityCheck = null;
  while (Date.now() < deadline) {
    try {
      fs.renameSync(prepared, lock);
      return token;
    } catch (error) {
      if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
    }
    const owner = lockOwner(lock);
    const result = reapStaleOwner(lock, owner, identityCheck);
    identityCheck = result.identityCheck;
    if (result.reclaimed) continue;
    Atomics.wait(sleep, 0, 0, 10);
  }
  throw Object.assign(
    new Error("timed out waiting for the current action identity lock"),
    { code: "action_identity_unavailable" },
  );
}

function removePreparedLock(prepared) {
  try {
    fs.rmSync(prepared, { recursive: true, force: true });
  } catch {
    /* Preserve the preparation or bounded-wait result. */
  }
}

export function acquireActionStoreLock(lock) {
  const startIdentity = observeCurrentProcessIdentity();
  if (!startIdentity) {
    throw Object.assign(
      new Error("could not observe the current process identity"),
      { code: "action_identity_unavailable" },
    );
  }
  const reservation = newLockReservation(lock);
  try {
    prepareActionStoreLock({
      ...reservation,
      owner: { pid: process.pid, startIdentity },
    });
    return publishPreparedLock(lock, reservation.prepared, reservation.token);
  } finally {
    removePreparedLock(reservation.prepared);
  }
}

export function releaseActionStoreLock(lock, token) {
  try {
    fs.unlinkSync(path.join(lock, token));
    fs.rmdirSync(lock);
  } catch {
    /* A later writer removes a dead owner's lock. */
  }
}
