import { execFileSync } from "node:child_process";

import { observeProcessRow } from "./hook_process_tree.mjs";

// A send fails if this times out, and this machine's load can spike past 200 ms.
const PROCESS_OBSERVATION_TIMEOUT_MS = 2000;
const PROCESS_RECHECK_INTERVAL_MS = 250;
const PROCESS_IDENTITY_PREFIX = "ps-lstart-utc-v1:";
const CANONICAL_LSTART =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:[1-9]|[12]\d|3[01]) (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d \d{4}$/;

function isCanonicalIdentity(identity) {
  return (
    typeof identity === "string" &&
    identity.startsWith(PROCESS_IDENTITY_PREFIX) &&
    CANONICAL_LSTART.test(identity.slice(PROCESS_IDENTITY_PREFIX.length))
  );
}

function observeProcess(pid) {
  const row = observeProcessRow(pid, (command, args, options) =>
    execFileSync(command, args, {
      ...options,
      env: {
        ...options.env,
        TZ: "UTC0",
        LC_ALL: "C",
        LANG: "C",
      },
      timeout: PROCESS_OBSERVATION_TIMEOUT_MS,
    }),
  );
  return row
    ? {
        ...row,
        startIdentity: `${PROCESS_IDENTITY_PREFIX}${row.startIdentity}`,
      }
    : row;
}

export function observeCurrentProcessIdentity() {
  try {
    return observeProcess(process.pid)?.startIdentity ?? null;
  } catch {
    return null;
  }
}

export function ownerProcessAlive(owner) {
  let alive = owner !== 0;
  try {
    if (Number.isSafeInteger(owner) && owner > 0) process.kill(owner, 0);
  } catch (error) {
    alive = error?.code !== "ESRCH";
  }
  return alive;
}

export function observeOwnerInstance(owner, previous) {
  if (!isCanonicalIdentity(owner.startIdentity)) {
    return { checked: previous, differentInstance: false };
  }
  const checkedRecently =
    previous?.token === owner.token &&
    previous.startIdentity === owner.startIdentity &&
    Date.now() - previous.at < PROCESS_RECHECK_INTERVAL_MS;
  let current = null;
  if (!checkedRecently) {
    try {
      current = observeProcess(owner.owner);
    } catch {
      current = null;
    }
  }
  const checked = checkedRecently
    ? previous
    : {
        token: owner.token,
        startIdentity: owner.startIdentity,
        at: Date.now(),
      };
  return {
    checked,
    differentInstance:
      !checkedRecently &&
      isCanonicalIdentity(current?.startIdentity) &&
      current.startIdentity !== owner.startIdentity,
  };
}
