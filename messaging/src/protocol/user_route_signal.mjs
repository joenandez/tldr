// The user-route delivery signal (user priority lane, ac-jfv.74.1).
//
// Whenever the daemon inserts a delivery on a channel route (a user-facing one; agent-to-agent
// deliveries have no route), it rewrites `<state_root>/signals/user-route-delivery`: an ISO
// timestamp and a newline. The agent daemon's tier 0 and tier 1 consumers poll that file's mtime instead of
// asking the daemon, so an idle lane costs one stat. A protocol-layer module so both sides import
// the one path: node builtins only.
//
// Like refreshSessionWatermark (daemon/ops/message_shared.mjs) the write is a best-effort hint
// outside the durability contract: the delivery row is authoritative, and a failed write logs a
// warning and never fails or rolls back the commit.

import fs from "node:fs";
import path from "node:path";

export const USER_ROUTE_SIGNAL_RELATIVE_PATH = path.join(
  "signals",
  "user-route-delivery",
);

export function userRouteSignalPath(stateRoot) {
  return path.join(stateRoot, USER_ROUTE_SIGNAL_RELATIVE_PATH);
}

// shortcut: a per-database registry, so the five delivery-insert call sites (and any future one)
// need no state-root plumbing; upgrade to an explicit parameter if a second state root ever shares one db handle.
const signalTargets = new WeakMap();

/** Called once per daemon (and per test world) with the db handle its inserts go through. */
export function registerUserRouteSignal(db, { stateRoot, logger }) {
  signalTargets.set(db, { stateRoot, logger });
}

/** Marks that a user-route delivery was just inserted through `db`. A no-op when none is registered. */
export function signalUserRouteDelivery(db) {
  const target = signalTargets.get(db);
  if (!target?.stateRoot) return;
  const file = userRouteSignalPath(target.stateRoot);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${new Date().toISOString()}\n`, { mode: 0o600 });
  } catch (err) {
    target.logger?.warn({
      event: "user_route_signal_write_failed",
      path: file,
      error: err.message,
    });
  }
}
