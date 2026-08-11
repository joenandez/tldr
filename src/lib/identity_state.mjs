// PRFAQ-0-1 Phase 1 — per-session identity + state primitives.
//
// This module exposes atomic readers/writers for identity.json and
// state.json. inbox.jsonl is owned by the dispatcher (src/lib/comms_dispatcher.mjs).
//
// Atomic writes prevent torn identity/state files. Readers tolerate corrupt JSON by returning
// null (the dispatcher falls back to "no state" and waits one tick).

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

export function helmSessionsRoot() {
  return (
    process.env.TLDR_AGENT_SESSIONS_ROOT ||
    join(
      process.env.TLDR_AGENT_HOME || join(homedir(), ".tldr-agent"),
      "sessions",
    )
  );
}

export function sessionDir(sessionId) {
  if (!sessionId || typeof sessionId !== "string") {
    throw new Error("sessionId required");
  }
  return join(helmSessionsRoot(), sessionId);
}

function atomicWriteJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmp, filePath);
}
function safeReadJson(filePath) {
  try {
    const raw = readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
export function writeIdentity({
  sessionId,
  runtime,
  pid,
  controllingTty,
  launchMode = "unknown",
  launchSource = "unknown",
  runtimeVersion = null,
  installPath = null,
  cwd = null,
}) {
  if (!sessionId) throw new Error("sessionId required");
  if (!runtime) throw new Error("runtime required");
  const row = {
    session_id: sessionId,
    runtime,
    runtime_version: runtimeVersion,
    install_path: installPath,
    cwd: cwd || installPath || null,
    pid: pid !== null && pid !== undefined ? Number(pid) : null,
    controlling_tty: controllingTty || null,
    launch_mode: launchMode || "unknown",
    launch_source: launchSource || "unknown",
    session_started_at: new Date().toISOString(),
  };
  atomicWriteJson(join(sessionDir(sessionId), "identity.json"), row);
  return row;
}

export function readIdentity(sessionId) {
  if (!sessionId) return null;
  return safeReadJson(join(sessionDir(sessionId), "identity.json"));
}

export function writeState(sessionId, { state, lastPid = null }) {
  if (!sessionId) throw new Error("sessionId required");
  if (state !== "busy" && state !== "idle") {
    throw new Error(`state must be "busy" or "idle" (got ${state})`);
  }
  const row = {
    state,
    since: Date.now(),
    last_pid:
      lastPid !== null && lastPid !== undefined ? Number(lastPid) : null,
  };
  atomicWriteJson(join(sessionDir(sessionId), "state.json"), row);
  return row;
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
// against hook-written session artifacts. This is intentionally fail-closed:
// if two sessions match the same ancestry, callers must not attach outbound
// email to either one.
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

function sessionPidClaims(sessionId) {
  const identity = readIdentity(sessionId);
  const state = readState(sessionId);
  const claims = [];
  const identityPid = Number(identity?.pid);
  if (Number.isFinite(identityPid) && identityPid > 1) {
    claims.push({
      session_id: sessionId,
      identity,
      state,
      pid: identityPid,
      source_field: "identity.pid",
    });
  }
  const statePid = Number(state?.last_pid);
  if (Number.isFinite(statePid) && statePid > 1) {
    claims.push({
      session_id: sessionId,
      identity,
      state,
      pid: statePid,
      source_field: "state.last_pid",
    });
  }
  return claims;
}

const OUTBOUND_OWNER_ENV_FIELDS = [
  "CODEX_THREAD_ID",
  "CLAUDE_CODE_SESSION_ID",
  "HELM_AGENT_SESSION_ID",
];

function normalizeOutboundOwnerEnv(env = {}) {
  const candidates = [];
  for (const field of OUTBOUND_OWNER_ENV_FIELDS) {
    const raw = env?.[field];
    if (raw === null || raw === undefined) continue;
    const sessionId = String(raw).trim();
    if (!sessionId) continue;
    candidates.push({
      session_id: sessionId,
      env_field: field,
      source_field: `env.${field}`,
    });
  }
  const uniqueIds = [
    ...new Set(candidates.map((candidate) => candidate.session_id)),
  ];
  if (uniqueIds.length > 1) {
    return {
      ok: false,
      error: "conflicting_agent_session_env",
      env_candidates: candidates,
    };
  }
  if (uniqueIds.length === 0) {
    return { ok: true, session_id: null, env_candidates: [] };
  }
  return {
    ok: true,
    session_id: uniqueIds[0],
    source_field: candidates[0].source_field,
    env_candidates: candidates,
  };
}
function resolveSessionFromRuntimeEnv({ env, ancestry }) {
  const normalized = normalizeOutboundOwnerEnv(env);
  if (!normalized.ok) {
    const ancestryDepth = new Map(ancestry.map((pid, depth) => [pid, depth]));
    const registered = normalized.env_candidates.map((candidate) => {
      const identity = readIdentity(candidate.session_id);
      const state = readState(candidate.session_id);
      return {
        ...candidate,
        identity,
        state,
        claims: sessionPidClaims(candidate.session_id),
      };
    });
    const allRegistered = registered.every(
      (candidate) => candidate.identity || candidate.state,
    );
    const matched = registered.flatMap((candidate) =>
      candidate.claims.flatMap((claim) => {
        const depth = ancestryDepth.get(claim.pid);
        return depth === undefined ? [] : [{ ...candidate, claim, depth }];
      }),
    );
    const nearestDepth = Math.min(
      ...matched.map((candidate) => candidate.depth),
    );
    const nearest = matched.filter(
      (candidate) => candidate.depth === nearestDepth,
    );
    const nearestSessions = new Set(
      nearest.map((candidate) => candidate.session_id),
    );
    if (allRegistered && nearestSessions.size === 1) {
      const selected = nearest[0];
      return {
        ok: true,
        session_id: selected.session_id,
        selected_pid: selected.claim.pid,
        ancestry,
        ancestry_depth: selected.depth,
        source_field: selected.source_field,
        selected_claim_source_field: selected.claim.source_field,
        identity: selected.identity,
        state: selected.state,
        env_candidates: normalized.env_candidates,
        candidates: registered.flatMap((candidate) =>
          candidate.claims.map((claim) => ({
            session_id: claim.session_id,
            pid: claim.pid,
            source_field: claim.source_field,
          })),
        ),
      };
    }
    return {
      ok: false,
      error: normalized.error,
      ancestry,
      env_candidates: normalized.env_candidates,
      candidates: [],
    };
  }
  if (!normalized.session_id) return null;
  const sessionId = normalized.session_id;
  const identity = readIdentity(sessionId);
  const state = readState(sessionId);
  if (!identity && !state) {
    return {
      ok: false,
      error: "agent_session_env_unregistered",
      session_id: sessionId,
      source_field: normalized.source_field,
      ancestry,
      env_candidates: normalized.env_candidates,
      candidates: [],
    };
  }

  const claims = sessionPidClaims(sessionId);
  const ancestrySet = new Set(ancestry);
  const matchedClaims = claims.filter((claim) => ancestrySet.has(claim.pid));
  if (matchedClaims.length === 0) {
    const selected = claims[0] || null;
    return {
      ok: true,
      session_id: sessionId,
      selected_pid: selected?.pid || null,
      ancestry,
      ancestry_depth: null,
      source_field: normalized.source_field,
      identity,
      state,
      env_candidates: normalized.env_candidates,
      candidates: claims.map((claim) => ({
        session_id: claim.session_id,
        pid: claim.pid,
        source_field: claim.source_field,
      })),
    };
  }

  let selected = null;
  let ancestryDepth = null;
  for (let depth = 0; depth < ancestry.length; depth += 1) {
    const pid = ancestry[depth];
    selected = matchedClaims.find((claim) => claim.pid === pid) || null;
    if (selected) {
      ancestryDepth = depth;
      break;
    }
  }

  return {
    ok: true,
    session_id: sessionId,
    selected_pid: selected?.pid || matchedClaims[0].pid,
    ancestry,
    ancestry_depth: ancestryDepth,
    source_field: normalized.source_field,
    selected_claim_source_field:
      selected?.source_field || matchedClaims[0].source_field,
    identity,
    state,
    env_candidates: normalized.env_candidates,
    candidates: claims.map((claim) => ({
      session_id: claim.session_id,
      pid: claim.pid,
      source_field: claim.source_field,
    })),
  };
}

// Strict resolver for outbound email ownership. Runtime session env is canonical
// when registered; without env, fall back to the nearest exact PID claim.
export function resolveOutboundEmailSessionOwner({
  pid = process.pid,
  env = process.env,
  getParentPid = defaultGetParentPid,
  maxDepth = 32,
} = {}) {
  const ancestry = collectPidAncestry({ pid, getParentPid, maxDepth });
  const envResolved = resolveSessionFromRuntimeEnv({ env, ancestry });
  if (envResolved) return envResolved;

  const claims = [];
  for (const sessionId of listSessions()) {
    claims.push(...sessionPidClaims(sessionId));
  }
  const candidates = claims.map((claim) => ({
    session_id: claim.session_id,
    pid: claim.pid,
    source_field: claim.source_field,
  }));
  for (let depth = 0; depth < ancestry.length; depth += 1) {
    const selectedPid = ancestry[depth];
    if (selectedPid === 1) continue;
    const matches = claims.filter((claim) => claim.pid === selectedPid);
    const uniqueSessions = new Set(matches.map((match) => match.session_id));
    if (uniqueSessions.size === 0) continue;
    if (uniqueSessions.size > 1) {
      return {
        ok: false,
        error: "ambiguous_agent_session_owner",
        selected_pid: selectedPid,
        ancestry,
        ancestry_depth: depth,
        candidates: matches.map((match) => ({
          session_id: match.session_id,
          pid: match.pid,
          source_field: match.source_field,
        })),
      };
    }
    const match = matches[0];
    return {
      ok: true,
      session_id: match.session_id,
      selected_pid: selectedPid,
      ancestry,
      ancestry_depth: depth,
      source_field: match.source_field,
      identity: match.identity,
      state: match.state,
      candidates,
    };
  }
  return {
    ok: false,
    error: "missing_agent_session_owner",
    ancestry,
    candidates,
  };
}
