export const ARIADNE_BLOCK_CAP = 3;

function relativeTime(sentAt, now) {
  const elapsedMs = Math.max(0, now.getTime() - Date.parse(sentAt || ""));
  if (!Number.isFinite(elapsedMs)) return "unknown time";
  const minutes = Math.max(1, Math.floor(elapsedMs / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

function noticePreview(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/"/g, '\\"')
    .slice(0, 120);
}

function pendingIds(pending) {
  return [...pending]
    .map((item) => item.thread_id)
    .sort((a, b) => a.localeCompare(b));
}

export function renderAriadneStopNotice({
  kind,
  pending = [],
  blockCount = 0,
  now = new Date(),
} = {}) {
  const sorted = [...pending].sort((a, b) =>
    a.thread_id.localeCompare(b.thread_id),
  );
  const ids = pendingIds(sorted);
  if (kind === "warn") {
    return `[ariadne-followup] Heads-up: ${sorted.length} thread(s) await a follow-up decision: ${ids.join(", ")}.
Allowing stop (Tachyon-eligible session). Reply on the thread or
dismiss with: helm-tasks thread followup dismiss --thread <id> --reason "<why>"`;
  }
  if (kind === "force-allow") {
    return `[ariadne-followup] Follow-up still unresolved after 3 blocked stop attempts on: ${ids.join(", ")}.
Allowing stop so you are not wedged. An ariadne_followup_unfulfilled error event has been
recorded. Close the loop as soon as you can.`;
  }
  const rows = sorted
    .map(
      (item) =>
        `  • ${item.thread_id} — your last message (${relativeTime(item.sent_at, now)} ago): "${noticePreview(item.body_preview)}"`,
    )
    .join("\n");
  const dismissRows = ids
    .map(
      (threadId) =>
        `  3. Nothing owed?      helm-tasks thread followup dismiss --thread ${threadId} --reason "<why>"`,
    )
    .join("\n");
  return `[ariadne-followup] Cannot stop: ${sorted.length} thread(s) still owe the human a follow-up (block ${blockCount}/${ARIADNE_BLOCK_CAP}).

${rows}

This session cannot wait live for replies. A reply on the thread is the only way
the user learns the outcome. For EACH thread above, do one of:

  1. Done (or failed)?  Send the follow-up reply now — report failures too, never go silent.
  2. Still working?     Send a brief status update on the thread; it counts as your follow-up
                        for this stop.
${dismissRows}

Then stop again. Dismissals are logged and audited against your last message above.`;
}

export function ariadnePendingIds(pending) {
  return pendingIds(pending);
}
