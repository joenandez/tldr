// The one terminal notice a requester gets when the holder of its request
// stopped for good (ac-4p2j0). Staged inside the custody decision's
// transaction (custody_reconciler.mjs), published after commit.

import { requestContext } from "./held_request.mjs";
import { noticeRequester, publish } from "./scheduled_wake_pass.mjs";
import { cancelWakesForAttempt } from "./scheduled_wakes.mjs";

export const failedKey = (attemptId) => `holder-failed:${attemptId}`;

// One notice per request: true when the requester of root `rootExpr` was
// already told it failed, on any attempt: a holder-failed notice, or a
// daemon resume-failure notice (ac-jfv.165 usage limit, gone folder, or a
// terminal resume notice) that replies to this request's own opening, about
// relaunching a holder of it or a replacement admitted for one (r19 F1: it
// may fail before it adopts the request). A notice about another trigger
// counts only when the trigger is an ordinary message (no effect: the
// requester's follow-up, r22 F2), the nearest message up its reply thread
// that carries an obligation effect belongs to THIS root (the root, or an
// attempt under it: r24 F2, so a follow-up about a sibling request in the
// same conversation never tells this one), and the daemon delivered the
// notice to the opening's sender endpoint or a lineage replacement. A
// follow-up whose thread names no request counts for none: the worst case is
// a second notice, never silence. A notice keyed by its trigger message counts only for a holder
// of this root: its own effect row must record that holder as the one it is about (r30). Any other effect (another request's
// opening, an offer, an update) answers its own request and never counts
// (r17/r18/r20 F1), and a notice with no delivery to the requester does not
// count. A replacement or a recovery can
// re-admit a told request and stop again; that is not a second notice.
// A client cannot forge either: message.commit refuses both key prefixes
// and the holder_failed notice type, a holder-failed marker counts only in the
// request's conversation with that daemon type (r21 F3),
// (reserved_notice.mjs), and a resume-failure counts only with daemon notice
// evidence (metadata.notice "resume_failed", which commit also refuses, or a
// daemon effect notice), so a key committed before the prefix was reserved
// does not count. Every lookup seeks an index.
export const ROOT_TOLD_SQL = (rootExpr) => `(EXISTS (
    SELECT 1 FROM obligations told_attempt
      JOIN messages told ON told.app_id IN (SELECT id FROM applications) AND told.idempotency_key = 'holder-failed:' || told_attempt.id
     WHERE told_attempt.parent_id = ${rootExpr} AND told_attempt.role = 'attempt'
       AND told.conversation_id = told_attempt.conversation_id
       AND json_extract(told.metadata, '$.notice') = 'holder_failed')
  OR EXISTS (
    SELECT 1 FROM messages told
      JOIN resume_requests told_request ON told_request.id = substr(told.idempotency_key, 16)
        OR (told_request.message_id = substr(told.idempotency_key, 16)
            AND EXISTS (SELECT 1 FROM message_effects told_about WHERE told_about.message_id = told.id
                AND json_extract(told_about.effect_payload, '$.declaration.sender_endpoint_id') = told_request.endpoint_id))
     WHERE told.conversation_id = (SELECT told_root.conversation_id FROM obligations told_root WHERE told_root.id = ${rootExpr})
       AND told.idempotency_key LIKE 'resume-failure:%'
       AND told.app_id IN (SELECT id FROM applications)
       AND told_request.endpoint_id IN (WITH RECURSIVE told_holders(id) AS (
             SELECT told_holder.custodian_endpoint_id FROM obligations told_holder
              WHERE told_holder.parent_id = ${rootExpr} AND told_holder.role = 'attempt'
             UNION
             SELECT told_admitted.replacement_endpoint_id FROM resume_requests told_admitted
               JOIN told_holders ON told_admitted.endpoint_id = told_holders.id
              WHERE told_admitted.replacement_endpoint_id IS NOT NULL)
           SELECT id FROM told_holders)
       AND (EXISTS (SELECT 1 FROM message_effects told_opening WHERE told_opening.message_id = told_request.message_id
                AND told_opening.obligation_id = ${rootExpr} AND told_opening.effect = 'open')
         OR (NOT EXISTS (SELECT 1 FROM message_effects told_other WHERE told_other.message_id = told_request.message_id AND told_other.effect != 'none')
             AND ${rootExpr} IN (SELECT COALESCE(told_node.parent_id, told_node.id) FROM obligations told_node WHERE told_node.id = (
                   WITH RECURSIVE told_thread(id, depth) AS (
                     SELECT told_request.message_id, 0
                     UNION ALL
                     SELECT told_up.in_reply_to_message_id, told_thread.depth + 1 FROM told_thread
                       JOIN messages told_up ON told_up.id = told_thread.id
                      WHERE told_up.in_reply_to_message_id IS NOT NULL)
                   SELECT told_near.obligation_id FROM told_thread JOIN message_effects told_near ON told_near.message_id = told_thread.id
                    WHERE told_near.obligation_id IS NOT NULL ORDER BY told_thread.depth LIMIT 1))
             AND EXISTS (SELECT 1 FROM deliveries told_sent WHERE told_sent.message_id = told.id AND told_sent.state != 'failed'
                AND told_sent.endpoint_id IN (WITH RECURSIVE told_requesters(id) AS (
                      SELECT json_extract(told_asked.effect_payload, '$.declaration.sender_endpoint_id') FROM message_effects told_asked
                       WHERE told_asked.obligation_id = ${rootExpr} AND told_asked.effect = 'open'
                      UNION
                      SELECT told_moved.replacement_endpoint_id FROM resume_requests told_moved
                        JOIN told_requesters ON told_moved.endpoint_id = told_requesters.id
                       WHERE told_moved.replacement_endpoint_id IS NOT NULL)
                    SELECT id FROM told_requesters))))
       AND (json_extract(told.metadata, '$.notice') = 'resume_failed'
         OR EXISTS (SELECT 1 FROM message_effects told_fx WHERE told_fx.message_id = told.id AND json_extract(told_fx.effect_payload, '$.notice') IS NOT NULL))))`;

export const MAX_HOLDER_RETRIES = 3;
export const retryKey = (nodeId, n) => `holder-retry:${nodeId}:${n}`;

// The cut-off notes a node's holder got (holder_death.mjs), oldest first: the
// bounded exact keys, so the lookup seeks the (app_id, idempotency_key) index.
export const notesFor = (db, nodeId) => {
  const keys = Array.from({ length: MAX_HOLDER_RETRIES }, (_, i) =>
    retryKey(nodeId, i + 1),
  );
  return db
    .prepare(
      `SELECT id, rowid AS seq FROM messages
        WHERE app_id IN (SELECT id FROM applications) AND idempotency_key IN (SELECT value FROM json_each(?))
        ORDER BY rowid`,
    )
    .all(JSON.stringify(keys));
};

const CAUSES = {
  supervised_exit: "its session crashed or was killed",
  usage_limit_expired:
    "its provider usage limit stopped it and named no reset within 24 hours",
  owner_exit: "its session crashed or was killed",
  lease_expired: "tldr could not get its session to start",
  spawn_error: "tldr could not launch its session",
  endpoint_state_dead: "its session was marked dead",
  holder_stalled: "its session stopped and nothing could resume it",
  exact_session_unavailable:
    "its session was lost and no replacement could take over",
  dead_holder_abandoned:
    "its session ended before it read your request, so the request was abandoned, not delivered late",
};
// Causes whose own words say what was tried: no cut-off note story.
const UNTRIED = new Set(["usage_limit_expired", "dead_holder_abandoned"]);

// How long ago the request was opened, so a requester can skip stale work.
function openedAgo(root, now) {
  const hours = Math.floor((now - Date.parse(root.created_at)) / 3_600_000);
  if (hours < 1) return "less than an hour ago";
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

function holderName(db, endpointId) {
  const e = db
    .prepare(
      "SELECT academy_agent_name, provider_session_id FROM endpoints WHERE id = ?",
    )
    .get(endpointId);
  const session = e?.provider_session_id
    ? `session ${e.provider_session_id}`
    : `endpoint ${endpointId}`;
  return e?.academy_agent_name
    ? `${e.academy_agent_name} (${session})`
    : session;
}

const times = (n) => (n === 1 ? "once" : `${n} times`);

// What was tried, from what happened: a cut-off note the holder took is a
// resume that ran; one it never took is a resume that never started.
function triedText(db, attempt) {
  const notes = notesFor(db, attempt.id).map((note) => note.id);
  const { ran } = db
    .prepare(
      "SELECT count(*) AS ran FROM deliveries WHERE endpoint_id = ? AND read_at IS NOT NULL AND message_id IN (SELECT value FROM json_each(?))",
    )
    .get(attempt.custodian_endpoint_id, JSON.stringify(notes));
  const resumed = ran
    ? ` tldr resumed it ${times(ran)} and it stopped again.`
    : "";
  const neverStarted =
    notes.length > ran
      ? ` tldr tried to resume it${ran ? " again" : ""}, but the session never started.`
      : "";
  return notes.length
    ? resumed + neverStarted
    : " tldr could not relaunch its session.";
}

// A lost session for which a replacement was admitted. Admission makes a
// sessionless endpoint; it ran once it has a session or an owner process.
// Undefined: no replacement was admitted.
const replacementOf = (db, endpointId) =>
  db
    .prepare(
      `SELECT max(e.provider_session_id IS NOT NULL OR e.owner_process_pid IS NOT NULL) AS ran
         FROM resume_requests r JOIN endpoints e ON e.id = r.replacement_endpoint_id
        WHERE r.endpoint_id = ? HAVING count(*) > 0`,
    )
    .get(endpointId);

const REPLACEMENT_CAUSE = {
  1: "its session was lost, and the replacement session started for it stopped without finishing",
  0: "its session was lost, and the replacement session set up for it never started",
};

function failedText(db, attempt, rootId) {
  const kind = String(attempt.resolution_source ?? "").split(":")[0];
  const replacement =
    kind === "exact_session_unavailable"
      ? replacementOf(db, attempt.custodian_endpoint_id)
      : undefined;
  const cause = replacement
    ? REPLACEMENT_CAUSE[replacement.ran]
    : (CAUSES[kind] ?? "its session ended");
  return `The agent holding your request ${rootId} stopped without finishing: ${holderName(db, attempt.custodian_endpoint_id)}; ${cause}.${UNTRIED.has(kind) ? "" : triedText(db, attempt)} Your request is still open: send it again, hand it to another session, or close it.`;
}

// A closed attempt whose request stays open with no other attempt, and
// whether that request was already told; null otherwise.
function untoldFailure(db, id) {
  const attempt = db.prepare("SELECT * FROM obligations WHERE id = ?").get(id);
  const work =
    attempt?.role === "attempt" && attempt.status === "closed"
      ? requestContext(db, attempt)
      : null;
  if (work?.root.status !== "open") return null;
  const state = db
    .prepare(
      `WITH told_for(id) AS (SELECT ?)
       SELECT EXISTS (SELECT 1 FROM obligations WHERE parent_id = (SELECT id FROM told_for) AND role = 'attempt' AND status = 'open') AS sibling,
              ${ROOT_TOLD_SQL("(SELECT id FROM told_for)")} AS told`,
    )
    .get(attempt.parent_id);
  return state.sibling ? null : { attempt, work, told: Boolean(state.told) };
}

/**
 * Inside the custody decision's transaction: one notice to the requester of
 * each attempt it `closed` that no parent wake covered (`routed`). `enabled`
 * is false for a caller that admits a replacement session right after
 * (exact_session_unavailable): that request is not finished failing.
 * Returns the sends to publish after commit.
 */
export function stageFailedAttemptNotices(
  context,
  { closed, routed, enabled, now },
) {
  if (!enabled) return [];
  const { db } = context;
  const sends = [];
  for (const id of closed.filter((nodeId) => !routed.has(nodeId))) {
    const failure = untoldFailure(db, id);
    if (!failure) continue;
    const { attempt, work, told } = failure;
    const abandoned = attempt.resolution_reason === "dead_holder_abandoned";
    // The requester is told now (or was already); a 1 h re-wake would contradict it.
    cancelWakesForAttempt(db, id, now.toISOString());
    if (told) {
      sends.push({ attemptId: id, to: "already_told" });
      continue;
    }
    const notice = noticeRequester(
      context,
      { endpoint_id: attempt.custodian_endpoint_id, attempt_id: id },
      {
        ...work,
        notice: {
          key: failedKey(id),
          type: "holder_failed",
          text: abandoned
            ? `${failedText(db, attempt, work.root.id)} It was opened ${openedAgo(work.root, now)}.`
            : failedText(db, attempt, work.root.id),
          // ac-3d5.95 x jfv.161: an FYI about abandoned work starts no session.
          closedWork: abandoned,
        },
      },
    );
    sends.push({
      attemptId: id,
      to: notice.to,
      conversationId: work.root.conversation_id,
      sent: notice.sent,
    });
  }
  return sends;
}

export function publishFailedAttemptNotices(context, sends) {
  for (const send of sends) {
    if (send.sent) publish(context, send.conversationId, send.sent);
    context.logger?.info?.({
      event: "holder_failed_requester_notice",
      params: { attempt_id: send.attemptId },
      result: { notice_to: send.to },
      status:
        send.to === "none" || send.to === "user_unavailable"
          ? "undeliverable"
          : "ok",
    });
  }
}
