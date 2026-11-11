// assignment_task_rows — the plain-job half of `assignments list --include-tasks`.
//
// A consumer that shows "everything scheduled" needs plain Helm jobs in the
// same row shape as assignments. `tasks list-all` cannot serve it: it swallows
// unreadable scopes as empty lists and publishes a different row. This module
// owns the three facts the assignment projection lacks for a plain job — its
// kind, what it runs, and its status — plus the pre-read scope filter that keeps
// dead and throwaway scopes out of that read.

import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { sep } from "node:path";

export const isAssignment = (job) =>
  Array.isArray(job?.tags) && job.tags.includes("assignment");

// An assignment carries its own lifecycle status (it can be archived). A plain
// job has only the enabled bit, so its status is derived from that.
export function jobStatus(job) {
  if (isAssignment(job)) return job.metadata?.assignment?.status || "active";
  return job?.state?.enabled === false ? "disabled" : "active";
}

// What the job runs, as three explicit fields so a reader never has to guess
// which one it got: inline prompt text, a prompt file path, or a command line.
export function jobWorkFields(job) {
  const prompt = job.prompt || null;
  const processSpec = job.process || null;
  if (processSpec?.args !== undefined && !Array.isArray(processSpec.args)) {
    throw new Error("process.args is not an array");
  }
  return {
    kind: isAssignment(job) ? "assignment" : "task",
    prompt: prompt?.type === "inline" ? (prompt.value ?? null) : null,
    prompt_path: prompt?.type === "file" ? (prompt.path ?? null) : null,
    command: processSpec?.command
      ? [processSpec.command, ...(processSpec.args || [])].join(" ")
      : null,
  };
}

export const DESCRIPTION_MAX_CHARS = 500;

// One bound for every free-text row field: description, prompt, command.
export function boundedText(field, text) {
  const full = String(text ?? "");
  const characters = [...full];
  const truncated = characters.length > DESCRIPTION_MAX_CHARS;
  return {
    [field]: truncated
      ? characters.slice(0, DESCRIPTION_MAX_CHARS).join("")
      : full,
    [`${field}_truncated`]: truncated,
  };
}

const boundedOrNull = (field, text) =>
  text === null
    ? { [field]: null, [`${field}_truncated`]: false }
    : boundedText(field, text);

// jobWorkFields with prompt and command bounded for a list row.
export function boundedWorkFields(job) {
  const work = jobWorkFields(job);
  return {
    ...work,
    ...boundedOrNull("prompt", work.prompt),
    ...boundedOrNull("command", work.command),
  };
}

// Temp roots on macOS and Linux. HELM_TEMP_SCOPE_ROOTS (path-delimited)
// replaces the list; tests use it because their own scopes live under tmpdir.
function tempRoots(env = process.env) {
  if (env.HELM_TEMP_SCOPE_ROOTS) {
    return env.HELM_TEMP_SCOPE_ROOTS.split(":").filter(Boolean);
  }
  const roots = ["/tmp", "/private/tmp", "/private/var/folders"];
  try {
    roots.push(realpathSync(tmpdir()));
  } catch {
    // An unreadable tmpdir adds nothing; the fixed roots still apply.
  }
  return roots;
}

const isUnder = (path, root) => path === root || path.startsWith(root + sep);

// Decides from the registry entry alone — no catalog, history, or ledger read
// — whether a scope is skipped. Returns the exclusion record or null.
export function scopeExclusion(entry, env = process.env) {
  const cwd = entry?.cwd || entry?.scope_id;
  if (typeof cwd !== "string" || !cwd) return null;
  const record = (reason) => ({
    scope_id: String(entry.scope_id ?? cwd),
    cwd,
    reason,
  });
  const real = existingRealpath(cwd);
  if (!real) return record("cwd_missing");
  return tempRoots(env).some((root) => isUnder(real, root))
    ? record("temp_scope")
    : null;
}

function existingRealpath(path) {
  try {
    return existsSync(path) ? realpathSync(path) : null;
  } catch {
    return null;
  }
}
