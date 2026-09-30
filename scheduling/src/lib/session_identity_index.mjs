import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { helmHome } from "./store.mjs";

const VALID_SOURCES = new Set([
  "adapter_stdout",
  "adapter_minted",
  "session_start_hook",
  "missing",
  "conflict",
]);

function nowIso() {
  return new Date().toISOString();
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} is required`);
  }
  return value.trim();
}

function optionalString(value) {
  if (value === undefined || value === null) return null;
  return String(value);
}

function optionalInteger(value) {
  if (value === undefined || value === null) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function sessionIdentityIndexPath(home = helmHome()) {
  return join(home, "sessions", "identity-index.jsonl");
}

function appendJsonl(path, row) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(row)}\n`, { flag: "a", mode: 0o600 });
}

function readRows(path) {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function normalizeSource(source) {
  const value = requireString(source, "source");
  if (!VALID_SOURCES.has(value)) {
    throw new TypeError(`unsupported session identity source: ${value}`);
  }
  return value;
}

function normalizeIdentityRow({
  runId,
  jobId,
  provider,
  pid = null,
  processGroupId = null,
  sessionId = null,
  threadId = null,
  resumeCommand = null,
  resumeCwd = null,
  confidence = null,
  source,
  status = null,
  evidencePath = null,
  reason = null,
  now = nowIso,
} = {}) {
  const normalizedSource = normalizeSource(source);
  return {
    version: "1.0",
    run_id: requireString(runId, "runId"),
    job_id: requireString(jobId, "jobId"),
    provider: requireString(provider, "provider"),
    pid: optionalInteger(pid),
    process_group_id: optionalInteger(processGroupId),
    session_id: optionalString(sessionId),
    thread_id: optionalString(threadId),
    resume_command: optionalString(resumeCommand),
    resume_cwd: optionalString(resumeCwd),
    confidence: optionalString(confidence),
    source: normalizedSource,
    status:
      status ||
      (normalizedSource === "missing" || normalizedSource === "conflict"
        ? normalizedSource
        : "resolved"),
    evidence_path: optionalString(evidencePath),
    reason: optionalString(reason),
    recorded_at: now(),
  };
}

export function recordSessionIdentity({
  home = helmHome(),
  path = sessionIdentityIndexPath(home),
  ...row
} = {}) {
  const normalized = normalizeIdentityRow(row);
  appendJsonl(path, normalized);
  return { path, row: normalized };
}

export function recordMissingSessionIdentity({
  home = helmHome(),
  path = sessionIdentityIndexPath(home),
  reason = "session_identity_missing",
  ...row
} = {}) {
  return recordSessionIdentity({
    home,
    path,
    ...row,
    source: "missing",
    status: "missing",
    reason,
  });
}

function resolveConflict(rows) {
  const resolved = rows.filter((row) => row.status === "resolved");
  const sessions = new Set(
    resolved.map((row) => row.session_id).filter((value) => value),
  );
  const threads = new Set(
    resolved.map((row) => row.thread_id).filter((value) => value),
  );
  return sessions.size > 1 || threads.size > 1;
}

export function lookupSessionIdentity({
  home = helmHome(),
  path = sessionIdentityIndexPath(home),
  runId,
  provider = null,
} = {}) {
  const normalizedRunId = requireString(runId, "runId");
  const rows = readRows(path).filter(
    (row) =>
      row.run_id === normalizedRunId &&
      (provider === null || row.provider === provider),
  );
  if (rows.length === 0) {
    return {
      ok: false,
      status: "missing",
      reason: "session_identity_missing",
      row: null,
      rows: [],
      path,
    };
  }
  if (resolveConflict(rows)) {
    return {
      ok: false,
      status: "conflict",
      reason: "session_identity_conflict",
      row: null,
      rows,
      path,
    };
  }
  const row = [...rows].reverse().find((entry) => entry.status === "resolved");
  if (!row) {
    return {
      ok: false,
      status: rows.at(-1)?.status || "missing",
      reason: rows.at(-1)?.reason || "session_identity_missing",
      row: rows.at(-1) || null,
      rows,
      path,
    };
  }
  return {
    ok: true,
    status: "resolved",
    reason: "session_identity_resolved",
    row,
    rows,
    path,
  };
}
