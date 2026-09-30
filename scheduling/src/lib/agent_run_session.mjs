import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { helmHome } from "./store.mjs";
import { sessionDir } from "./identity_state.mjs";

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

// A resume job exists to relaunch one dead session. It is bookkeeping for a
// single process launch, so it is never the job that commissioned a session
// and never a valid thread owner. resume_session.mjs mints these ids.
export const RESUME_JOB_PREFIX = "helm-resume-";

export function isResumeJobId(jobId) {
  return String(jobId || "").startsWith(RESUME_JOB_PREFIX);
}

function originRecordPath(sessionId) {
  try {
    return join(sessionDir(sessionId), "origin.json");
  } catch {
    return null;
  }
}

// The session-first half of assignment authority: which assignment run
// commissioned this session. Written once, at spawn, by the run that created
// the session. A wake-up is a new process, not a new origin, so it never
// rewrites this file.
export function readSessionOrigin(sessionId) {
  const path = originRecordPath(sessionId);
  if (!path) return null;
  const row = safeReadJson(path);
  if (!row?.origin_job_id || !row?.origin_run_id) return null;
  return row;
}

function recordSessionOrigin({ jobId, runId, sessionId, cwd }) {
  if (isResumeJobId(jobId)) return;
  const path = originRecordPath(sessionId);
  if (!path || existsSync(path)) return;
  atomicWriteJson(path, {
    version: "1.0",
    session_id: String(sessionId),
    origin_job_id: String(jobId),
    origin_run_id: String(runId),
    cwd: cwd || null,
    recorded_at: new Date().toISOString(),
  });
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
  recordSessionOrigin({
    jobId: row.job_id,
    runId: row.run_id,
    sessionId: row.session_id,
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
  return { ok: true, path, row, session_id: row.session_id };
}

// TASK-C2AD2E9E — the reverse of readAgentRunSession.
//
// The registry is keyed (job, run) -> session, which answers "who is running
// this job?" but not "which job commissioned this session?". The resume path
// only ever has the session id, so without this direction the originating job
// identity is unrecoverable and the resumed agent's completion report is
// filed against a job the assignment does not own.
//
// Two tiers. The origin record written at spawn answers this outright. For
// sessions that predate that record, fall back to a scan of the ledger and
// take the OLDEST commissioning row: a session id legitimately appears under
// several runs because every wake-up re-records it, so the newest row is the
// most recent wake, not the origin. Resume rows are skipped at both tiers.
export function resolveOriginForSession(sessionId) {
  const wanted = String(sessionId || "");
  if (!wanted) return { ok: false, error: "missing_session_id" };
  const recorded = readSessionOrigin(wanted);
  if (recorded) {
    return {
      ok: true,
      job_id: recorded.origin_job_id,
      run_id: recorded.origin_run_id,
      cwd: recorded.cwd || null,
    };
  }
  const root = join(helmHome(), "agent-runs");
  let jobDirs;
  try {
    jobDirs = readdirSync(root, { withFileTypes: true });
  } catch {
    return { ok: false, error: "agent_runs_unreadable" };
  }
  let best = null;
  for (const jobDir of jobDirs) {
    if (!jobDir.isDirectory()) continue;
    let files;
    try {
      files = readdirSync(join(root, jobDir.name));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const row = safeReadJson(join(root, jobDir.name, file));
      if (!row || row.session_id !== wanted) continue;
      if (!row.job_id || !row.run_id) continue;
      if (isResumeJobId(row.job_id)) continue;
      if (!best || String(row.updated_at) < String(best.updated_at)) best = row;
    }
  }
  if (!best) return { ok: false, error: "origin_not_found" };
  return {
    ok: true,
    job_id: best.job_id,
    run_id: best.run_id,
    cwd: best.cwd || null,
  };
}

export function resolveAgentRunSessionFromEnv(env = process.env) {
  const jobId = env.HELM_JOB_ID || null;
  const runId = env.HELM_RUN_ID || null;
  if (!jobId || !runId) return { ok: false, error: "agent_run_env_missing" };
  return readAgentRunSession({ jobId, runId });
}
