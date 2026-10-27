// A disconnect in flight. The app's retire entry writes this marker before it
// retires the email route; until the broker reports `unconfigured`, the
// disconnect is unfinished, so setup and repair must not reassert the route
// and the app reopens on its incomplete screen. Only the file's presence
// matters; it carries no owner, route, or credential data.
//
// The route lock serializes route activation (setup/repair) with the retire
// entry across processes: an activation re-reads the marker under it, so a
// registration either finishes before retirement starts (and is retired) or
// sees the marker and withholds.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { writeTextAtomic } from "./durable_file_io.mjs";
import { isProcessAlive } from "./process_liveness.mjs";

export const EMAIL_DISCONNECT_MARKER = "email-disconnect.pending";
const EMAIL_ROUTE_LOCK = "email-route.lock";
// Under the app's 30 s entry timeout, above a Tightbeam register or retire.
const ROUTE_LOCK_TIMEOUT_MS = 20_000;
const ROUTE_LOCK_POLL_MS = 50;

function readOrNull(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// Only a holder whose recorded process is gone is stale; an unreadable or
// still-being-written lock is waited on, never guessed at.
function holderGone(path) {
  const pid = Number((readOrNull(path) ?? "").split(":")[0]);
  return Number.isInteger(pid) && pid > 0 && !isProcessAlive(pid);
}

const ROUTE_LOCK_BUSY = {
  code: "EMAIL_ROUTE_LOCK_BUSY",
  message: "email route lock is held",
};

// Any cross-process lock file around async work; Slack channels add uses it
// per agent name. busy is the { code, message } thrown on timeout.
export async function withRouteLock(
  path,
  fn,
  { timeoutMs = ROUTE_LOCK_TIMEOUT_MS, busy = ROUTE_LOCK_BUSY } = {},
) {
  const token = `${process.pid}:${randomUUID()}\n`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      writeFileSync(path, token, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (holderGone(path)) {
        rmSync(path, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw Object.assign(new Error(busy.message), { code: busy.code });
      }
      // eslint-disable-next-line no-await-in-loop -- route-lock polling must observe each holder before retrying.
      await sleep(ROUTE_LOCK_POLL_MS);
    }
  }
  try {
    return await fn();
  } finally {
    if (readOrNull(path) === token) rmSync(path, { force: true });
  }
}

export function createEmailDisconnectMarker({ home }) {
  const path = join(home, EMAIL_DISCONNECT_MARKER);
  return Object.freeze({
    isPending: () => existsSync(path),
    mark: () =>
      writeTextAtomic(path, "email disconnect pending\n", {
        durable: true,
        mode: 0o600,
      }),
    clear: () => rmSync(path, { force: true }),
    withRouteLock: (fn, options) =>
      withRouteLock(join(home, EMAIL_ROUTE_LOCK), fn, options),
  });
}
