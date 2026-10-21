// Commits a reviewed notification draft as one Helm job tagged with the draft
// id. `tasks list --tag <draft-id>` runs first, so a confirm retried after an
// interrupted commit (job created, draft still committing) finds the job and
// creates no second one. The job spec comes from the confirming agent after
// the user's fresh review; the draft itself keeps only the summary. The
// reported status is the job's own, as Helm stored it.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HELM_TASKS = fileURLToPath(
  new URL("../../scheduling/src/helm-tasks.mjs", import.meta.url),
);

function commitError(code, message) {
  return Object.assign(new Error(message), { code });
}

// The draft CLI already runs on the verified packaged runtime, so Helm runs
// on the same Node binary and entrypoint that `tldr-agents tasks` would use.
function helmTasksRunner(env) {
  return (args, { input } = {}) => {
    const result = spawnSync(process.execPath, [HELM_TASKS, ...args], {
      encoding: "utf8",
      env,
      input,
    });
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw commitError(
        "HELM_TASKS_UNREADABLE",
        `helm-tasks ${args[0]} exited ${result.status} without a JSON reply`,
      );
    }
  };
}

function requireOk(reply) {
  if (reply?.ok) return reply.data;
  const [error] = reply?.errors ?? [];
  throw commitError(
    error?.code ?? "HELM_TASKS_FAILED",
    error?.message ?? "helm-tasks refused",
  );
}

function jobOutcome(job, reused, cwd) {
  return {
    job_id: job.id,
    cwd,
    lifecycle_status: job.lifecycle_status,
    enabled: job.state?.enabled,
    next_run_at: job.state?.next_run_at ?? null,
    reused,
  };
}

export function createHelmDraftJobCommitter({
  cwd,
  jobSpec,
  env = process.env,
  runTasks = helmTasksRunner(env),
}) {
  return async function commitJob(draft) {
    if (!jobSpec || typeof jobSpec !== "object" || Array.isArray(jobSpec)) {
      throw commitError(
        "DRAFT_JOB_SPEC_REQUIRED",
        "a notification draft needs the reviewed job as --job-file <path>|-",
      );
    }
    // A retry commits where the first claim recorded, not where it runs.
    const workspace = draft.commit_cwd ?? cwd;
    const listed = requireOk(
      runTasks(["list", "--cwd", workspace, "--tag", draft.id]),
    );
    if (listed.jobs.length > 0)
      return jobOutcome(listed.jobs[0], true, workspace);
    const tags = [...new Set([...(jobSpec.tags ?? []), draft.id])];
    const created = requireOk(
      runTasks(["create", "--cwd", workspace, "--stdin"], {
        input: JSON.stringify({ ...jobSpec, tags }),
      }),
    );
    return jobOutcome(created.job, false, workspace);
  };
}
