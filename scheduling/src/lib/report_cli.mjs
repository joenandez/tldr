import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fail, output } from "./json_io.mjs";
import { withFileMutex } from "./substrate/file_mutex.mjs";

function reportFailure(code, message, pretty) {
  fail("report", code, message, {}, pretty);
  return 2;
}

function readExistingReport(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function opaqueEvidence(flags, key) {
  if (flags[key] === undefined) return { value: null };
  const value = typeof flags[key] === "string" ? flags[key].trim() : "";
  return value ? { value } : { error: key };
}

export function runReportCommand({
  flags,
  cwd,
  env = process.env,
  now,
  pretty = false,
}) {
  const required = env.HELM_REPORT_REQUIRED === "1";
  // TASK-C2AD2E9E — a resumed session executes under its own resume job, but
  // the completion it is reporting belongs to the assignment run that
  // launched the session it resumed. run_completion only accepts a side-car
  // whose job_id matches the job it is projecting, so a report filed under
  // the resume job is written, then silently disowned, and the assignment
  // reads indeterminate as if the agent never answered.
  //
  // Explicit flags still win: an operator naming a run means that run.
  const originJobId = env.HELM_ORIGIN_JOB_ID || null;
  const originRunId = env.HELM_ORIGIN_RUN_ID || null;
  const useOrigin = Boolean(
    !flags.run && !flags.job && originJobId && originRunId,
  );
  const executingJobId = env.HELM_JOB_ID || null;
  const runId =
    flags.run || (useOrigin ? originRunId : env.HELM_RUN_ID) || null;
  const jobId = flags.job || (useOrigin ? originJobId : executingJobId) || null;
  const status = flags.status ? String(flags.status).toLowerCase() : null;
  const summary = flags.summary ? String(flags.summary) : null;
  const sessionId = flags.session || null;
  const resumeCommand = flags["resume-command"] || null;
  const originThread = opaqueEvidence(flags, "origin-thread");
  const completionMessage = opaqueEvidence(flags, "completion-message");
  if (originThread.error || completionMessage.error) {
    return reportFailure(
      "report_communication_evidence_invalid",
      "helm-tasks report: --origin-thread and --completion-message must be non-empty identifiers",
      pretty,
    );
  }

  if (!runId) {
    if (required) {
      return reportFailure(
        "report_run_id_required",
        "helm-tasks report: assignment reporting requires a run id",
        pretty,
      );
    }
    output(
      "report",
      true,
      {
        warning: "no_run_id",
        message:
          "helm-tasks report: no --run flag and no HELM_RUN_ID env; skipping (best-effort)",
      },
      [],
      pretty,
    );
    return 0;
  }
  if (required && !jobId) {
    return reportFailure(
      "report_job_id_required",
      "helm-tasks report: assignment reporting requires a job id",
      pretty,
    );
  }
  if (required && !status) {
    return reportFailure(
      "report_status_required",
      "helm-tasks report: assignment reporting requires --status ok|fail",
      pretty,
    );
  }
  if (status && !["ok", "fail"].includes(status)) {
    if (required) {
      return reportFailure(
        "report_status_invalid",
        `helm-tasks report: --status must be ok|fail; got ${status}`,
        pretty,
      );
    }
    output(
      "report",
      true,
      {
        warning: "invalid_status",
        message: `helm-tasks report: --status must be ok|fail; got ${status}`,
      },
      [],
      pretty,
    );
    return 0;
  }
  const deadlineMs = Date.parse(env.HELM_COMPLETION_DEADLINE_AT || "");
  const nowMs = Date.parse(now || "");
  if (
    required &&
    !Number.isNaN(deadlineMs) &&
    !Number.isNaN(nowMs) &&
    nowMs >= deadlineMs
  ) {
    return reportFailure(
      "report_deadline_exceeded",
      `helm-tasks report: assignment reporting deadline passed at ${env.HELM_COMPLETION_DEADLINE_AT}`,
      pretty,
    );
  }

  const dir = join(cwd, ".helm", "runs", "reports");
  mkdirSync(dir, { recursive: true });
  const finalPath = join(dir, `${runId}.json`);
  return withFileMutex(`${finalPath}.lock`, () => {
    const existing = readExistingReport(finalPath);
    const existingOriginThreadId = existing?.origin_thread_id
      ? String(existing.origin_thread_id).trim() || null
      : null;
    const existingCompletionMessageId = existing?.completion_message_id
      ? String(existing.completion_message_id).trim() || null
      : null;
    const conflicts = [];
    if (
      originThread.value &&
      existingOriginThreadId &&
      originThread.value !== existingOriginThreadId
    ) {
      conflicts.push("origin_thread_id");
    }
    if (
      completionMessage.value &&
      existingCompletionMessageId &&
      completionMessage.value !== existingCompletionMessageId
    ) {
      conflicts.push("completion_message_id");
    }
    const communicationIssue =
      conflicts.length > 0
        ? "communication_evidence_conflict"
        : existing?.communication_issue || null;

    const payload = {
      job_id: jobId,
      run_id: runId,
      status,
      summary,
      session_id: sessionId,
      resume_command: resumeCommand,
      origin_thread_id: existingOriginThreadId || originThread.value,
      completion_message_id:
        existingCompletionMessageId || completionMessage.value,
      communication_issue: communicationIssue,
      written_at: now,
      // Keep the job that actually wrote the report auditable, so an
      // origin-attributed report is never indistinguishable from one the
      // assignment run wrote itself.
      ...(useOrigin && executingJobId
        ? { reported_by_job_id: executingJobId }
        : {}),
    };
    if (useOrigin) {
      process.stderr.write(
        `[🪳 TEMP AUTHORITY] report attributed to origin job=${jobId} run=${runId} reported_by=${executingJobId}\n`,
      );
    }
    const tmpPath = `${finalPath}.tmp-${process.pid}`;
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
    renameSync(tmpPath, finalPath);
    output(
      "report",
      true,
      {
        path: finalPath,
        payload,
        ...(conflicts.length > 0
          ? { warning: "communication_evidence_conflict", conflicts }
          : {}),
      },
      [],
      pretty,
    );
    return 0;
  });
}
