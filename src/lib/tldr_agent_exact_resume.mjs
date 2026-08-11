import { markRead } from "./substrate/blocked_unread.mjs";

// Coffee-only direct process/output contract; retained Helm has no equivalent.

export function derivedResumeId(sessionId) {
  const basis =
    String(sessionId || "session")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "session";
  return `tldr-agent-resume-${basis}`;
}

export function resumeChildArgs(runtime, sessionId) {
  return runtime === "codex"
    ? [
        "exec",
        "--json",
        "resume",
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
        sessionId,
        "-",
      ]
    : [
        "--resume",
        sessionId,
        "--dangerously-skip-permissions",
        "-p",
        "--verbose",
        "--output-format",
        "stream-json",
      ];
}

export function evaluateExactResumeOutput(runtime, stdout, sessionId = null) {
  if (runtime !== "codex") return { ok: true, response_observed: true };
  const events = String(stdout || "")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  const started = events.find(
    (event) => event?.type === "thread.started" && event.thread_id,
  );
  const responseObserved = events.some(
    (event) =>
      event?.type === "item.completed" &&
      event?.item?.type === "agent_message" &&
      typeof event.item.text === "string" &&
      event.item.text.length > 0,
  );
  if (
    !started ||
    (sessionId && started.thread_id !== sessionId) ||
    !responseObserved ||
    !events.some((event) => event?.type === "turn.completed")
  ) {
    return { ok: false, error: "runtime_output_incomplete" };
  }
  return { ok: true, session_id: started.thread_id, response_observed: true };
}

export function markExactResumeMessagePresented(
  { sessionId, messageId } = {},
  { markReadMessage = markRead } = {},
) {
  if (!sessionId || !messageId) return { ok: false, error: "missing_required" };
  try {
    return markReadMessage({
      sessionId,
      messageId,
      via: "exact_resume_prompt",
    });
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}
