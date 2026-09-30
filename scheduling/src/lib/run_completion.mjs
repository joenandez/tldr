// run_completion — deterministic per-run completion records.
//
// A dispatched run can terminate for two very different reasons:
//
//   1. the run's own process exited — the terminal status IS the work outcome;
//   2. the dispatcher handed the work to a long-lived agent session and
//      returned — the terminal status only proves the session launched.
//
// Case 2 finalizes the attempt as "succeeded" with terminal_reason
// "skyhook_started" seconds after start, so every consumer reading the raw
// terminal status sees work-success for work that has not happened yet. This
// module keeps that launch fact readable as `dispatch_status` and derives a
// separate `work_status` that only ever describes the work itself.
//
// Assignments must publish `helm-tasks report --status ok|fail`. A session exit
// without that report is indeterminate. If the best-effort session boundary is
// missing or unreadable, the hard-runtime deadline supplies a stable terminal
// indeterminate result instead of leaving the run launched forever. Reports
// are ownership-checked and cannot change that result after the deadline.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readAgentRunSession } from "./agent_run_session.mjs";
import { historyForJob } from "./observability_service.mjs";
import { completionDeadlineAt } from "./run_deadline.mjs";
import { readRunSessionOutcomeState } from "./run_session_outcome.mjs";
import { resolveRunSource } from "./run_source.mjs";
import { prospectiveCommunicationProjection } from "./assignment_completion_delivery.mjs";

const HISTORY_DEPTH = 200;

const HANDOFF_REASONS = new Set(["skyhook_started"]);
const HANDOFF_SOURCES = new Set(["skyhook-handoff"]);

const TERMINAL_KINDS = new Set(["completed", "skipped", "cancelled"]);

const WORK_STATUS_BY_TERMINAL = Object.freeze({
  success: "succeeded",
  failure: "failed",
  timeout: "failed",
  skipped: "skipped",
  cancelled: "cancelled",
});

// The one definition of "the work is over". Derived from the map above rather
// than restated, so a second notion of terminal cannot drift away from the one
// the completion records are built with. `launched` and `running` are absent by
// construction: `launched` means a session started and nothing yet proves the
// work finished, `running` means no terminal event has arrived at all.
const TERMINAL_WORK_STATUSES = Object.freeze(
  new Set([...Object.values(WORK_STATUS_BY_TERMINAL), "indeterminate"]),
);

/** True when a run's work outcome means the work itself has finished. */
export function isTerminalWorkStatus(workStatus) {
  return TERMINAL_WORK_STATUSES.has(workStatus);
}

function reportPath(cwd, runId) {
  return join(cwd, ".helm", "runs", "reports", `${runId}.json`);
}

// Non-destructive read. The dispatcher consumes this side-car for runs it
// supervises to completion; handoff runs leave it on disk, which is exactly
// the case that needs it.
function readReportSidecar(cwd, runId) {
  if (!cwd || !runId) return null;
  const path = reportPath(cwd, runId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// The side-car is keyed by run id alone, so it is scope-global: every job in
// the scope can read it. Folding another job's report onto this job would
// invent a record for work this job never ran, so ownership is checked.
// A record written before the side-car carried job_id has no owner stamp; it is
// accepted only when this job's own history claims the run, which is the same
// evidence the stamp would have given.
function sidecarForJob({ cwd, runId, jobId, hasRunEvents }) {
  const raw = readReportSidecar(cwd, runId);
  if (!raw) return null;
  if (raw.job_id) return raw.job_id === jobId ? raw : null;
  return hasRunEvents ? raw : null;
}

function eventsForRun(events, runId) {
  return (events || []).filter((event) => event?.run_id === runId);
}

function latestOf(events, predicate) {
  return (
    [...events]
      .filter(predicate)
      .sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")))
      .slice(-1)[0] || null
  );
}

function isHandoffTerminal(event) {
  if (!event) return false;
  return (
    HANDOFF_REASONS.has(event.reason) ||
    HANDOFF_REASONS.has(event.error) ||
    HANDOFF_SOURCES.has(event.payload?.terminal_source) ||
    event.payload?.handoff === true
  );
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

// The report can reach us two ways: as the on-disk side-car (handoff runs) or
// already folded onto the terminal history event by the dispatcher (supervised
// runs). Both carry the same report facts.
function reportFrom(sidecar, terminal) {
  const status = sidecar?.status ?? terminal?.agent_status ?? null;
  const summary = sidecar?.summary ?? terminal?.agent_summary ?? null;
  if (!["ok", "fail"].includes(status)) return null;
  return {
    status,
    summary: nonEmptyString(summary),
    error: sidecar?.error ?? terminal?.agent_error ?? null,
    reported_at: sidecar?.written_at ?? terminal?.finished_at ?? null,
    session_id: sidecar?.session_id ?? null,
    origin_thread_id:
      sidecar?.origin_thread_id ?? terminal?.agent_origin_thread_id ?? null,
    completion_message_id:
      sidecar?.completion_message_id ??
      terminal?.agent_completion_message_id ??
      null,
    communication_issue:
      sidecar?.communication_issue ??
      terminal?.agent_communication_issue ??
      null,
  };
}

function outcomeFromReport(report) {
  return {
    work_status: report.status === "ok" ? "succeeded" : "failed",
    outcome_source: "agent_report",
    finished_at: report.reported_at || null,
    final_message: report.summary,
    error: report.status === "ok" ? null : report.error || null,
  };
}

function outcomeFromTerminal(terminal) {
  if (isHandoffTerminal(terminal)) {
    // The session was launched; nothing yet proves the work finished.
    return {
      work_status: "launched",
      outcome_source: "session_launch",
      finished_at: null,
      final_message: null,
      error: null,
    };
  }
  return {
    work_status: WORK_STATUS_BY_TERMINAL[terminal.status] || "failed",
    outcome_source: "process_exit",
    finished_at: terminal.finished_at || terminal.ts || null,
    final_message: null,
    error: terminal.error || null,
  };
}

// The session the dispatcher launched has exited without a valid agent report.
// The boundary proves the run is over, but its process status cannot truthfully
// establish whether the requested work succeeded or failed.
function outcomeFromSession(session) {
  return {
    work_status: "indeterminate",
    outcome_source: "session_exit",
    finished_at: session.finished_at || null,
    final_message: null,
    error: "agent_report_missing",
  };
}

function reportBeforeDeadline(report, deadlineAt) {
  if (!report || !deadlineAt || !report.reported_at) return report;
  const reportedMs = Date.parse(report.reported_at);
  const deadlineMs = Date.parse(deadlineAt);
  if (Number.isNaN(reportedMs) || Number.isNaN(deadlineMs)) return report;
  return reportedMs < deadlineMs ? report : null;
}

function deadlineReached(now, deadlineAt) {
  const nowMs = Date.parse(now || "");
  const deadlineMs = Date.parse(deadlineAt || "");
  return (
    !Number.isNaN(nowMs) && !Number.isNaN(deadlineMs) && nowMs >= deadlineMs
  );
}

function outcomeFromDeadline(deadlineAt, sessionState) {
  return {
    work_status: "indeterminate",
    outcome_source: "report_deadline",
    finished_at: deadlineAt,
    final_message: null,
    error:
      sessionState.kind === "unreadable"
        ? "session_outcome_unreadable"
        : "completion_report_deadline_exceeded",
  };
}

// Precedence: timely report, session boundary, expired reporting deadline,
// then the dispatch terminal event for runs whose own process was the work.
// Session and deadline evidence apply only after a real handoff.
function outcomeFor({ terminal, report, sessionState, deadlineAt, now }) {
  if (report) return outcomeFromReport(report);
  const session = sessionState.outcome;
  if (session && (!terminal || isHandoffTerminal(terminal))) {
    return outcomeFromSession(session);
  }
  if (
    terminal &&
    isHandoffTerminal(terminal) &&
    deadlineReached(now, deadlineAt)
  ) {
    return outcomeFromDeadline(deadlineAt, sessionState);
  }
  if (terminal) return outcomeFromTerminal(terminal);
  return {
    work_status: "running",
    outcome_source: "pending",
    finished_at: null,
    final_message: null,
    error: null,
  };
}

function sessionIdFor({ runEvents, report, jobId, runId }) {
  for (const event of [...runEvents].reverse()) {
    const found = nonEmptyString(event.session_id ?? event.payload?.session_id);
    if (found) return found;
  }
  if (report?.session_id) return nonEmptyString(report.session_id);
  const linked = readAgentRunSession({ jobId, runId });
  return linked.ok ? nonEmptyString(linked.session_id) : null;
}

function durationMs(startedAt, finishedAt) {
  const start = Date.parse(startedAt || "");
  const end = Date.parse(finishedAt || "");
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return end - start;
}

/**
 * Build the completion record for one run.
 *
 * @param {object} params
 * @param {string} params.cwd     Scope working directory (report side-car root).
 * @param {string} params.jobId   Owning job id.
 * @param {string} params.runId   Run id the record is keyed by.
 * @param {object[]} params.events Job history events (any run ids; filtered here).
 * @param {object} [params.job]    Owning job (for hard-runtime policy).
 * @param {string} [params.now]    Projection time.
 * @returns {object|null} the record, or null when the run is unknown.
 */
export function buildRunCompletion({
  cwd,
  jobId,
  runId,
  events,
  job = null,
  now = process.env.HELM_NOW || new Date().toISOString(),
}) {
  const runEvents = eventsForRun(events, runId);
  const sidecar = sidecarForJob({
    cwd,
    runId,
    jobId,
    hasRunEvents: runEvents.length > 0,
  });
  if (runEvents.length === 0 && !sidecar) return null;

  const started = latestOf(runEvents, (event) => event.kind === "started");
  const terminal = latestOf(runEvents, (event) =>
    TERMINAL_KINDS.has(event.kind),
  );
  const startedAt =
    started?.started_at ||
    started?.ts ||
    terminal?.started_at ||
    terminal?.ts ||
    null;
  const deadlineAt = completionDeadlineAt({ startedAt, job });
  const reported = reportFrom(sidecar, terminal);
  const report = isHandoffTerminal(terminal)
    ? reportBeforeDeadline(reported, deadlineAt)
    : reported;
  const sessionState = readRunSessionOutcomeState({ cwd, jobId, runId });
  const outcome = outcomeFor({
    terminal,
    report,
    sessionState,
    deadlineAt,
    now,
  });
  const source = resolveRunSource(runId, runEvents);
  const communication = prospectiveCommunicationProjection({
    startedEvent: started,
    workStatus: outcome.work_status,
    outcomeSource: outcome.outcome_source,
    originThreadId: report?.origin_thread_id,
    completionMessageId: report?.completion_message_id,
    communicationIssue: report?.communication_issue,
  });

  const record = {
    run_id: runId,
    job_id: jobId,
    ...source,
    work_status: outcome.work_status,
    outcome_source: outcome.outcome_source,
    started_at: startedAt,
    finished_at: outcome.finished_at,
    duration_ms: durationMs(startedAt, outcome.finished_at),
    final_message: outcome.final_message,
    message_delivered: outcome.final_message !== null,
    error: outcome.error,
    session_id: sessionIdFor({ runEvents, report, jobId, runId }),
    dispatch_status: terminal?.status ?? null,
    terminal_reason: terminal?.reason ?? null,
  };
  if (communication) Object.assign(record, communication);
  return record;
}

export function findRunCompletion({ scope, jobs, runId }) {
  for (const job of jobs) {
    const completion = buildRunCompletion({
      cwd: scope.cwd,
      jobId: job.id,
      runId,
      events: historyForJob(scope, job.id, HISTORY_DEPTH),
      job,
    });
    if (completion) return completion;
  }
  return null;
}

export function summarizeJobRuns({ scope, jobId, job = null }) {
  return summarizeRuns({
    cwd: scope.cwd,
    jobId,
    events: historyForJob(scope, jobId, HISTORY_DEPTH),
    job,
  });
}

export function summarizeRuns({ cwd, jobId, events, job = null }) {
  const byRunId = new Map();
  for (const event of events || []) {
    if (!event?.run_id) continue;
    const entry = byRunId.get(event.run_id) || {
      run_id: event.run_id,
      mode: null,
    };
    if (event.kind === "started") {
      entry.mode = event.reason === "manual" ? "direct" : "scheduled";
    }
    byRunId.set(event.run_id, entry);
  }

  return [...byRunId.values()]
    .map((entry) => {
      const completion = buildRunCompletion({
        cwd,
        jobId,
        runId: entry.run_id,
        events,
        job,
      });
      return {
        run_id: entry.run_id,
        mode: entry.mode,
        status: completion.work_status,
        ...completion,
      };
    })
    .sort((a, b) =>
      String(a.started_at || "").localeCompare(String(b.started_at || "")),
    );
}
