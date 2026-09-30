// run_session_outcome — the agent session's own terminal boundary, persisted.
//
// A handed-off run returns to the dispatcher as soon as its agent session is
// up, so the dispatch's terminal status only ever proves the launch. The work
// itself ends later, when that session finishes. That end is an observable
// fact, not something the agent has to volunteer: recording it is what lets
// most runs close promptly when the agent never files a completion report. A
// hard-runtime deadline is the fallback when this best-effort record cannot be
// written or read.
//
// Two things record it, because the process that launched the session usually
// does not outlive it — the daemon dispatches each due scope in a short-lived
// forked child, and `helm-assignments run` is a foreground command that returns
// at handoff:
//
//   * sessionBoundaryLaunch() below wraps the launch so the session's own
//     process tree writes the record as it exits. This is the one that holds
//     when the dispatcher is already gone;
//   * a dispatcher that is still alive when the session ends records it too
//     (src/lib/dispatch_service.mjs), which covers launches that never take the
//     wrapped path.
//
// The record carries only what the boundary itself proves — how the session
// ended and when. It carries no message: a run that delivered none must keep
// saying so rather than have one invented from an exit code.
//
// Written once per run id and never rewritten, so whichever writer observes the
// boundary first is the record, and the second cannot move a finish time that
// has already been published.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const RECORD_VERSION = "1.0";

export function runSessionOutcomePath(cwd, runId) {
  return join(cwd, ".helm", "runs", "session-outcomes", `${runId}.json`);
}

/**
 * Persist one run's session terminal boundary. Never throws: a boundary that
 * cannot be written must not take the dispatcher down with it.
 *
 * @param {object} params
 * @param {string} params.cwd        scope working directory
 * @param {string} params.jobId      owning job id (ownership stamp)
 * @param {string} params.runId      run id the record is keyed by
 * @param {string} params.status     "success" | "failure", as the terminal event names it
 * @param {string} params.finishedAt ISO instant the session ended
 * @param {number|null} [params.exitCode]
 * @param {string|null} [params.signal]
 * @param {string|null} [params.error]
 * @returns {{written: boolean}} `false` when a record already existed
 */
export function recordRunSessionOutcome({
  cwd,
  jobId,
  runId,
  status,
  finishedAt,
  exitCode = null,
  signal = null,
  error = null,
}) {
  if (!cwd || !jobId || !runId) return { written: false };
  const path = runSessionOutcomePath(cwd, runId);
  if (existsSync(path)) return { written: false };
  const record = {
    version: RECORD_VERSION,
    run_id: runId,
    job_id: jobId,
    status: status === "success" ? "success" : "failure",
    finished_at: finishedAt,
    exit_code: exitCode ?? null,
    signal: signal ?? null,
    error: error ?? null,
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(record), "utf8");
    renameSync(tmp, path);
    return { written: true };
  } catch {
    return { written: false };
  }
}

/**
 * Read one run's session boundary with enough state to distinguish no record
 * from a record Helm cannot interpret. Ownership mismatches remain missing:
 * they are evidence for another job, not a damaged record for this one.
 */
export function readRunSessionOutcomeState({ cwd, jobId, runId }) {
  if (!cwd || !runId) return { kind: "missing", outcome: null };
  const path = runSessionOutcomePath(cwd, runId);
  if (!existsSync(path)) return { kind: "missing", outcome: null };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { kind: "unreadable", outcome: null };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "unreadable", outcome: null };
  }
  if (parsed.job_id && jobId && parsed.job_id !== jobId) {
    return { kind: "missing", outcome: null };
  }
  return { kind: "valid", outcome: parsed };
}

/** Read one run's session boundary, or null when it is absent or unreadable. */
export function readRunSessionOutcome(params) {
  return readRunSessionOutcomeState(params).outcome;
}

// The launch wrapper. It runs the real command, then writes the same record
// this module reads, from inside the session's own process tree — so the
// boundary is recorded even though every Helm process that could have watched
// for it has already exited.
//
// The script interpolates nothing: every value it writes comes from the
// environment Helm already exports into the launch (HELM_SCOPE_CWD,
// HELM_RUN_ID, HELM_JOB_ID), so no path or argument can alter what it runs. It
// writes only when no record exists yet, mirroring the write-once rule above,
// and it always exits with the command's own status, so nothing about the
// launch's own result changes.
const BOUNDARY_SCRIPT = [
  '"$0" "$@"',
  "s=$?",
  'd="$HELM_SCOPE_CWD/.helm/runs/session-outcomes"',
  'f="$d/$HELM_RUN_ID.json"',
  'if [ -n "$HELM_SCOPE_CWD" ] && [ -n "$HELM_RUN_ID" ] && [ ! -f "$f" ]; then',
  '  if [ "$s" -eq 0 ]; then st=success; er=null; else st=failure; er="\\"exit_code_$s\\""; fi',
  '  mkdir -p "$d" 2>/dev/null &&',
  '  printf \'{"version":"1.0","run_id":"%s","job_id":"%s","status":"%s","finished_at":"%s","exit_code":%s,"signal":null,"error":%s}\' "$HELM_RUN_ID" "$HELM_JOB_ID" "$st" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$s" "$er" > "$f.$$.tmp" 2>/dev/null &&',
  '  mv "$f.$$.tmp" "$f" 2>/dev/null',
  "fi",
  "exit $s",
].join("\n");

/**
 * Wrap a launch so the session records its own terminal boundary on exit.
 *
 * @param {{command: string, args?: string[]}} launch
 * @returns {{command: string, args: string[]}} the wrapped launch
 */
export function sessionBoundaryLaunch({ command, args = [] }) {
  return {
    command: "/bin/sh",
    args: ["-c", BOUNDARY_SCRIPT, command, ...args],
  };
}
