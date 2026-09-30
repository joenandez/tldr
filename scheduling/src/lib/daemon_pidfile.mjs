import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { helmHome } from "./store.mjs";

// Daemon pidfile helpers, extracted from daemon.mjs so the singleton ownership
// logic lives in one small, well-tested place. The pidfile records the pid of
// the live launchd-managed scheduler so a second instance can detect it and
// refuse to start, and so the resident daemon can detect when it has been
// superseded and yield (single-winner election).

// Consecutive watchdog samples that must agree the pidfile is owned by a
// different, live pid before the resident daemon concedes ownership. A single
// transient read (e.g. an fs hiccup or an in-flight write observed across a
// sleep/wake transition) must NOT kill a healthy daemon — that is the flap that
// caused the pidfile_ownership_lost restart loop. At ~1s/tick this is ~3s of
// confirmed foreign ownership before yielding.
export const OWNERSHIP_LOST_CONFIRM_TICKS = 3;

export function daemonPidPath(home = helmHome()) {
  return join(home, "service", "daemon.pid");
}

export function readDaemonPidFile() {
  return readDaemonPidFileForHome(helmHome());
}

export function readDaemonPidFileForHome(home) {
  try {
    const raw = readFileSync(daemonPidPath(home), "utf8").trim();
    const pid = Number(raw);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

// Atomically publish `pid` into the pidfile via temp-write + rename. The rename
// is atomic on the same filesystem, so a concurrent reader always sees either
// the old or the new pid — never an empty or partial file. A plain in-place
// writeFileSync could be observed mid-write as an empty string, parse to null,
// and trip a false pidfile_ownership_lost self-exit.
export function writePidFileAtomic(home, pid) {
  const path = daemonPidPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, String(pid), "utf8");
  renameSync(tmp, path);
  return path;
}

// Pure decision for the self-exit watchdog. Returns the next mismatch streak
// and whether ownership loss is *confirmed*. Only an unbroken run of
// `threshold` non-owning samples confirms loss, so a single transient/torn read
// can't kill a healthy daemon. Two non-owning cases both accrue the streak:
//   - foreign_owner: the pidfile holds a different live pid (real handoff)
//   - owner_missing: the pidfile is gone/unreadable (e.g. HELM_HOME wiped under
//     the daemon — the COE-2026-05-05 orphan case that must still self-exit)
// Only seeing our own pid resets the streak.
export function evaluateOwnershipLost({
  boundPid,
  selfPid,
  streak = 0,
  threshold = OWNERSHIP_LOST_CONFIRM_TICKS,
}) {
  if (boundPid === selfPid) {
    return { lost: false, streak: 0, reason: "owned" };
  }
  const nextStreak = streak + 1;
  const base =
    boundPid === null || boundPid === undefined
      ? "owner_missing"
      : "foreign_owner";
  const lost = nextStreak >= threshold;
  return {
    lost,
    streak: nextStreak,
    reason: `${base}_${lost ? "confirmed" : "pending"}`,
  };
}
