// Thread owners (ac-32qki PR 1): each side of a thread is owned by one session.
// conversations.starter_owner_endpoint_id is the side that sent the first message,
// target_owner_endpoint_id the other; NULL is a user side and every pre-existing thread.
// Owners are written at thread start and when the thread is passed. A tldr restart writes nothing:
// readers follow the newest lineage.
//
// SELECTION RULE (the one place it is written). The holder-side owner is, among ALL open roots of
// the thread, the open accepted custodian with the greatest delegation depth (attempt 1, its
// delegation 2, a nested delegation 3, ...). Ties go to the latest start: the obligation's creation
// (a reply, switch, transfer or retry makes a new attempt; an offer makes a delegation). When no
// open custodian remains the owner is the custodian of the latest attempt of the most recently
// opened root (a delegate's end passes the side back to its delegator's lineage). Any change to an
// obligation's status or custodian marks the conversation (performance_indexes.mjs);
// settleThreadOwners recomputes it once per transaction.
//
// shortcut: across roots, depth decides before recency, so an older root's orphaned delegation can
// outrank a newer root's switch. Live census: orphan-then-new-root 0 in 7d; a repro reopens it.
// shortcut: acceptances in the same millisecond tie to obligation insertion order, not accept order.
// Live census: same-timestamp accepts 0 all-time; a repro reopens it.
// shortcut: a session restarted under its own attempt counts as a new start, and a delegate of a
// principal that never owned a side is not found as a side by routing. Live census: retry of a
// delegator under an open delegation 0, cross-agent delegation 0; a repro reopens either.
import { onBeforeCommit } from "../db.mjs";
import { newestLineageEndpointId } from "./message_shared.mjs";

const COLUMNS = ["starter_owner_endpoint_id", "target_owner_endpoint_id"];
export const newest = (db, id) =>
  typeof id === "string" ? newestLineageEndpointId(db, id) : null;

export function ownersOf(db, conversationId) {
  return (
    db
      .prepare(`SELECT ${COLUMNS.join(", ")} FROM conversations WHERE id = ?`)
      .get(conversationId) ?? {}
  );
}

/** The first accepted send of a thread: the sender's session owns its side, the named session the other. */
export function startThread(
  db,
  { conversationId, sendBranch, effect, targetEndpointId, logger },
) {
  const starter =
    sendBranch === "agent" ? (effect.sender_endpoint_id ?? null) : null;
  const target =
    (effect.type === "open" ? effect.target_endpoint_id : targetEndpointId) ??
    null;
  if (starter === null && target === null) return;
  db.prepare(
    "UPDATE conversations SET starter_owner_endpoint_id = ?, target_owner_endpoint_id = ? WHERE id = ? AND starter_owner_endpoint_id IS NULL AND target_owner_endpoint_id IS NULL",
  ).run(starter, target, conversationId);
  logger?.info?.({
    event: "thread_owners_started",
    params: { conversation_id: conversationId, send_branch: sendBranch },
    result: {
      starter_owner_endpoint_id: starter,
      target_owner_endpoint_id: target,
    },
    status: "ok",
  });
}

// The open session of the lineage, if it is a participant of the thread. An owner that cannot take
// a row is warned about and null is returned, so routing falls back to today's rather than drop a wake.
function openOwner(db, { conversationId, endpointId }, logger) {
  const id = newest(db, endpointId);
  if (id === null) return null;
  const row = db
    .prepare(
      `SELECT e.id FROM endpoints e JOIN conversation_participants p ON p.principal_id = e.principal_id AND p.conversation_id = ?
        WHERE e.id = ? AND e.state != 'closed'`,
    )
    .get(conversationId, id);
  if (!row)
    logger?.warn?.({
      event: "thread_owner_unroutable",
      params: {
        conversation_id: conversationId,
        owner_endpoint_id: endpointId,
      },
      result: { routed_endpoint_id: id },
      status: "fallback",
    });
  return row?.id ?? null;
}

// The other side's owner for a post: an inbound post goes to the one agent-side owner, an owner's
// post to the opposite side. Null when the sender owns neither side (or both).
function otherSideOwner(
  db,
  { sendBranch, effect },
  { starter_owner_endpoint_id: starter, target_owner_endpoint_id: target },
) {
  if (sendBranch === "inbound") return soleOwner(starter, target);
  const sender = newest(db, effect.sender_endpoint_id);
  const [first, second] = [newest(db, starter), newest(db, target)];
  if (sender === null) return null;
  return sender === first ? target : sender === second ? starter : null;
}
const soleOwner = (starter, target) =>
  starter !== null && target === null
    ? starter
    : target !== null && starter === null
      ? target
      : null;

// A post keeps the route it names when it names a session of the sender's own principal (its
// lineage or a live sibling: never routed to the other side) or of a principal that owns neither
// side (the recipient was validated before this point and joins the thread). Naming an owner's
// principal is the drift owner routing replaces.
function keepsNamedRoute(
  db,
  { namedEndpointId, senderEndpointId, conversationId },
) {
  if (typeof namedEndpointId !== "string") return false;
  return !db
    .prepare(
      `SELECT 1 FROM endpoints named WHERE named.id = ?1
          AND named.principal_id IS NOT (SELECT principal_id FROM endpoints WHERE id = ?3)
          AND named.principal_id IN (
         SELECT e.principal_id FROM endpoints e JOIN conversations c ON c.id = ?2 AND e.id IN (c.starter_owner_endpoint_id, c.target_owner_endpoint_id))`,
    )
    .get(namedEndpointId, conversationId, senderEndpointId ?? null);
}

function routeFor(
  db,
  { conversationId, sendBranch, effect, namedEndpointId, logger },
) {
  if (
    effect.type !== "none" ||
    keepsNamedRoute(db, {
      namedEndpointId,
      senderEndpointId: effect.sender_endpoint_id,
      conversationId,
    })
  )
    return null;
  const other = otherSideOwner(
    db,
    { sendBranch, effect },
    ownersOf(db, conversationId),
  );
  const routed =
    other === null
      ? null
      : openOwner(db, { conversationId, endpointId: other }, logger);
  return routed === newest(db, effect.sender_endpoint_id) ? null : routed;
}

/**
 * Where a plain post goes on an owned thread: the other side's owner (newest lineage). Null means
 * today's routing: not an owned thread, a sender that is no owner, or an owner that cannot take a row.
 */
export function ownedRecipient(db, args) {
  const routed = routeFor(db, args);
  if (routed !== null)
    args.logger?.debug?.({
      event: "thread_owner_routed",
      params: {
        conversation_id: args.conversationId,
        send_branch: args.sendBranch,
      },
      result: { routed_endpoint_id: routed },
      status: "ok",
    });
  return routed;
}

/** The session a user reply goes to: the one agent-side owner, or null (today's routing). */
export function agentSideOwner(db, conversationId, logger) {
  const {
    starter_owner_endpoint_id: starter,
    target_owner_endpoint_id: target,
  } = ownersOf(db, conversationId);
  return openOwner(
    db,
    { conversationId, endpointId: soleOwner(starter, target) },
    logger,
  );
}

// The side that holds a thread's work: the starter side of an agent-to-user thread (no target
// owner), otherwise the target side.
const holderColumn = (owners) =>
  owners[COLUMNS[0]] !== null && owners[COLUMNS[1]] === null
    ? COLUMNS[0]
    : COLUMNS[1];

// Every obligation of the thread with its depth, root and custody start (see the rule above).
function workOf(db, conversationId) {
  const rows = db
    .prepare(
      `WITH RECURSIVE tree(id, root_id, root_status, depth, root_opened, root_seq) AS (
         SELECT id, id, status, 0, created_at, rowid FROM obligations WHERE conversation_id = ?1 AND parent_id IS NULL
         UNION ALL SELECT o.id, t.root_id, t.root_status, t.depth + 1, t.root_opened, t.root_seq FROM obligations o JOIN tree t ON o.parent_id = t.id)
       SELECT o.rowid AS seq, o.id, o.role, o.status, o.generation, o.custodian_endpoint_id AS custodian,
              t.root_id, t.root_status, t.depth, t.root_opened, t.root_seq,
              o.created_at AS start
         FROM obligations o JOIN tree t ON t.id = o.id WHERE o.role != 'root' AND o.custodian_endpoint_id IS NOT NULL`,
    )
    .all(conversationId);
  return rows;
}

const newerFirst = (a, b) => (a < b) - (a > b);
const byOpenRank = (a, b) =>
  b.depth - a.depth || newerFirst(a.start, b.start) || b.seq - a.seq;
const byLatestAttempt = (a, b) =>
  newerFirst(a.root_opened, b.root_opened) ||
  b.root_seq - a.root_seq ||
  b.generation - a.generation;

// The obligation whose custodian owns the holder side: the rule above.
function holderWork(db, conversationId) {
  const held = workOf(db, conversationId);
  const open = held.filter(
    (row) => row.status === "open" && row.root_status === "open",
  );
  const attempts = held.filter((row) => row.role === "attempt");
  return [...open.sort(byOpenRank), ...attempts.sort(byLatestAttempt)][0];
}

function settleConversation(db, conversationId, logger) {
  const owners = ownersOf(db, conversationId);
  const work = holderWork(db, conversationId);
  if (!work) return;
  const holder = work.custodian;
  const column = holderColumn(owners);
  // A user side stays null; a restart of the owner's own session is not a pass.
  if (!owners[column] || newest(db, owners[column]) === newest(db, holder))
    return;
  db.prepare(`UPDATE conversations SET ${column} = ? WHERE id = ?`).run(
    holder,
    conversationId,
  );
  logger?.info?.({
    event: "thread_owner_passed",
    params: { conversation_id: conversationId, side: column },
    result: { from_endpoint_id: owners[column], to_endpoint_id: holder },
    status: "ok",
  });
}

/** Called by withTransaction before COMMIT: settles every conversation the transaction touched. */
export function settleThreadOwners(db) {
  if (!db.threadOwnersReady) return; // set by ensureThreadOwners; migrations run before it
  const dirty = db
    .prepare("SELECT conversation_id FROM thread_owner_dirty")
    .all();
  if (dirty.length === 0) return;
  db.exec("DELETE FROM thread_owner_dirty");
  for (const { conversation_id: id } of dirty)
    settleConversation(db, id, db.logger);
}

onBeforeCommit(settleThreadOwners);
