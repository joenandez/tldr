// Claim-time priority for delivery.claim auto-select (user priority lane, ac-jfv.74.1).
// Computed from existing rows on every claim; nothing is stored.
//
//   tier 0  a busy or resume-failure notice (metadata.notice): stands alone, no order dependency
//   tier 1  an agent reply that answers a user inbound nobody has answered yet
//   tier 2  everything else: briefs, reports, agent-started threads, agent-to-agent mail
//
// Tier 1 reuses the busy sweep's reply test (busy_line.mjs answeringReplySql), narrowed to the
// inbound's own conversation: an unthreaded `send --to user` is a proactive post, not an answer.
// It keeps the default delivery rule, committed (any state but failed), not the busy line's posted:
// a classification must not flip while an earlier answer is in flight, and a failed one frees the
// next reply to be tier 1. Thread order (the claim's promotion and guard) covers the in-flight case.

import { ANSWER_CONVERSATION_SQL, answeringReplySql } from "../busy_line.mjs";
import { RESERVED_NOTICES } from "./reserved_notice.mjs";

// The same values an agent commit may not write (reserved_notice.mjs).
export const TIER_NOTICES = new Set(RESERVED_NOTICES);
// Starvation guard inside tier 2: a row older than this sorts ahead of fresh tier 2 rows.
export const AGED_TIER2_MS = 15 * 60 * 1000;

// Candidates are route deliveries of an agent message that is not a notice. The reply is `cand`;
// `m` is the newest user inbound in its conversation at or before it, and no earlier real reply
// (notices never answer) has already answered `m`.
const TIER1_SQL = `
  SELECT d.id AS id
    FROM deliveries d
    JOIN messages cand ON cand.id = d.message_id
    JOIN channel_routes croute ON croute.id = d.channel_route_id
   WHERE d.id IN (SELECT value FROM json_each(?))
     AND cand.origin = 'agent' AND json_extract(cand.metadata, '$.notice') IS NULL
     AND EXISTS (
       SELECT 1 FROM messages m
         JOIN deliveries ad ON ad.message_id = m.id AND ad.channel_route_id IS NULL
         JOIN endpoints e ON e.id = ad.endpoint_id
        WHERE m.origin = 'inbound' AND m.origin_channel_route_id IS NOT NULL
          AND m.conversation_id = cand.conversation_id AND m.sender_principal_id = croute.principal_id
          AND m.created_at <= cand.created_at AND e.principal_id = cand.sender_principal_id
          AND NOT EXISTS (SELECT 1 FROM messages newer WHERE newer.conversation_id = m.conversation_id
                 AND newer.origin = 'inbound' AND newer.created_at > m.created_at AND newer.created_at <= cand.created_at)
          AND NOT EXISTS (
            ${answeringReplySql({ resumeFailedAnswers: false })}
              AND r.conversation_id = m.conversation_id AND r.id <> cand.id
              AND (r.created_at, r.id) < (cand.created_at, cand.id)))`;

/**
 * Tier of each candidate row ({ id, channel_route_id, notice, ... }) as a Map id -> 0|1|2.
 */
export function candidateTiers(db, candidates) {
  const tiers = new Map();
  const maybeReplies = [];
  for (const row of candidates) {
    if (TIER_NOTICES.has(row.notice)) tiers.set(row.id, 0);
    else if (row.channel_route_id && row.origin === "agent" && !row.notice)
      maybeReplies.push(row.id);
  }
  if (maybeReplies.length > 0) {
    for (const { id } of db
      .prepare(TIER1_SQL)
      .all(JSON.stringify(maybeReplies)))
      tiers.set(id, 1);
  }
  for (const row of candidates) if (!tiers.has(row.id)) tiers.set(row.id, 2);
  return tiers;
}

/**
 * Deliveries held right now (unexpired claim), with the route and conversation the thread guard
 * compares. A delivery waiting out a retry backoff holds nothing, so it is never in this list.
 * A tier 0 notice holds nothing either: it stands outside thread order (no promotion, no guard,
 * the Slack thread-lock bypass), so a notice whose `complete` timed out and keeps its claim until
 * the lease ends must not hold the newer answer behind it.
 */
export function heldRouteDeliveries(db, now) {
  return db
    .prepare(
      `SELECT d.channel_route_id AS route, m.conversation_id AS conversation, d.created_at AS created_at, d.id AS id
         FROM claims c
         JOIN deliveries d ON d.id = c.resource_id
         JOIN messages m ON m.id = d.message_id
        WHERE c.resource_type = 'delivery' AND c.state = 'claimed' AND c.lease_expires_at > ?
          AND d.channel_route_id IS NOT NULL AND d.state IN ('pending', 'claimed')
          AND COALESCE(json_extract(m.metadata, '$.notice'), '') NOT IN (SELECT value FROM json_each(?))`,
    )
    .all(now.toISOString(), JSON.stringify([...TIER_NOTICES]));
}

/** True when an older delivery on the same route and conversation is held (tier 1-2 only). */
export function behindHeldOlder(held, candidate) {
  return held.some(
    (h) =>
      h.route === candidate.channel_route_id &&
      h.conversation === candidate.conversation_id &&
      (h.created_at < candidate.created_at ||
        (h.created_at === candidate.created_at && h.id < candidate.id)),
  );
}

// --- Superseded notices ---------------------------------------------------------------------
// A busy notice says "it hasn't replied yet". Once the agent's real answer to the same message
// has been posted on the notice's route, that is no longer true, so the notice is settled
// `superseded` at claim time (the last daemon contact before the post) instead of being posted.
// `superseded` is terminal and means done without sending: nothing posts, nothing offers it again.
// A pending or merely claimed answer does not count: until it is posted the user has no reply.
// The answer test is the busy sweep's (resumeFailedAnswers): a posted resume_failed on the route
// answers a pending busy notice too, since the user already heard the failure.
// Only busy notices: a resume_failed notice reports a failure, which a later answer does not
// make false, so it stays tier 0 and posts.

// Candidate busy notices (by delivery id) whose source inbound has a real answer delivered on
// the notice's own route. The source is the `busy:<message_id>` key; `e` is the latest owner of
// the source message, as in the busy sweep.
const ANSWERED_NOTICES_SQL = `
  SELECT * FROM (
    SELECT d.id AS delivery_id, m.id AS source_message_id,
           (${answeringReplySql({ resumeFailedAnswers: true, select: "rd.id", deliveryState: "+rd.state = 'delivered'" })}
              AND rd.channel_route_id = d.channel_route_id
              AND ${ANSWER_CONVERSATION_SQL}
            ORDER BY rd.created_at, rd.id LIMIT 1) AS answer_delivery_id
      FROM deliveries d
      JOIN messages n ON n.id = d.message_id AND json_extract(n.metadata, '$.notice') = 'busy'
      JOIN messages m ON n.idempotency_key = 'busy:' || m.id AND m.app_id = n.app_id
                     AND m.origin = 'inbound' AND m.origin_channel_route_id IS NOT NULL
      JOIN deliveries ad ON ad.message_id = m.id AND ad.channel_route_id IS NULL
                        AND ad.rowid = (SELECT MAX(x.rowid) FROM deliveries x WHERE x.message_id = m.id AND x.channel_route_id IS NULL)
      JOIN endpoints e ON e.id = ad.endpoint_id
     WHERE d.id IN (SELECT value FROM json_each(?)) AND d.state IN ('pending', 'claimed')
  ) WHERE answer_delivery_id IS NOT NULL`;

/**
 * Settles every answered busy notice among the ranked tier 0 offers as `superseded` and returns
 * the offers without them. Runs inside the claim transaction. An unexpired claim is never a
 * candidate, so no live holder is cut off; a stale claim row is released so a late token from
 * an expired holder can neither complete nor release (and so revive) the delivery.
 */
export function settleAnsweredNotices(context, ranked, now) {
  const ids = ranked.filter((row) => row.tier === 0).map((row) => row.id);
  if (ids.length === 0) return ranked;
  const { db, logger } = context;
  const answered = db.prepare(ANSWERED_NOTICES_SQL).all(JSON.stringify(ids));
  const settled = new Set();
  for (const row of answered) {
    const timestamp = now.toISOString();
    const done = db
      .prepare(
        "UPDATE deliveries SET state = 'superseded', updated_at = ? WHERE id = ? AND state IN ('pending', 'claimed')",
      )
      .run(timestamp, row.delivery_id);
    if (done.changes !== 1) continue;
    db.prepare(
      "UPDATE claims SET state = 'released', outcome = 'superseded', released_at = ? WHERE resource_type = 'delivery' AND resource_id = ? AND state = 'claimed'",
    ).run(timestamp, row.delivery_id);
    settled.add(row.delivery_id);
    logger?.info?.({
      event: "delivery_claim.notice_superseded",
      params: {
        delivery_id: row.delivery_id,
        source_message_id: row.source_message_id,
        answer_delivery_id: row.answer_delivery_id,
      },
      result: "superseded",
      status: "ok",
    });
  }
  return ranked.filter((row) => !settled.has(row.id));
}
