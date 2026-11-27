// The replacement SessionStart's recovery text (moved out of hook_commands.mjs, ac-kf9rt, to keep that file under its size baseline).
import { shortId } from "../protocol/ids.mjs";

/**
 * A replacement SessionStart receives canonical recovery state before the
 * ordinary outbound catalog.  Lineage IDs and provider-session identities
 * deliberately stay out of the model prompt: they are operator evidence,
 * not instructions or reply authority.
 */
export function renderRecoveryContext(context, adoptionLines = []) {
  const participantNames = (context.participants ?? [])
    .map((participant) => participant.display_name ?? "Unnamed participant")
    .join(", ");
  const messages = (context.messages ?? [])
    .map((message) => `[${message.created_at}] ${String(message.body ?? "")}`)
    .join("\n");
  const root = context.root ?? {};
  return [
    "<tightbeam_recovery_context>",
    "You are the freshly started replacement session for this existing work. Continue from canonical context; do not recreate or infer a sibling transcript.",
    `Subject: ${context.subject ?? "(subject unavailable)"}`,
    `Participants: ${participantNames}`,
    `Root: ${root.root_obligation_id ?? "unavailable"}`,
    `Root generation: ${root.generation ?? "unavailable"}`,
    `Custody state: ${root.status ?? "unavailable"}`,
    `Unread message ids: ${(context.unread?.message_ids ?? []).join(", ") || "none"}`,
    "Relevant messages:",
    messages,
    "This is recovery context, not an acknowledgement request: no acknowledgement ceremony is required before ordinary action. An unanswered user message still needs a first reply; a refused tool call names it.",
    ...adoptionLines,
    "</tightbeam_recovery_context>",
  ].join("\n");
}

/**
 * S10 (ux.md §9): the threads this replacement adopted through lineage and
 * each predecessor that could not be resumed. Plain text, no bodies.
 */
export function renderAdoptionLines(threads) {
  const adopted = (threads ?? []).filter(
    (thread) => (thread.adopted_from ?? []).length > 0,
  );
  if (adopted.length === 0) return [];
  const previous = new Map();
  for (const thread of adopted) {
    for (const from of thread.adopted_from) {
      if (previous.has(from.endpoint_id)) continue;
      const runtime =
        from.runtime ??
        (thread.participants ?? []).find(
          (participant) => participant.endpoint_id === from.endpoint_id,
        )?.runtime ??
        "session";
      previous.set(
        from.endpoint_id,
        `Previous session: ${runtime} ${shortId(from.provider_session_id ?? from.endpoint_id)} could not be resumed.`,
      );
    }
  }
  const listed = adopted
    .map((thread) =>
      [shortId(thread.conversation_id), thread.subject]
        .filter(Boolean)
        .join(" "),
    )
    .join(", ");
  return [`Adopted threads: ${listed}`, ...previous.values()];
}
