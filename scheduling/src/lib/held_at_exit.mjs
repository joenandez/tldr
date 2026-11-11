// Hold-at-exit: classify a failed run's stdout tail and write job.state.held (usage-limit / outage).
// Shared by every terminal finalize seam (classic completion, Skyhook pre-start, provider_run_outcome).
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { classifyAgentRun } from "./agent_fallback.mjs";
import { neverLaunched } from "./fallback_never_launched.mjs";
import { classifyHoldableFailure } from "./holdable_failure.mjs";
import { computeHeldDeadline, nextHeldRetry } from "./held_state.mjs";
import { isHeldJobPaused } from "./job_reregistration.mjs";
import { computeNextAfterRun } from "./schedule_eval.mjs";
import { heldNow } from "./held_release_core.mjs";
import { appendJobHistoryEvent } from "./read_store.mjs";

const TAIL_BYTES = 262144;

function log(event, fields) {
  process.stderr.write(`[helm held] ${JSON.stringify({ event, ...fields })}\n`);
}

/** Lines of the last `maxBytes` of a file; [] when missing or unreadable. */
export function readStdoutTail(path, maxBytes = TAIL_BYTES) {
  if (!path) return [];
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    const lines = buf.toString("utf8").split("\n");
    if (size > length) lines.shift(); // first line is cut mid-way
    return lines.filter(Boolean);
  } catch (error) {
    // A missing log is normal (no_log); anything else is worth one structured line.
    if (error?.code !== "ENOENT")
      log("held.stdout_unreadable", {
        code: error?.code ?? null,
        message: error?.message,
      });
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// execution_hints.provider is the adapter; academy jobs run claude unless configured otherwise.
export function providerOf(job) {
  const hints = job.execution_hints;
  if (hints?.provider !== "academy") return hints?.provider || null;
  const runtime = hints.provider_config?.academy_runtime;
  return runtime === "codex" ? "codex" : "claude";
}

function nextSlotMs(job, slot) {
  try {
    const next = computeNextAfterRun(job, new Date(slot).toISOString());
    return next.next_run_at ? Date.parse(next.next_run_at) : null;
  } catch {
    return null;
  }
}

function outcome(
  job,
  {
    runId,
    decision,
    held = null,
    classification = null,
    quietDecline = false,
    ...rest
  },
) {
  if (!(quietDecline && decision !== "held"))
    log("held.classified", {
      job: job.id,
      run: runId,
      decision,
      reason: classification?.reason ?? null,
      until: classification?.until ?? null,
      evidence: classification?.evidence ?? null,
    });
  return { decision, held, classification, jobId: job.id, ...rest };
}

function buildHeld(prior, c) {
  const same = prior && prior.slot === c.slot;
  const held = {
    slot: c.slot,
    reason: c.classification.reason,
    provider: c.provider,
    // Only a reported reset still ahead; one already past is no release time (fgp.58). Backoff is nextHeldRetry's.
    until:
      c.classification.until > Math.max(c.failedAt, c.now)
        ? c.classification.until
        : null,
    deadline: c.deadline,
    attempts: same ? (prior.attempts ?? 0) + 1 : 0,
    since: same ? prior.since : c.failedAt,
    last_failed_at: c.failedAt,
    release_at: null,
    run_id: c.runId,
  };
  return held;
}

/**
 * Run inside a mutateJobs callback (or on an in-memory job). Mutates job.state.held only.
 * decision: "held" | "not_holdable" | "deadline_passed" | "no_log" | "paused" (operator pause; a fired once-job is not paused).
 * attempts = failed held retries so far: 0 on the first hold, +1 per repeat failure of the same
 * slot (nextHeldRetry indexes backoff by it, so the first retry waits 5 min). A release must pass
 * startHeldRun heldAttempt = attempts + 1 (budget for the retry about to run).
 * nextSlot undefined -> computed with computeNextAfterRun(job, slot); null = no next slot.
 */
export function holdOnFailure(
  job,
  {
    runId,
    slot,
    provider = providerOf(job),
    stdoutPath,
    now = heldNow(),
    nextSlot,
    sawModelToolCall,
    quietDecline = false,
    failedAt = now, // the run's failure time; a start sweep passes the old run's, not its own clock
  },
) {
  const prior = job.state.held;
  const lines = readStdoutTail(stdoutPath);
  const classification = lines.length
    ? classifyHoldableFailure(lines, { provider, now: failedAt }) // a time-only reset is read as of the failure
    : null;
  const deadline = classification?.holdable
    ? computeHeldDeadline(
        job,
        slot,
        nextSlot === undefined ? nextSlotMs(job, slot) : nextSlot,
      )
    : null;
  const declined = [
    [isHeldJobPaused(job), "paused"],
    [!lines.length, "no_log"],
    [!classification?.holdable, "not_holdable"],
    [deadline <= now, "deadline_passed"],
  ].find(([cond]) => cond)?.[1];
  if (declined) {
    // A failure that is no longer holdable ends this slot's hold; other state stays as today.
    if (prior && prior.slot === slot) job.state.held = null;
    return outcome(job, {
      runId,
      decision: declined,
      classification,
      quietDecline,
    });
  }

  const held = buildHeld(prior, {
    slot,
    classification,
    provider,
    deadline,
    failedAt,
    now,
    runId,
  });
  job.state.held = held;
  log("held.set", {
    job: job.id,
    run: runId,
    reason: held.reason,
    until: held.until,
    deadline,
    attempts: held.attempts,
  });
  return outcome(job, {
    runId,
    decision: "held",
    held,
    classification,
    // Without fallback evidence from the caller, read tool calls off the same stdout tail.
    sawModelToolCall:
      sawModelToolCall ??
      classifyAgentRun(provider, {
        stdout: lines.join("\n"),
        status: "failure",
      }).saw_model_tool_call,
  });
}

/** Payload for history kind `held`. */
export function heldHistoryPayload(job, res, { runId }) {
  const h = res.held;
  return {
    reason: h.reason,
    retry_at: nextHeldRetry(h, h.last_failed_at),
    deadline: h.deadline,
    provider: h.provider,
    saw_model_tool_call: Boolean(res.sawModelToolCall),
    attempts: h.attempts,
    slot: h.slot,
    run_id: runId,
    // The exact hold, so a tick can restore it if this run's completion persist is abandoned (fgp.52).
    held: h,
  };
}

/** Append the `held` event after the `completed` one; no-op unless the decision was "held".
 * `run` is {runId, scheduledAt, finishedAt} or a pending marker
 * {run_id, scheduled_at} plus finishedAt (the event ts). */
export function appendHeld(scope, run, res) {
  if (res?.decision !== "held") return;
  const runId = run.runId ?? run.run_id;
  appendJobHistoryEvent(scope, res.jobId, {
    id: `run_${runId}_held`,
    ts: run.finishedAt,
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    job_id: res.jobId,
    run_id: runId,
    kind: "held",
    status: "held",
    reason: res.held.reason,
    scheduled_at: run.scheduledAt ?? run.scheduled_at ?? null,
    payload: heldHistoryPayload(null, res, { runId }),
  });
}

/** A successful run (including a held release) clears the hold. @returns {boolean} cleared */
export function clearHeldOnSuccess(job) {
  if (!job.state.held) return false;
  job.state.held = null;
  return true;
}

/** The agent whose output decides the hold; history records it as `payload.agent` for the start sweep. */
export function decidingAgent(fb) {
  const unlaunched =
    fb?.fallback_triggered && neverLaunched(fb.fallback_failure_summary);
  return (unlaunched ? fb.primary_agent : fb?.selected_agent) || null;
}

/** Seam entry for every way a run ends (classic, Skyhook pre-start, post-handoff, superseded).
 * `run` is {runId, scheduledAt, logPaths, finishedAt} or a pending marker
 * {run_id, scheduled_at, log_paths, agent?} plus finishedAt; success clears the hold, anything else is classified.
 * The agent that finally ran (AC-15) is `terminal.agent_fallback.selected_agent` (which also carries
 * tool-call evidence) or the marker's `agent`; else the job's provider. A fallback that never spawned
 * (ENOENT) produced no outcome, so the primary stays the deciding agent. @returns decision object|null */
export function holdAtExit(job, terminal, run) {
  if (terminal.status === "success") return (clearHeldOnSuccess(job), null);
  const slot = Date.parse(run.scheduledAt ?? run.scheduled_at);
  if (!Number.isFinite(slot)) return null;
  const fb = terminal.agent_fallback;
  const agent = decidingAgent(fb) || run.agent;
  return holdOnFailure(job, {
    runId: run.runId ?? run.run_id,
    slot,
    stdoutPath: (run.logPaths ?? run.log_paths)?.stdout,
    now: Date.parse(run.finishedAt),
    ...(agent && { provider: agent }),
    ...(fb && { sawModelToolCall: Boolean(fb.primary_saw_model_tool_call) }),
  });
}

/** Job-update result for a run that is no longer the job's latest: last_* stay with the newer run,
 * but its own slot's hold is still cleared (or re-held), so a held re-run outliving a run-now never re-releases. */
export function supersededRun(job, terminal, run) {
  const sameSlot = job.state.held?.slot === Date.parse(run.scheduled_at);
  const hold = sameSlot ? holdAtExit(job, terminal, run) : null;
  return { applied: false, reason: "newer_run_recorded", hold };
}

/** Completed events that count toward consecutive-failure auto-pause: held runs are excluded. */
export function countable(events) {
  const heldRuns = new Set(
    events.filter((e) => e.kind === "held").map((e) => e.run_id),
  );
  return events.filter(
    (e) => e.kind === "completed" && !heldRuns.has(e.run_id),
  );
}
