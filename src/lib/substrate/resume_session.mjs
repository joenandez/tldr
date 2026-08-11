// PRFAQ-0-1 Phase 1 Layer 3 — resume-end invocation.
//
// Closes the Case A stub: when comms_dispatcher detects a dead session PID
// for an inbound reply, it must actually invoke `claude --resume <id>` (or
// the codex equivalent) so the queued inbox.jsonl entries get consumed.
// Pre-L3 the dispatcher only recorded the decision string and the resume
// command — nothing executed.
//
// tldr; owns this exact-resume seam directly. It starts only the exact
// Claude/Codex continuation process and returns after process-start
// confirmation while retaining bounded terminal supervision in the daemon.

import { isAbsolute } from "node:path";
import { appendActivityEvent } from "../tldr_agent_diagnostics.mjs";
import {
  startControlledProcess,
  superviseControlledProcess,
} from "../tldr_agent_controlled_process.mjs";
import {
  derivedResumeId,
  evaluateExactResumeOutput,
  markExactResumeMessagePresented,
  resumeChildArgs,
} from "../tldr_agent_exact_resume.mjs";
import { renderReplyDeliveryPrompt } from "../../../hooks/templates/mid_session_inject.mjs";
import { resumeHandoffSchedule } from "./resume_handoff.mjs";

// When identity.json's `runtime` field is "unknown" (a SessionStart-hook bug
// observed 2026-05-17 on Sev-2 thread thr_email_98c83c2b79a0bc08), fall back
// to the session-id format. Claude Code emits UUIDv4 session ids (version
// digit '4' at the 15th char position); Codex emits UUIDv7 (version digit
// '7'). The conservative default if neither pattern matches is 'claude' —
// the historical behavior before this helper landed.
function inferRuntime(runtime, sessionId) {
  if (runtime === "claude" || runtime === "codex") return runtime;
  const sid = String(sessionId || "").toLowerCase();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/.test(sid)) return "codex";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/.test(sid)) return "claude";
  return "claude";
}

export { resumeChildArgs };

function renderResumePrompt({ inboundRow, tldrAgentCmd = "tldr-agent" }) {
  return renderReplyDeliveryPrompt({
    thread_id: inboundRow?.thread_id,
    body: inboundRow?.body,
    tldr_agent_cmd: tldrAgentCmd,
  });
}

export function resumeAgentSession({
  sessionId,
  runtime = "claude",
  cwd = null,
  inboundRow = null,
  scope = null,
  dryRun = false,
  replacement = null,
  signal = null,
  startProcessOverride = null,
  markReadMessage = null,
} = {}) {
  if (!sessionId || typeof sessionId !== "string") {
    return {
      ok: false,
      error: "invalid_session_id",
      hint: "sessionId must be a non-empty string.",
    };
  }

  const targetCwd =
    typeof cwd === "string" && isAbsolute(cwd)
      ? cwd
      : scope?.cwd && isAbsolute(scope.cwd)
        ? scope.cwd
        : process.cwd();

  const effectiveRuntime = inferRuntime(runtime, sessionId);
  const command = effectiveRuntime === "codex" ? "codex" : "claude";
  const resumeId = derivedResumeId(sessionId);

  // PRFAQ-0-7 B-T6.4 — dryRun:true short-circuit. Returns the per-runtime
  // child_args the dispatcher WOULD invoke without spawning the resume
  // schedule. Drives `check_resume_invoke_shape` (and gives a regression
  // signal for the past `--resume` vs `exec resume` inversion bug per
  // project_busy_queue_env_var_bug). No I/O, no activity-stream events.
  if (dryRun) {
    const childArgs = resumeChildArgs(effectiveRuntime, sessionId);
    return {
      ok: true,
      dry_run: true,
      runtime: effectiveRuntime,
      command,
      child_args: childArgs,
      resume_id: resumeId,
      cwd: targetCwd,
    };
  }

  const prompt = renderResumePrompt({ sessionId, inboundRow, cwd: targetCwd });
  const childArgs = resumeChildArgs(effectiveRuntime, sessionId);
  const handoff = resumeHandoffSchedule({
    sessionId,
    providerCommand: command,
    providerArgs: childArgs,
    replacement,
  });
  const handoffDescriptor = handoff?.descriptor || null;
  const processCommand = handoff ? process.execPath : command;
  const processArgs = handoff?.childArgs || childArgs;

  const startedAt = Date.now();
  appendActivityEvent({
    type: "comms_dispatcher_resume_attempt",
    level: "info",
    scope_id: scope?.scope_id ?? null,
    cwd: scope?.cwd ?? null,
    data: {
      resume_id: resumeId,
      runtime: effectiveRuntime,
      session_id: sessionId,
      message_id: inboundRow?.message_id || null,
      thread_id: inboundRow?.thread_id || null,
    },
  });
  const startProcess = startProcessOverride || startControlledProcess;
  let startPromise;
  try {
    startPromise = startProcess({
      command: processCommand,
      args: processArgs,
      cwd: targetCwd,
      stdinText: prompt,
      timeoutMs: 14_400_000,
      signal,
      terminalContext:
        scope && inboundRow?.message_id
          ? {
              scope,
              messageId: inboundRow.message_id,
              sessionId,
              resumeId,
              runtime: effectiveRuntime,
            }
          : null,
      onSpawn() {
        const presented = markExactResumeMessagePresented(
          {
            sessionId,
            messageId: inboundRow?.message_id || null,
          },
          markReadMessage ? { markReadMessage } : {},
        );
        if (!presented.ok && inboundRow?.message_id) {
          appendActivityEvent({
            type: "tldr_agent_reply_prompt_presented_failed",
            level: "warn",
            scope_id: scope?.scope_id ?? null,
            cwd: scope?.cwd ?? null,
            data: {
              session_id: sessionId,
              message_id: inboundRow.message_id,
              error: presented.error || "mark_presented_failed",
            },
          });
        }
      },
    });
  } catch (error) {
    startPromise = Promise.resolve({
      status: "failure",
      error: error?.message || String(error),
    });
  }
  return Promise.resolve(startPromise).then((started) => {
    if (started?.status !== "started") {
      appendActivityEvent({
        type: "comms_dispatcher_resume_outcome",
        level: "error",
        scope_id: scope?.scope_id ?? null,
        cwd: scope?.cwd ?? null,
        data: {
          resume_id: resumeId,
          status: "start_failed",
          duration_ms: Date.now() - startedAt,
        },
      });
      return {
        ok: false,
        error: "resume_start_failed",
        hint: started?.error || "The exact resume process did not start.",
        stdout: String(started?.stdout || "").slice(0, 2000),
        stderr: String(started?.stderr || "").slice(0, 2000),
        resume_id: resumeId,
      };
    }

    appendActivityEvent({
      type: "comms_dispatcher_resume_outcome",
      level: "info",
      scope_id: scope?.scope_id ?? null,
      cwd: scope?.cwd ?? null,
      data: {
        resume_id: resumeId,
        status: "started",
        pid: started.pid || null,
        duration_ms: Date.now() - startedAt,
      },
    });
    return {
      ok: true,
      process_started: true,
      resume_id: resumeId,
      pid: started.pid || null,
      pgid: started.pgid || null,
      runtime: effectiveRuntime,
      session_id: sessionId,
      cwd: targetCwd,
      child_args: childArgs,
      handoff_started: Boolean(handoffDescriptor),
      original_pid_replaced: false,
    };
  });
}

export const _internals = {
  derivedResumeId,
  renderResumePrompt,
  inferRuntime,
  evaluateExactResumeOutput,
  startControlledProcess,
  superviseControlledProcess,
};
