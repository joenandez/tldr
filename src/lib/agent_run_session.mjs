import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureDurableSessionIdentity } from "./durable_session_identity.mjs";
import { helmHome } from "./store.mjs";
import { readIdentity } from "./identity_state.mjs";

function safeSegment(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .slice(0, 160);
}

function runSessionPath({ jobId, runId } = {}) {
  const job = safeSegment(jobId);
  const run = safeSegment(runId);
  if (!job || !run) return null;
  return join(helmHome(), "agent-runs", job, `${run}.json`);
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmp, path);
}

function safeReadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function writeAgentRunSession({
  jobId,
  runId,
  sessionId,
  agent = null,
  pid = null,
  cwd = null,
} = {}) {
  if (!jobId || !runId || !sessionId)
    return { ok: false, error: "missing_agent_run_session_fields" };
  const path = runSessionPath({ jobId, runId });
  if (!path) return { ok: false, error: "invalid_agent_run_session_key" };
  const existing = safeReadJson(path) || {};
  const row = {
    ...existing,
    job_id: String(jobId),
    run_id: String(runId),
    session_id: String(sessionId),
    agent: agent || existing.agent || null,
    pid: pid !== null && pid !== undefined ? Number(pid) : existing.pid || null,
    cwd: cwd || existing.cwd || null,
    updated_at: new Date().toISOString(),
  };
  atomicWriteJson(path, row);
  ensureDurableSessionIdentity({
    sessionId: row.session_id,
    runtime: row.agent,
    pid: row.pid,
    cwd: row.cwd,
  });
  return { ok: true, path, row };
}

export function readAgentRunSession({ jobId, runId } = {}) {
  const path = runSessionPath({ jobId, runId });
  if (!path) return { ok: false, error: "invalid_agent_run_session_key" };
  const row = safeReadJson(path);
  if (!row?.session_id)
    return { ok: false, error: "agent_run_session_not_found" };
  const identity = readIdentity(row.session_id);
  return { ok: true, path, row, session_id: row.session_id, identity };
}

export function resolveAgentRunSessionFromEnv(env = process.env) {
  const jobId = env.HELM_JOB_ID || null;
  const runId = env.HELM_RUN_ID || null;
  if (!jobId || !runId) return { ok: false, error: "agent_run_env_missing" };
  return readAgentRunSession({ jobId, runId });
}
