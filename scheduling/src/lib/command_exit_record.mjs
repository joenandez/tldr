// command_exit_record — the exit status of a handed-off command job, persisted
// by the command's own process tree.
//
// A scheduled command job returns to the dispatcher once it survives its
// startup window. The command keeps running, and the process that launched it
// usually does not: the daemon dispatches each due scope in a short-lived
// forked child. Recording "success" at that handoff is a claim about work that
// has not finished yet, so the run stays open until its exit is observed.
//
// The launch is wrapped so the command's own process tree writes its exit
// status next to the run's logs as it ends. Whoever is still around reads it:
// the dispatcher's in-process observer when it outlives the command, otherwise
// the reaper once the wrapper PID is gone (src/lib/command_exit_finalization.mjs).
//
// Mirrors run_session_outcome.mjs, but writes under the Helm-owned log
// directory instead of the job's working directory, so a command running in a
// read-only or foreign cwd still gets its exit recorded.

import { X_OK } from "node:constants";
import { accessSync, existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

const RECORD_VERSION = "1.0";

/** Path of a run's exit record, alongside its stdout/stderr logs. */
export function commandExitRecordPath(logPaths) {
  const stdout = logPaths?.stdout;
  if (typeof stdout !== "string" || !stdout.endsWith(".stdout.log")) {
    return null;
  }
  return `${stdout.slice(0, -".stdout.log".length)}.exit.json`;
}

// Nothing is interpolated: the target path arrives through HELM_RUN_EXIT_PATH,
// which Helm exports into the launch, and the run/job ids come from the env
// Helm already sets. Write-once, and the wrapper always exits with the
// command's own status so the launch result is unchanged.
const EXIT_BOUNDARY_SCRIPT = [
  '"$0" "$@"',
  "s=$?",
  'f="$HELM_RUN_EXIT_PATH"',
  'if [ -n "$f" ] && [ ! -f "$f" ]; then',
  '  if [ "$s" -eq 0 ]; then st=success; er=null; else st=failure; er="\\"exit_code_$s\\""; fi',
  '  printf \'{"version":"1.0","run_id":"%s","job_id":"%s","status":"%s","finished_at":"%s","exit_code":%s,"signal":null,"error":%s}\' "$HELM_RUN_ID" "$HELM_JOB_ID" "$st" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$s" "$er" > "$f.$$.tmp" 2>/dev/null &&',
  '  mv "$f.$$.tmp" "$f" 2>/dev/null',
  "fi",
  "exit $s",
].join("\n");

/**
 * Wrap a command so its process tree records its own exit status.
 *
 * @param {{command: string, args?: string[]}} launch
 * @returns {{command: string, args: string[]}}
 */
export function commandExitBoundaryLaunch({ command, args = [] }) {
  return {
    command: "/bin/sh",
    args: ["-c", EXIT_BOUNDARY_SCRIPT, command, ...args],
  };
}

function isExecutable(path) {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `command` would resolve to an executable, the way spawn would look
 * it up. The shell wrapper turns a missing command into exit 127, so this
 * keeps a typo reported as the spawn error it is.
 */
export function commandResolvable(command, { cwd = process.cwd(), env } = {}) {
  if (typeof command !== "string" || command === "") return false;
  if (command.includes("/")) {
    return isExecutable(isAbsolute(command) ? command : resolve(cwd, command));
  }
  const searchPath = String(env?.PATH ?? process.env.PATH ?? "");
  return searchPath
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => isExecutable(join(dir, command)));
}

/**
 * Read one run's exit record.
 *
 * @returns {{kind: "missing"|"unreadable"|"valid", record: object|null}}
 */
export function readCommandExitRecord(path, { jobId = null, runId = null } = {}) {
  if (!path || !existsSync(path)) return { kind: "missing", record: null };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { kind: "unreadable", record: null };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "unreadable", record: null };
  }
  if (
    (jobId && parsed.job_id && parsed.job_id !== jobId) ||
    (runId && parsed.run_id && parsed.run_id !== runId)
  ) {
    return { kind: "missing", record: null };
  }
  return { kind: "valid", record: { version: RECORD_VERSION, ...parsed } };
}
