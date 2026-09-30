// Legacy per-session identity and state files: a read-only fallback.
//
// Helm's retired SessionStart/UserPromptSubmit/Stop hooks wrote
//   <helm home>/sessions/<id>/identity.json   boot snapshot (runtime, pid, tty)
//   <helm home>/sessions/<id>/state.json      busy/idle, flipped every turn
// Nothing writes these files any more: session facts come from Tightbeam
// (src/lib/tightbeam_sessions.mjs). The readers below stay for one release
// so sessions that registered only through the old hooks still resolve and
// list; remove them, and this fallback, in the release after the hooks were
// retired. The directory itself stays: agent_run_session.mjs keeps its
// origin.json there.
//
// Readers tolerate a missing or corrupt file by returning null.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { helmHome } from "./store.mjs";
import { spawnSync } from "node:child_process";

export function helmSessionsRoot() {
  return process.env.HELM_SESSIONS_ROOT || join(helmHome(), "sessions");
}

export function sessionDir(sessionId) {
  if (!sessionId || typeof sessionId !== "string") {
    throw new Error("sessionId required");
  }
  return join(helmSessionsRoot(), sessionId);
}

function safeReadJson(filePath) {
  try {
    const raw = readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function readIdentity(sessionId) {
  if (!sessionId) return null;
  return safeReadJson(join(sessionDir(sessionId), "identity.json"));
}

export function readState(sessionId) {
  if (!sessionId) return null;
  const row = safeReadJson(join(sessionDir(sessionId), "state.json"));
  if (!row || Object.hasOwn(row, "lastPid")) return row;
  if (!Object.hasOwn(row, "last_pid")) return row;
  return { ...row, lastPid: row.last_pid };
}

export function listSessions() {
  const root = helmSessionsRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => {
    if (name.startsWith(".")) return false;
    try {
      return existsSync(join(root, name, "identity.json"));
    } catch {
      return false;
    }
  });
}

function defaultGetParentPid(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) return null;
  const result = spawnSync("ps", ["-o", "ppid=", "-p", String(n)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  const parent = Number(String(result.stdout || "").trim());
  return Number.isFinite(parent) && parent > 0 ? parent : null;
}

function collectPidAncestry({ pid, getParentPid, maxDepth }) {
  const out = [];
  const seen = new Set();
  let current = Number(pid);
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (!Number.isFinite(current) || current <= 0 || seen.has(current)) break;
    out.push(current);
    seen.add(current);
    if (current === 1) break;
    const parent = getParentPid(current);
    if (parent === null || parent === undefined) break;
    current = Number(parent);
  }
  return out;
}

// Resolve a Helm agent session by matching the current process ancestry
// against legacy hook-written session artifacts. This is intentionally
// fail-closed: if two sessions match the same ancestry, callers must not
// attach outbound email to either one.
export function resolveSessionFromPidAncestry({
  pid = process.pid,
  getParentPid = defaultGetParentPid,
  maxDepth = 32,
} = {}) {
  const ancestry = collectPidAncestry({ pid, getParentPid, maxDepth });
  if (ancestry.length === 0) {
    return {
      ok: false,
      error: "session_pid_unresolved",
      candidates: [],
      ancestry: [],
    };
  }
  const ancestrySet = new Set(ancestry);
  const matches = [];
  for (const sessionId of listSessions()) {
    const identity = readIdentity(sessionId);
    const state = readState(sessionId);
    const candidatePids = [identity?.pid, state?.last_pid]
      .map(Number)
      .filter((v) => Number.isFinite(v) && v > 0);
    const matchedPids = [
      ...new Set(candidatePids.filter((v) => ancestrySet.has(v))),
    ];
    if (matchedPids.length === 0) continue;
    matches.push({ sessionId, identity, state, matchedPids });
  }
  if (matches.length === 0) {
    return {
      ok: false,
      error: "session_pid_unresolved",
      candidates: [],
      ancestry,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: "session_pid_ambiguous",
      candidates: matches.map((m) => m.sessionId),
      ancestry,
    };
  }
  const match = matches[0];
  return {
    ok: true,
    session_id: match.sessionId,
    runtime: match.identity?.runtime || null,
    identity: match.identity,
    state: match.state,
    matched_pids: match.matchedPids,
    ancestry,
  };
}
