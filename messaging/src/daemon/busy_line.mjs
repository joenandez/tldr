// Busy line (never-wait Decision D): a holding notice for user messages that
// wait two minutes without a real reply.

import { withTransaction } from "./db.mjs";
import { stageOriginNotice } from "./lifecycle_transition.mjs";
import { isEndpointOwnerGone } from "./listener_owner_loss.mjs";
import { pushLiveDeliveryEvents } from "./ops/message_shared.mjs";

export const BUSY_LINE_START_AT = "2026-11-12T00:00:00Z"; // fixed at rollout; the sweep's floor after a restart
const BUSY_LINE_AFTER_MS = 2 * 60 * 1000;
// The wait counts from the provider's arrival (email polling can ingest ~20 s late), clamped so
// clock skew or a spoofed time never makes it later than ingestion or more than this much earlier.
const BUSY_LINE_ARRIVAL_CLAMP_MS = 60 * 1000;
// An unposted answer holds the line only this far past its due time (arrival + 122 s). After that
// the line is staged anyway: a failing answer must not push the line past the user's 2:15 budget
// (stage ~1 s after the bound, claim ~4 s, post ~2 s at load 120). The tier-0 claim still
// supersedes it if the answer posts first.
const BUSY_LINE_UNPOSTED_HOLD_MS = 2 * 1000;
const BUSY_LINE_BATCH = 50;
// A message whose line cannot be staged is retried (a route's app or endpoint may be briefly down),
// whatever the cause, until it has failed continuously this long; then it is abandoned.
export const BUSY_LINE_RETRY_MS = 10 * 60 * 1000;
// A line posted for a message older than this is noise: no sweep, after a restart or a recovered
// route, judges anything older, whatever the retry clock says.
export const BUSY_LINE_MAX_AGE_MS = 30 * 60 * 1000;
// The reply test, shared with the claim tier (ops/delivery_priority.mjs) so "answered" has one
// definition. Binds `m` (the user inbound) and `e` (its addressed agent endpoint); yields `r`, a
// reply. A resume-failure notice is untagged-equivalent for the busy line: the user already heard it.
// `deliveryState` says which route-delivery states of the reply count: the default is every state
// but failed (committed to go out; the tier classification), the busy line asks for posted
// (`delivered`) or unposted (`pending`, `claimed`). Those pass `+rd.state`: the unary plus keeps the
// planner from driving the join out of a state index (a table scan); it must start from the reply `r`.
export function answeringReplySql({
  resumeFailedAnswers,
  select = "1",
  deliveryState = "rd.state <> 'failed'",
}) {
  const noticeOk = resumeFailedAnswers
    ? "COALESCE(json_extract(r.metadata, '$.notice'), 'resume_failed') = 'resume_failed'"
    : "json_extract(r.metadata, '$.notice') IS NULL";
  return `SELECT ${select} FROM messages r
       JOIN deliveries rd ON rd.message_id = r.id AND ${deliveryState}
       JOIN channel_routes cr ON cr.id = rd.channel_route_id AND cr.principal_id = m.sender_principal_id
      WHERE r.origin = 'agent' AND r.created_at >= m.created_at
        AND r.sender_principal_id = e.principal_id AND ${noticeOk}`;
}
// Which conversations a reply `r` answers `m` from (see below); shared with the claim's supersede check.
export const ANSWER_CONVERSATION_SQL = `(r.conversation_id = m.conversation_id
             OR NOT EXISTS (SELECT 1 FROM messages i WHERE i.conversation_id = r.conversation_id AND i.origin = 'inbound' AND i.created_at < r.created_at))`;
// A real reply to user message M is a later non-notice, non-failed agent message from M's
// agent principal on one of the user's channel routes that either answers M's conversation or
// sits in a conversation the agent started itself (an unthreaded `send --to user` opens a new one
// with no inbound message before the reply; a later user answer there must not undo it). A threaded reply in another inbound conversation answers that one.
// `received`: an agent session already has M (every receipt path sets read_at: a push into the run,
// a hook showing it, `agent receive`, an ack), so the line must not imply M waits to be seen.
// Only a POSTED reply (route delivery `delivered`) answers M. A reply whose route delivery is still
// pending or claimed is `unposted`: M is deferred, not staged and not closed, and the sweep's mark
// holds at it, because that delivery can still fail and then the user would have neither answer nor
// line. The hold is bounded (BUSY_LINE_UNPOSTED_HOLD_MS past the due time): after it the line is
// staged though the answer is unposted. It is also staged once every reply delivery has failed
// terminally (inside the max age), and closed once one posts.
// The reply tests are in HAVING (posted) and the select list (unposted) so `e` is the latest owner.
export const BUSY_LINE_CANDIDATES_SQL = `
  SELECT m.id, m.created_at, json_extract(m.metadata, '$.provider_metadata.provider_received_at') AS provider_received_at,
         e.id AS endpoint_id, e.academy_agent_name, e.state AS endpoint_state, e.owner_process_exited_at, e.launch_mode, MAX(d.rowid) AS latest_delivery,
         EXISTS (SELECT 1 FROM deliveries rcv WHERE rcv.message_id = m.id AND rcv.channel_route_id IS NULL
                    AND rcv.state <> 'failed' AND rcv.read_at IS NOT NULL) AS received,
         EXISTS (SELECT 1 FROM resume_requests rr WHERE rr.message_id = m.id AND rr.endpoint_id = e.id
                    AND rr.state IN ('pending', 'claimed')) AS resuming,
         EXISTS (
           ${answeringReplySql({ resumeFailedAnswers: true, deliveryState: "+rd.state IN ('pending', 'claimed')" })}
              AND ${ANSWER_CONVERSATION_SQL}) AS unposted
    FROM messages m
    JOIN deliveries d ON d.message_id = m.id AND d.channel_route_id IS NULL
    JOIN endpoints e ON e.id = d.endpoint_id
   WHERE m.origin = 'inbound' AND m.origin_channel_route_id IS NOT NULL
     AND m.created_at >= :mark AND m.created_at <= :cutoff
     AND (m.created_at, m.id) > (:afterAt, :afterId)
     AND NOT EXISTS (SELECT 1 FROM messages n WHERE n.app_id = m.app_id AND n.idempotency_key = 'busy:' || m.id)
   GROUP BY m.created_at, m.id
   HAVING NOT EXISTS (
     ${answeringReplySql({ resumeFailedAnswers: true, deliveryState: "+rd.state = 'delivered'" })}
        AND ${ANSWER_CONVERSATION_SQL})
   ORDER BY m.created_at, m.id
   LIMIT :limit`; // MAX(d.rowid) makes SQLite take e.* from the latest agent delivery (current owner); grouping by (created_at, id) lets the range index serve GROUP BY and ORDER BY
// The newest user message this sweep has judged; every older one past the mark is settled or failed.
const BUSY_LINE_JUDGED_SQL = `
  SELECT MAX(created_at) AS at FROM messages
   WHERE origin = 'inbound' AND origin_channel_route_id IS NOT NULL
     AND created_at >= :mark AND created_at <= :cutoff`;

/**
 * Stages one busy line per post-rollout user message that is at least two
 * minutes old and has no real reply yet. The `busy:<message_id>` key and the
 * already-noticed filter make repeat sweeps and restarts no-ops. Each sweep
 * reads only from `context.busyLineWatermark`, the oldest message it may
 * still owe a line; a restart forgets it, and no sweep reads older than BUSY_LINE_MAX_AGE_MS.
 */
export function runBusyLineSweep(context, { now = Date.now() } = {}) {
  const select = context.db.prepare(BUSY_LINE_CANDIDATES_SQL);
  const floor = new Date(now - BUSY_LINE_MAX_AGE_MS).toISOString();
  const watermark = context.busyLineWatermark ?? BUSY_LINE_START_AT;
  const params = {
    mark:
      new Date(watermark) > new Date(floor)
        ? new Date(watermark).toISOString()
        : floor,
    // Widened by the clamp so the range index still serves the query; `arrivalLag` filters on due time.
    cutoff: new Date(
      now - BUSY_LINE_AFTER_MS + BUSY_LINE_ARRIVAL_CLAMP_MS,
    ).toISOString(),
    limit: BUSY_LINE_BATCH,
  };
  forgetAgedAbandoned(context, params.mark);
  const tally = { staged: 0, failures: [], now };
  let cursor = { afterAt: "", afterId: "" };
  let batch;
  do {
    batch = select.all({ ...params, ...cursor });
    for (const row of batch) judgeBusyLine(context, row, tally);
    const last = batch.at(-1);
    cursor = { afterAt: last?.created_at, afterId: last?.id };
  } while (batch.length === BUSY_LINE_BATCH);
  context.busyLineWatermark = nextWatermark(context.db, params, tally);
  forgetSettledFailures(context, tally);
  logSweepFailures(context, tally);
  return { staged: tally.staged, failed: tally.failures.length };
}

// Stages the row's line once it is due; a seen-but-not-due row, or one whose answer is unposted
// and inside the hold bound, holds the mark at or before it so a later sweep still judges it.
function judgeBusyLine(context, row, tally) {
  if (context.busyLineAbandoned?.has(row.id)) return;
  const dueAt =
    Date.parse(row.created_at) - arrivalLag(row) + BUSY_LINE_AFTER_MS;
  if (
    dueAt > tally.now ||
    (row.unposted && dueAt + BUSY_LINE_UNPOSTED_HOLD_MS > tally.now)
  )
    tally.firstDeferred ??= row.created_at;
  else stageBusyLine(context, row, tally);
}

// Ms the provider's arrival precedes ingestion: provider_received_at clamped to
// [created_at - 60 s, created_at]; 0 when absent or unparseable.
function arrivalLag({ created_at: createdAt, provider_received_at: received }) {
  const arrived = typeof received === "string" ? Date.parse(received) : NaN;
  if (Number.isNaN(arrived)) return 0;
  return Math.min(
    BUSY_LINE_ARRIVAL_CLAMP_MS,
    Math.max(0, Date.parse(createdAt) - arrived),
  );
}

// Settled is permanent (a `busy:` row or a later reply), so the mark may pass
// every judged message except a failed one, which holds it for the retry, and
// one not yet due, which the next sweep must still see.
function nextWatermark(db, { mark, cutoff }, { failures, firstDeferred }) {
  const newestJudged =
    db.prepare(BUSY_LINE_JUDGED_SQL).get({ mark, cutoff }).at ?? mark;
  return [failures[0]?.created_at, firstDeferred]
    .filter(Boolean)
    .reduce((low, held) => (held < low ? held : low), newestJudged);
}

// Worded by delivery state at staging time; read by the user only (Slack and others key on metadata.notice).
function busyLineText(row) {
  const agent = row.academy_agent_name || "The agent";
  if (
    !row.received &&
    isEndpointOwnerGone({ ...row, state: row.endpoint_state })
  )
    return row.resuming
      ? `${agent} had stopped. It is restarting to read your message.`
      : `${agent} had stopped and has not read your message yet.`;
  return row.received
    ? `${agent} has your message and is working on it. It hasn't replied yet.`
    : `${agent} is busy and will reply when its current task is finished.`;
}

function stageBusyLine(context, row, tally) {
  const { db, logger } = context;
  const lagMs = arrivalLag(row);
  try {
    const notice = withTransaction(db, () =>
      stageOriginNotice(db, {
        messageId: row.id,
        endpointId: row.endpoint_id,
        key: `busy:${row.id}`,
        notice: "busy",
        logger,
        body: busyLineText(row),
        logExtra: lagMs ? { arrival_lag_ms: lagMs } : undefined,
      }),
    );
    if (notice?.liveDeliveries?.length)
      pushLiveDeliveryEvents(context, {
        conversationId: notice.conversation_id,
        liveDeliveries: notice.liveDeliveries,
      });
    if (notice && !notice.idempotent_replay) tally.staged += 1;
    context.busyLineFailing?.delete(row.id);
  } catch (error) {
    const failing = (context.busyLineFailing ??= new Map());
    const entry = failing.get(row.id) ?? { since: tally.now, attempts: 0 };
    entry.attempts += 1;
    failing.set(row.id, entry);
    if (tally.now - entry.since >= BUSY_LINE_RETRY_MS)
      abandonBusyLine(context, row, error);
    else
      tally.failures.push({
        message_id: row.id,
        created_at: row.created_at,
        error,
      }); // retried next sweep; the cursor keeps it from blocking newer rows
  }
}

// An abandoned message older than the mark can never be a candidate again.
function forgetAgedAbandoned({ busyLineAbandoned }, mark) {
  for (const [id, createdAt] of busyLineAbandoned ?? [])
    if (createdAt < mark) busyLineAbandoned.delete(id);
}

// Logged once, then skipped and no longer holds the watermark; a restart judges it once more.
function abandonBusyLine(context, row, error) {
  const { attempts } = context.busyLineFailing.get(row.id);
  (context.busyLineAbandoned ??= new Map()).set(row.id, row.created_at);
  context.busyLineFailing.delete(row.id);
  context.logger?.warn?.({
    event: "busy_line.abandoned",
    params: { message_id: row.id },
    result: { code: error.code, attempts },
    message: error.message,
  });
}

// A message that stopped failing without a success here (a real reply settled it) is forgotten.
function forgetSettledFailures({ busyLineFailing }, { failures }) {
  const held = new Set(failures.map((f) => f.message_id));
  for (const id of busyLineFailing?.keys() ?? [])
    if (!held.has(id)) busyLineFailing.delete(id);
}

// Warns when a message not already reported starts failing, not on every 10 s sweep of the window.
function logSweepFailures(context, { staged, failures }) {
  const reported = context.busyLineReported ?? new Set();
  context.busyLineReported = new Set(failures.map((f) => f.message_id));
  const fresh = failures.find((f) => !reported.has(f.message_id));
  if (!fresh) return;
  const { message_id: messageId, error } = fresh;
  context.logger?.warn?.({
    event: "busy_line.sweep_failed",
    params: { first_message_id: messageId },
    result: { failed: failures.length, staged, code: error.code },
    message: error.message,
    stack: error.stack,
  });
}
