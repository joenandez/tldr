// The notes tldr sends a holder whose process stopped under open work
// (ac-4p2j0): the cut-off retry (holder_death.mjs, one of MAX_HOLDER_RETRIES
// slots) and the free "recheck" for an exit whose cause is unknown.
import { limitKey } from "./limit_note.mjs";
import { MAX_HOLDER_RETRIES, retryKey } from "./holder_failed_notice.mjs";
import { deliverWake } from "./scheduled_wake_pass.mjs";

const retryBody = (rootId) =>
  `You were cut off mid-work: your session ended before it finished request ${rootId}, which you still hold. tldr resumed you to continue it. Pick up where you stopped: answer, or say what you're doing and when you'll report back; \`reply\` keeps the request open; only \`complete\` closes it; \`delegate --at\` parks it.`;

// A daemon-launched owner found gone by the owner pass with no supervised child to classify it (it outlived
// a daemon restart): its exit may have been a usage limit, which only a launch THIS daemon supervises can tell
// (limit_note.mjs). So no death is decided: the holder is relaunched on a note outside the retry cap, in the
// limit family (its read starts the progress clock like a limit note's, and the catch-all sees it as work in
// flight). The relaunch is tracked, and the handoff is spent once per ROOT, read from the durable note
// itself (recheckSpent), so a daemon crash loop cannot hand out more: the next untracked exit of that root
// is decided like any death (a retry slot, or exhausted: the one notice).
export const recheckKey = (nodeId, generation) =>
  limitKey(nodeId, `owner-exit:${generation}`);

// Inside the decision's transaction: the cut-off note, numbered `n` (a retry slot) or keyed `key` (a recheck).
// A fired wake's silence check waits while it is pending (scheduled_wakes.mjs dueRewakes).
export function sendRetry(context, node, { endpointId, work, n, key }) {
  const sent = deliverWake(
    context,
    { endpoint_id: endpointId, attempt_id: node.id },
    {
      ...work,
      note: {
        key: key ?? retryKey(node.id, n),
        body: retryBody(work.root.id),
        notice: "holder_retry",
      },
    },
  );
  return { conversationId: work.root.conversation_id, sent };
}

// Whether this root already had its one free handoff: a recheck note in its conversation.
const recheckSpent = (db, work) =>
  Boolean(
    db
      .prepare(
        "SELECT 1 FROM messages WHERE conversation_id = ? AND idempotency_key LIKE 'holder-limit:%:owner-exit:%' LIMIT 1",
      )
      .get(work.root.conversation_id),
  );

// The free recheck for an exit nothing supervised classified (`generation` non-null), or null: the
// ordinary outcome stands. It replaces an exhaustion and the last slot, once per root, if a launch is possible.
export function recheckFor(db, node, { work, canLaunch, retry, generation }) {
  if (generation === null || !work || !canLaunch) return null;
  if (retry?.n < MAX_HOLDER_RETRIES || recheckSpent(db, work)) return null;
  return { work, key: recheckKey(node.id, generation) };
}
