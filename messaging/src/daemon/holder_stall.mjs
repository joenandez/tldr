// The guarantee behind the death-time decision (ac-4p2j0, holder_death.mjs):
// an open request whose holder stopped moving, with nothing coming to move
// it, ends with the one notice, whatever path left it there. Two shapes:
// - open leaf work (attempt/delegation) whose holder stopped: exit evidence
//   (owner exit stamp, or dead), not busy, nothing changed for
//   STALL_GRACE_MS. It closes through the custody reconciler.
// - an open root with no open attempt, its newest attempt closed failed and
//   untold (custody already lost with the notice held back, e.g. for a
//   replacement that never took over). It gets the reconciler's notice.
// Coming: a claimed launch (backoff and usage-limit holds keep their claim),
// a pending launch the resumer will select (its own candidate rule,
// resume_candidate.mjs; a sessionless placeholder qualifies), on the holder
// or on an admitted replacement, a replacement awaiting admission, an
// unfired wake, an open child. A pending launch it will never select is not
// coming. The 2 h grace, from the newest change on any row of the lineage,
// outlasts ALIVE_PROGRESS_MS, so an observed death is always decided by the
// fast path; the catch-all is only a slow backstop for missed paths, and the
// wide margin keeps it clear of any launch still being queued (r17 F2).
// Work that went quiet before the install watermark is backlog: it is left
// as it is, never noticed one by one (performance_indexes.mjs). Quiet is
// judged by the work's own rows and the cut-off notes sent to it, never
// endpoint metadata: a death after the install is decided by the fast path
// whatever the work's age, and a retry it sent makes the work eligible.

import { withTransaction } from "./db.mjs";
import { hasActiveStagedResolution } from "./held_request_stop.mjs";
import { requestContext } from "./held_request.mjs";
import {
  MAX_HOLDER_RETRIES,
  ROOT_TOLD_SQL,
  publishFailedAttemptNotices,
  stageFailedAttemptNotices,
} from "./holder_failed_notice.mjs";
import { reconcileCustodyLoss } from "./custody_reconciler.mjs";
import { EXACT_SESSION_UNAVAILABLE } from "./ops/resume_fail.mjs";
import {
  selectablePendingSql,
  selectableRuntimes,
} from "./resume_candidate.mjs";
import { createRuntimeRegistry } from "../runtimes/registry.mjs";
import { NOT_SUPERSEDED_ENDPOINT } from "./supervised_exit.mjs";

export const STALL_GRACE_MS = 2 * 60 * 60 * 1000;
const STALL_SWEEP_EVERY_MS = 60 * 1000;
const STALL_SWEEP_LIMIT = 25;
// The resumer's replacement admission reads the same facts (resumer.mjs
// attributableFailures): a refused exact session on an unsuperseded endpoint.
const AWAITS_REPLACEMENT = `r.state = 'failed' AND r.replacement_failure_reason IS :unavailable AND r.replacement_endpoint_id IS NULL
                AND (r.recovery_mode IS NULL OR r.recovery_mode != 'replacement') AND ${NOT_SUPERSEDED_ENDPOINT}`;
// Nothing on the holder endpoint `e` will move its work: no claimed or recent
// launch, no replacement awaiting admission, no admitted replacement whose own
// launch is claimed or recent. Pending launches are judged in JS by the
// resumer's rule (stillMoving).
const NOTHING_COMING = `NOT EXISTS (SELECT 1 FROM resume_requests r WHERE r.endpoint_id = e.id
           AND (r.state = 'claimed' OR r.updated_at >= :cutoff OR (${AWAITS_REPLACEMENT})))
     AND NOT EXISTS (SELECT 1 FROM resume_requests r JOIN resume_requests rr ON rr.endpoint_id = r.replacement_endpoint_id
          WHERE r.endpoint_id = e.id AND (rr.state = 'claimed' OR rr.updated_at >= :cutoff))`;
// The endpoint `e` stopped: exit evidence (owner exit stamp, or dead), not
// busy or closed, and nothing about it changed for STALL_GRACE_MS.
const STOPPED = `e.state NOT IN ('busy', 'closed') AND (e.state = 'dead' OR e.owner_process_exited_at IS NOT NULL)
     AND COALESCE(e.owner_process_exited_at, e.updated_at) < :cutoff AND e.updated_at < :cutoff`;
// tldr sent this leaf a cut-off or limit note (limit_note.mjs) after the install: activity on the work
// itself (the note does not touch the obligation row). Seeks the message key
// index, like notesFor. One EXISTS per key shape: an OR of the two inside one
// EXISTS seeks app_id alone and reads every message of the app per leaf (ac-srg29.4).
const RETRY_NOTE = (keyMatch) =>
  `EXISTS (SELECT 1 FROM messages m WHERE m.app_id IN (SELECT id FROM applications) AND ${keyMatch} AND m.created_at >= :watermark)`;
export const RETRIED_SINCE_INSTALL = `(${RETRY_NOTE(`m.idempotency_key IN (${Array.from({ length: MAX_HOLDER_RETRIES }, (_, i) => `'holder-retry:' || o.id || ':${i + 1}'`).join(", ")})`)}
       OR ${RETRY_NOTE(`m.idempotency_key >= 'holder-limit:' || o.id || ':' AND m.idempotency_key < 'holder-limit:' || o.id || ';'`)})`;
const UNFIRED_WAKE = (node) =>
  `EXISTS (SELECT 1 FROM scheduled_wakes w WHERE w.attempt_id = ${node}.id AND w.fired_at IS NULL AND w.cancelled_at IS NULL)`;
// ac-3d5.95 x jfv.161: a user's request abandoned on a dead holder is flagged for the brief, never noticed (Joe 2026-11-24).
const ABANDONED_USER_REQUEST = `(a.resolution_reason = 'dead_holder_abandoned' AND EXISTS (
       SELECT 1 FROM message_effects me JOIN messages m ON m.id = me.message_id
        WHERE me.obligation_id = root.id AND me.effect = 'open' AND m.origin = 'inbound'))`;
const OPEN_CHILD = (node) =>
  `EXISTS (SELECT 1 FROM obligations c WHERE c.parent_id = ${node}.id AND c.status = 'open')`;

const LEAF_SQL = `SELECT o.*, e.process_generation AS endpoint_generation, o.updated_at AS cursor_at, o.id AS cursor_id
    FROM obligations o JOIN endpoints e ON e.id = o.custodian_endpoint_id
   WHERE o.status = 'open' AND o.role IN ('attempt', 'delegation') AND o.updated_at < :cutoff
     AND (o.updated_at, o.id) > (:after_at, :after_id)
     AND ${STOPPED}
     AND (o.updated_at >= :watermark OR ${RETRIED_SINCE_INSTALL})
     AND NOT ${OPEN_CHILD("o")} AND NOT ${UNFIRED_WAKE("o")} AND ${NOTHING_COMING}
   ORDER BY o.updated_at, o.id LIMIT :limit`;

const ROOT_SQL = `SELECT a.*, root.updated_at AS cursor_at, root.id AS cursor_id
    FROM obligations root
    JOIN obligations a ON a.id = (SELECT n.id FROM obligations n WHERE n.parent_id = root.id AND n.role = 'attempt' ORDER BY n.generation DESC LIMIT 1)
    JOIN endpoints e ON e.id = a.custodian_endpoint_id
   WHERE root.status = 'open' AND root.role = 'root' AND root.updated_at < :cutoff
     AND (root.updated_at, root.id) > (:after_at, :after_id)
     AND a.status = 'closed' AND a.resolution = 'failed' AND a.updated_at < :cutoff
     AND e.updated_at < :cutoff AND COALESCE(e.owner_process_exited_at, '') < :cutoff
     AND max(root.updated_at, a.updated_at) >= :watermark
     AND NOT EXISTS (SELECT 1 FROM obligations live WHERE live.parent_id = root.id AND live.role = 'attempt' AND live.status = 'open')
     AND NOT ${ROOT_TOLD_SQL("root.id")} AND NOT ${ABANDONED_USER_REQUEST}
     AND NOT ${OPEN_CHILD("a")} AND NOT ${UNFIRED_WAKE("a")} AND ${NOTHING_COMING}
   ORDER BY root.updated_at, root.id LIMIT :limit`;

export const STALL_QUERIES = Object.freeze({ leaf: LEAF_SQL, root: ROOT_SQL });

const watermarkOf = (db) =>
  db
    .prepare("SELECT installed_at FROM holder_stall_watermark WHERE id = 1")
    .get()?.installed_at ?? "";

// One page of a sweep, resuming after the last row the previous page saw, so
// rows the JS checks pass over can never starve the rest.
function page(context, { key, sql }, now) {
  const cursors = (context.stallCursors ??= {});
  const [afterAt, afterId] = cursors[key] ?? ["", ""];
  const limit = context.stallSweepLimit ?? STALL_SWEEP_LIMIT; // a test lowers it
  const rows = context.db.prepare(sql).all({
    cutoff: new Date(now - STALL_GRACE_MS).toISOString(),
    after_at: afterAt,
    after_id: afterId,
    watermark: watermarkOf(context.db),
    unavailable: EXACT_SESSION_UNAVAILABLE,
    limit,
  });
  const last = rows.at(-1);
  cursors[key] =
    rows.length < limit ? ["", ""] : [last.cursor_at, last.cursor_id];
  return rows;
}

/** A replacement session was admitted for this endpoint, or will be: its work is not failing. */
export function replacementComing(db, endpointId) {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM resume_requests r JOIN endpoints e ON e.id = r.endpoint_id
          WHERE r.endpoint_id = :endpoint AND (r.replacement_endpoint_id IS NOT NULL OR (${AWAITS_REPLACEMENT})) LIMIT 1`,
      )
      .get({ endpoint: endpointId, unavailable: EXACT_SESSION_UNAVAILABLE }),
  );
}

// A pending launch the resumer will select on this endpoint now: its whole
// candidate question (resume_candidate.mjs).
function resumerWillSelect(context, endpointId, { runtimes, now }) {
  const selectable = selectablePendingSql("r", runtimes, now.toISOString());
  return Boolean(
    context.db
      .prepare(
        `SELECT 1 FROM resume_requests r JOIN endpoints e ON e.id = r.endpoint_id
          WHERE r.endpoint_id = ? AND ${selectable.sql} LIMIT 1`,
      )
      .get(endpointId, ...selectable.params),
  );
}

// Every replacement in the holder's lineage (a replacement's own
// replacements too), and whether it is live: not closed and busy, its owner
// process recorded and not exited, or changed inside the grace; or a launch
// of it claimed or changed inside the grace. A live replacement may still
// adopt the holder's roots (recovery.retry); a placeholder that never ran is
// not live.
const LINEAGE_SQL = `WITH RECURSIVE lineage(id) AS (
    SELECT replacement_endpoint_id FROM resume_requests WHERE endpoint_id = :holder AND replacement_endpoint_id IS NOT NULL
    UNION SELECT r.replacement_endpoint_id FROM resume_requests r JOIN lineage l ON r.endpoint_id = l.id WHERE r.replacement_endpoint_id IS NOT NULL)
  SELECT e.id, (e.state != 'closed' AND (e.state = 'busy' OR e.updated_at >= :cutoff OR e.owner_process_exited_at >= :cutoff
           OR (e.owner_process_pid IS NOT NULL AND e.owner_process_exited_at IS NULL AND e.state != 'dead')))
         OR EXISTS (SELECT 1 FROM resume_requests q WHERE q.endpoint_id = e.id AND (q.state = 'claimed' OR q.updated_at >= :cutoff)) AS live
    FROM lineage JOIN endpoints e ON e.id = lineage.id`;

function replacementMoving(context, holder, pass) {
  return context.db
    .prepare(LINEAGE_SQL)
    .all({
      holder,
      cutoff: new Date(pass.now - STALL_GRACE_MS).toISOString(),
    })
    .some((row) => row.live || resumerWillSelect(context, row.id, pass));
}

// Settled already (the request closed, or a resolution is staged), a
// pending launch the resumer will still select on the holder, or a live or
// launching replacement in its lineage.
function stillMoving(context, node, pass) {
  const { db } = context;
  const work = requestContext(db, node);
  if (
    work &&
    (work.root.status !== "open" || hasActiveStagedResolution(db, work.root.id))
  )
    return true;
  const holder = node.custodian_endpoint_id;
  return (
    resumerWillSelect(context, holder, pass) ||
    replacementMoving(context, holder, pass)
  );
}

function logged(context, { event, node, result }) {
  context.logger?.info?.({
    event,
    params: { endpoint_id: node.custodian_endpoint_id, node_id: node.id },
    result,
    status: "ok",
  });
}

function closeStalled(context, node, now) {
  const outcome = reconcileCustodyLoss(context, {
    endpointId: node.custodian_endpoint_id,
    evidenceKind: "holder_stalled",
    observedProcessGeneration: node.endpoint_generation,
    capturedNodes: [{ id: node.id, generation: node.generation }],
    now,
  });
  logged(context, {
    event: "holder_stalled_closed",
    node,
    result: { decided: outcome.decided, reason: outcome.reason ?? null },
  });
  return outcome.decided ? 1 : 0;
}

// The root's custody is already lost; only the notice the reconciler held
// back is owed, through the reconciler's own stager (same key, same text).
function noticeOrphanedRoot(context, attempt, now) {
  const sends = withTransaction(context.db, () =>
    stageFailedAttemptNotices(context, {
      closed: [attempt.id],
      routed: new Set(),
      enabled: true,
      now,
    }),
  );
  publishFailedAttemptNotices(context, sends);
  logged(context, {
    event: "holder_stalled_root_noticed",
    node: attempt,
    result: { notices: sends.map((send) => send.to) },
  });
  return sends.some((send) => send.sent) ? 1 : 0;
}

const SHAPES = [
  { key: "leaf", sql: LEAF_SQL, settle: closeStalled },
  { key: "root", sql: ROOT_SQL, settle: noticeOrphanedRoot },
];

function sweep(context, shape, pass) {
  return page(context, shape, pass.now)
    .filter((node) => !stillMoving(context, node, pass))
    .reduce((count, node) => count + shape.settle(context, node, pass.now), 0);
}

/**
 * At most once a minute from the resumer tick, at most STALL_SWEEP_LIMIT
 * rows per shape: close each stalled leaf through the custody reconciler and
 * tell each orphaned root's requester, exactly once. Returns the count.
 * Never throws.
 */
export function settleStalledHolders(context, now = new Date()) {
  if (now - (context.stalledHolderSweepAt ?? 0) < STALL_SWEEP_EVERY_MS)
    return 0;
  context.stalledHolderSweepAt = now;
  try {
    const registry =
      context.runtimeRegistry ??
      createRuntimeRegistry({ stateRoot: context.stateRoot });
    const pass = { now, runtimes: selectableRuntimes(registry) };
    return SHAPES.reduce(
      (count, shape) => count + sweep(context, shape, pass),
      0,
    );
  } catch (error) {
    context.logger?.error?.({
      event: "holder_stalled_sweep_failed",
      result: { message: error.message, stack: error.stack },
      status: "error",
    });
    return 0;
  }
}
