// ac-jfv.170: a takeover_pending row nobody will adopt. message.read can no
// longer cause it (it leaves a takeover-decided delivery unread, so the
// takeover request is never completed by a read and its lifecycle ends the
// row: adoption, or restoreTakeoverPredecessor once attempts are exhausted).
// This sweep is the net for rows stranded before that fence, and for a failed
// takeover request whose restore declined: neither the resumer, the restore,
// the reclaim nor the owner-exit watch moves them, so they refuse receive
// (endpoint_takeover_pending) and mail piles up for good. With its predecessor
// dead and no successor pending, claimed or alive, the busy-over-exited-owner
// pass (busy_over_exited_owner.mjs) settles the row as the owner exit would
// have (headless -> idle, interactive -> dead). Unlike the busy settle its
// mail is left unread and receivable by the next launch.
import { liveEntry } from "./process_table.mjs";
import {
  ownerProcessLiveness,
  ownerProcessTupleIsComplete,
} from "./owner_process_contract.mjs";

// One `?`: now. A live or backoff-held launch claim on any request of the endpoint.
export const LIVE_LAUNCH_CLAIM = `EXISTS (
    SELECT 1 FROM claims c JOIN resume_requests r ON r.id = c.resource_id
     WHERE c.resource_type = 'resume_request' AND c.state = 'claimed' AND c.lease_expires_at > ?
       AND r.endpoint_id = e.id)`;

// No pending or claimed availability_takeover request: no successor is queued or launching.
const NO_LIVE_TAKEOVER_REQUEST = `NOT EXISTS (
    SELECT 1 FROM resume_requests r
     WHERE r.endpoint_id = e.id AND r.reason = 'availability_takeover' AND r.state IN ('pending', 'claimed'))`;

// A Codex orphan keeps the fence, as on main, until ac-jfv.248: judging it needs the async
// thread-host probe (F34: a managed app-server may host the thread after its TUI died).
const NOT_CODEX = "e.runtime IS NOT 'codex'";

export const ORPHANED_TAKEOVER = `
  SELECT e.id, e.runtime, e.launch_mode, e.process_generation, e.owner_epoch, e.provider_session_id,
         e.owner_launch_token, e.owner_process_pid, e.owner_process_start_identity,
         e.owner_process_group_id, e.owner_process_capture_source, e.owner_process_generation,
         e.owner_process_exited_at, e.updated_at, 'takeover_pending' AS from_state
    FROM endpoints e
   WHERE e.state = 'takeover_pending' AND ${NOT_CODEX}
     AND e.provider_session_id IS NOT NULL AND length(e.provider_session_id) > 0
     AND ${NO_LIVE_TAKEOVER_REQUEST}
     AND NOT ${LIVE_LAUNCH_CLAIM}`;

// CAS on everything read, plus the request fence: a takeover decided or a successor queued since the read fences it.
const SETTLE_ORPHANED_TAKEOVER = `
  UPDATE endpoints AS e SET state = ?, updated_at = ?
   WHERE e.id = ? AND e.state = 'takeover_pending' AND ${NOT_CODEX} AND e.process_generation = ? AND e.owner_epoch = ?
     AND e.launch_mode IS ? AND e.owner_launch_token IS ? AND e.owner_process_pid IS ?
     AND e.owner_process_exited_at IS ? AND e.updated_at IS ?
     AND ${NO_LIVE_TAKEOVER_REQUEST}
     AND NOT ${LIVE_LAUNCH_CLAIM}`;

// The predecessor itself: alive (same pid and start identity) holds the row, and so does an
// owner nobody proved dead. A tuple of another generation or an incomplete one is no proof either way.
export function predecessorHolder(row, snapshot) {
  if (
    ownerProcessTupleIsComplete(row) &&
    row.owner_process_generation === row.process_generation
  ) {
    const entry = liveEntry(snapshot, row.owner_process_pid);
    return ownerProcessLiveness(row, entry) === "gone"
      ? null
      : { kind: "owner_process", pid: row.owner_process_pid };
  }
  return row.owner_process_exited_at ? null : { kind: "owner_unproven" };
}

// One statement, so atomic; mail is deliberately not abandoned: the next launch receives it.
export function settleOrphanedTakeover(context, row, { nextState, nowIso }) {
  return (
    context.db
      .prepare(SETTLE_ORPHANED_TAKEOVER)
      .run(
        nextState,
        nowIso,
        row.id,
        row.process_generation,
        row.owner_epoch,
        row.launch_mode,
        row.owner_launch_token,
        row.owner_process_pid,
        row.owner_process_exited_at,
        row.updated_at,
        nowIso,
      ).changes === 1
  );
}
