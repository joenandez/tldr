import path from "node:path";

// The unified package's front door command (`bin/tldr-agents`). Helm runs
// under it as `tldr-agents tasks …` and `tldr-agents assignments …`; once the
// old `helm-tasks` and `helm-assignments` bin aliases go (tracker item 36),
// they are not on PATH, so every command Helm tells an agent or a person to
// run takes its prefix from here. The root package keeps the same name in
// src/lib/front_door_command.mjs, which Helm must not import; a root test
// checks the two agree.
export const FRONT_DOOR_COMMAND = "tldr-agents";
export const TASKS_COMMAND = `${FRONT_DOOR_COMMAND} tasks`;
export const ASSIGNMENTS_COMMAND = `${FRONT_DOOR_COMMAND} assignments`;
export const MESSAGING_COMMAND = `${FRONT_DOOR_COMMAND} messaging`;
export const DEFAULT_REPORT_CMD = `${TASKS_COMMAND} report`;

function requireField(obj, name) {
  if (
    !obj ||
    obj[name] === undefined ||
    obj[name] === null ||
    obj[name] === ""
  ) {
    throw new Error(`helm_context: missing required field: ${name}`);
  }
  return obj[name];
}

/**
 * Build the `<helm-context>` block prepended to every managed job prompt.
 *
 * @param {object} [opts]
 * @param {string} opts.jobId
 * @param {string} opts.runId
 * @param {string} [opts.reportCmd=DEFAULT_REPORT_CMD]
 * @param {string} [opts.scopeId]
 * @param {string} [opts.scopeCwd]
 * @param {string} [opts.completionDeadlineAt]
 * @param {AssignmentContext} [opts.assignment] - Present only for assignment jobs.
 *   When provided, four self-awareness lines are appended after the HELM_RUN_ID line.
 *   Absent for all non-assignment jobs — non-assignment output is byte-identical to
 *   the pre-assignments baseline (guarded by the frozen golden-string test).
 */

/**
 * @typedef {object} AssignmentContext
 * @property {string} name       - Human-readable assignment name (job.name).
 * @property {string} skill_path - Absolute path to the backing SKILL.md.
 * @property {string} schedule   - Human-readable schedule string rendered at the callsite.
 * @property {'scheduled'|'direct'} run_mode - Whether this is a scheduled or direct run.
 *
 * id is NOT included here — it is already available as jobId in the outer params.
 * slug is derived as path.basename(path.dirname(skill_path)); not stored on the job record.
 */
export function buildHelmContextBlock({
  jobId,
  runId,
  reportCmd = DEFAULT_REPORT_CMD,
  scopeId,
  scopeCwd,
  completionDeadlineAt,
  assignment,
} = {}) {
  requireField({ jobId }, "jobId");
  requireField({ runId }, "runId");
  const lines = [
    "<helm-context>",
    "You are running inside a Helm scheduled job.",
    `HELM_JOB_ID=${jobId}`,
    `HELM_RUN_ID=${runId}`,
  ];
  if (scopeId !== undefined || scopeCwd !== undefined) {
    requireField({ scopeId }, "scopeId");
    requireField({ scopeCwd }, "scopeCwd");
    lines.push(`HELM_SCOPE_ID=${scopeId}`);
    lines.push(`HELM_SCOPE_CWD=${scopeCwd}`);
  }
  // Assignment self-awareness — only when an assignment arg is present.
  // Edit-permission is unconditional (scope §8 grants it to all assignment agents).
  if (assignment) {
    const slug = path.basename(path.dirname(assignment.skill_path));
    lines.push(
      `You are running Helm Assignment "${assignment.name}" (id ${jobId}).`,
      `Backing skill: ${slug} at ${assignment.skill_path}`,
      "You may edit this skill; changes take effect on the next run.",
      `Schedule: ${assignment.schedule}. This run: ${assignment.run_mode}.`,
      `Completion delivery: ${assignment.completion_delivery || "activity"}.`,
    );
  }
  if (assignment) {
    lines.push(
      "Required final step: before ending this assignment, you must run one of:",
      `  ${reportCmd} --status ok --summary "<one line>"`,
      `  ${reportCmd} --status fail --summary "<reason>"`,
      assignment.completion_delivery === "notify" ||
        assignment.completion_delivery === "conversation"
        ? "For both ok and fail reports, send the terminal Tightbeam result through this run's official thread. If no official conversation exists, the first send must use --channel subspace; retain the exact returned conversation_id and message_id. Reuse the exact returned conversation_id for this run, and only the message named by --completion-message satisfies the terminal requirement. Use --await-reply only when an interactive Agent Pane message explicitly asks the external user to respond; omit it for informational notifications, headless assignments, and daemon resumes. Then add --origin-thread <conversation_id> --completion-message <message_id>."
        : "No terminal Tightbeam message is required for activity delivery.",
      "Without a valid report, Helm records this assignment's outcome as indeterminate.",
    );
    if (completionDeadlineAt) {
      lines.push(`Report deadline: ${completionDeadlineAt}`);
    }
  } else {
    lines.push(
      "Optional: report this run's outcome and a one-line summary with one of:",
      `  ${reportCmd} --status ok --summary "<one line>"`,
      `  ${reportCmd} --status fail --summary "<reason>"`,
      "Helm records the outcome from this session's exit either way; skipping this only means the run delivers no completion message.",
    );
  }
  lines.push("Do not echo this block in your output.", "</helm-context>");
  return lines.join("\n");
}

export function buildHelmContextEnv({
  jobId,
  runId,
  reportCmd,
  scopeId,
  scopeCwd,
  reportRequired = false,
  completionDeadlineAt,
} = {}) {
  requireField({ jobId }, "jobId");
  requireField({ runId }, "runId");
  requireField({ reportCmd }, "reportCmd");
  const env = {
    HELM_JOB_ID: jobId,
    HELM_RUN_ID: runId,
    HELM_REPORT_CMD: reportCmd,
  };
  if (reportRequired) env.HELM_REPORT_REQUIRED = "1";
  if (completionDeadlineAt) {
    env.HELM_COMPLETION_DEADLINE_AT = completionDeadlineAt;
  }
  if (scopeId !== undefined || scopeCwd !== undefined) {
    requireField({ scopeId }, "scopeId");
    requireField({ scopeCwd }, "scopeCwd");
    env.HELM_SCOPE_ID = scopeId;
    env.HELM_SCOPE_CWD = scopeCwd;
  }
  return env;
}
