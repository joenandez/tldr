import { fail, output } from "./json_io.mjs";
import { summarizeAssignmentRunsAcrossScopes } from "./assignment_list.mjs";
import { loadJobsReadOnly, resolveScope } from "./store.mjs";
import { summarizeJobRuns } from "./run_completion.mjs";

const isAssignment = (job) =>
  Array.isArray(job.tags) && job.tags.includes("assignment");

export function handleAssignmentRuns(flags, positionals, pretty, resolveJob) {
  const cmd = "runs";
  const query = positionals[1];
  if (flags["all-scopes"]) {
    if (query) {
      fail(
        cmd,
        "invalid_args",
        "<id|name> cannot be combined with --all-scopes",
        {},
        pretty,
      );
      process.exit(2);
    }
    const result = summarizeAssignmentRunsAcrossScopes();
    if (!result.ok) {
      output(
        cmd,
        false,
        {
          failed_scopes: result.failures,
          scanned_scopes: result.scanned_scopes,
        },
        result.failures.map((entry) => ({
          code: entry.code,
          message: entry.detail,
        })),
        pretty,
      );
      process.exit(1);
    }
    output(
      cmd,
      true,
      {
        runs: result.runs,
        scopes: result.scopes,
        scanned_scopes: result.scanned_scopes,
      },
      [],
      pretty,
    );
    return;
  }
  if (!query) {
    fail(cmd, "missing_arg", "<id|name> is required", {}, pretty);
    process.exit(2);
  }
  const cwd = typeof flags.cwd === "string" ? flags.cwd : process.cwd();
  const scope = resolveScope({ cwd });
  const jobs = loadJobsReadOnly(scope).filter(isAssignment);
  const job = resolveJob(cmd, jobs, query, pretty);
  output(
    cmd,
    true,
    { runs: summarizeJobRuns({ scope, jobId: job.id, job }) },
    [],
    pretty,
  );
}
