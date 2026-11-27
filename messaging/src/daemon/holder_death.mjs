// A holder's death (ac-4p2j0): decided at the moment the daemon sees it.
//
// A session that dies mid-work (supervised: a nonzero or signal exit after it
// took its brief; unsupervised: its owner exited while busy) while it holds open
// work is resumed, quietly: a typed note goes to the holder and the ordinary
// resume path relaunches that exact session (a usage limit holds the launch until
// the reset, ac-jfv.165). The requester hears nothing while that runs or after it
// succeeds. Progress since the latest cut-off note = the holder (this endpoint)
// committed an effect on this node, or it stayed alive ALIVE_PROGRESS_MS after
// taking the note; it is retried again only then, at most MAX_HOLDER_RETRIES
// relaunches per node (so it cannot loop). A death with no
// progress since the last relaunch, the cap, or a holder nothing can launch is
// exhausted: the caller closes those nodes through the shared custody
// reconciler (all fences intact), which tells the
// requester exactly once (holder_failed_notice.mjs; a delegation's parent gets
// the existing custody_lost wake instead).
//
// One death is decided once: while the holder has not read its latest note the
// retry is still pending (the same death seen again by the other observer, or a
// launch that died before its brief, which the resumer itself retries), so
// nothing is decided. A death after the holder read the note is a new death.
// Exactly-once across restarts rides UNIQUE(app_id, idempotency_key) on the
// note (`holder-retry:<node>:<n>`) and the notice (`holder-failed:<attempt>`).

import { withTransaction } from "./db.mjs";
import { hasActiveStagedResolution } from "./held_request_stop.mjs";
import { copilotWakeScopeSql } from "./copilot_wake.mjs";
import { createRuntimeRegistry } from "../runtimes/registry.mjs";
import { isPackageBoundCopilotRecord } from "../runtimes/copilot_wake_contract.mjs";
import { requestContext } from "./held_request.mjs";
import { LIMIT_KEY_PREFIX } from "./limit_note.mjs";
import { launchIdentity, liveSupervisedChildFor } from "./resume_children.mjs";
import {
  MAX_HOLDER_RETRIES,
  notesFor,
  retryKey,
} from "./holder_failed_notice.mjs";
import { publish } from "./scheduled_wake_pass.mjs";
import { recheckFor, sendRetry } from "./holder_note.mjs";
import { reconcileCustodyLoss } from "./custody_reconciler.mjs";
import { NOT_SUPERSEDED_ENDPOINT } from "./supervised_exit.mjs";

export { MAX_HOLDER_RETRIES, retryKey };
export const ALIVE_PROGRESS_MS = 10 * 60 * 1000;

// The holder has not taken the note yet: its retry is still pending.
const unread = (db, noteId, endpointId) =>
  Boolean(
    db
      .prepare(
        "SELECT 1 FROM deliveries WHERE message_id = ? AND endpoint_id = ? AND read_at IS NULL AND state != 'failed' LIMIT 1",
      )
      .get(noteId, endpointId),
  );

// Progress since the note `last`: this endpoint committed an effect on this
// node (update, reply, delegate: an endpoint holding open work cannot send
// without one), or it took the note ALIVE_PROGRESS_MS or more before `now`
// (a long build reports only at milestones). Dying right away is no progress.
// `aliveUntil` is the exit time of a supervised launch (the exit callback's own
// clock). null (an owner-pass death: a process sample is no evidence of a
// launch's time alive) counts no time, so only an effect is progress.
function progressed(db, node, { last, endpointId, aliveUntil }) {
  const spoke = db
    .prepare(
      `SELECT 1 FROM messages m JOIN message_effects fx ON fx.message_id = m.id
        WHERE m.conversation_id = ? AND m.rowid > ? AND fx.obligation_id = ?
          AND json_extract(fx.effect_payload, '$.declaration.sender_endpoint_id') = ? LIMIT 1`,
    )
    .get(node.conversation_id, last.seq, node.id, endpointId);
  if (spoke) return true;
  // A usage-limit wait is not time alive: the clock starts at the later of the
  // cut-off note's read and a limit note's read (limit_note.mjs), which resumes
  // the holder after the reset.
  const taken = db
    .prepare(
      `SELECT MAX(d.read_at) AS read_at FROM deliveries d JOIN messages m ON m.id = d.message_id
        WHERE d.endpoint_id = ? AND d.read_at IS NOT NULL
          AND (m.id = ? OR (m.idempotency_key >= ? AND m.idempotency_key < ?))`,
    )
    .get(
      endpointId,
      last.id,
      `${LIMIT_KEY_PREFIX}${node.id}:`,
      `${LIMIT_KEY_PREFIX}${node.id};`,
    );
  return (
    Boolean(taken?.read_at) &&
    aliveUntil !== null &&
    aliveUntil - Date.parse(taken.read_at) >= ALIVE_PROGRESS_MS
  );
}

// Open work this endpoint holds that a death leaves unattended: not handed on
// (no open child) and not parked (no unfired wake: that wake relaunches it).
function heldNodes(db, endpointId) {
  return db
    .prepare(
      `SELECT o.* FROM obligations o
        WHERE o.custodian_endpoint_id = ? AND o.role IN ('attempt', 'delegation') AND o.status = 'open'
          AND NOT EXISTS (SELECT 1 FROM obligations c WHERE c.parent_id = o.id AND c.status = 'open')
          AND NOT EXISTS (SELECT 1 FROM scheduled_wakes w WHERE w.attempt_id = o.id AND w.fired_at IS NULL AND w.cancelled_at IS NULL)
        ORDER BY o.id`,
    )
    .all(endpointId);
}

// Whether the resumer could relaunch this exact session: the same facts its
// candidate query reads (not superseded, daemon runtime, Copilot wake scope).
// A note nothing can launch would sit unread forever.
export function launchable(context, endpointId) {
  const { db } = context;
  const registry =
    context.runtimeRegistry ??
    createRuntimeRegistry({ stateRoot: context.stateRoot });
  const endpoint = db
    .prepare(
      `SELECT e.runtime, e.state, e.provider_session_id, ${NOT_SUPERSEDED_ENDPOINT} AS current FROM endpoints e WHERE e.id = ?`,
    )
    .get(endpointId);
  if (
    endpoint?.state === "closed" ||
    !endpoint?.current ||
    !endpoint.provider_session_id
  )
    return false;
  const wakeRecords = registry
    .list()
    .filter((record) => isPackageBoundCopilotRecord(record));
  // The resumer's selectable runtimes: daemon-strategy records plus package-bound Copilot wake records.
  const record = registry.get(endpoint.runtime);
  if (
    record?.resumeStrategy !== "daemon" &&
    !wakeRecords.some((wake) => wake.id === record?.id)
  )
    return false;
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM endpoints e WHERE e.id = ? AND ${copilotWakeScopeSql(wakeRecords)}`,
      )
      .get(endpointId),
  );
}

// A usage limit holds this endpoint's relaunch until the provider's reset
// (ac-jfv.165): its exit was the limit, not a death, whoever observes it.
const limitHeld = (db, endpointId) =>
  Boolean(
    db
      .prepare(
        `SELECT 1 FROM resume_requests r JOIN claims c ON c.resource_type = 'resume_request' AND c.resource_id = r.id
          WHERE r.endpoint_id = ? AND r.state = 'claimed' AND c.state = 'claimed' AND c.outcome = 'limit_backoff' LIMIT 1`,
      )
      .get(endpointId),
  );

// One held node at a death: "skip" (request settled, or its retry still
// pending), "exhausted", or the request context and note number to retry with.
function nodeOutcome(db, node, { endpointId, canLaunch, aliveUntil, recheck }) {
  const work = requestContext(db, node);
  if (
    work &&
    (work.root.status !== "open" || hasActiveStagedResolution(db, work.root.id))
  )
    return "skip";
  const notes = notesFor(db, node.id);
  const last = notes.at(-1);
  if ((last && unread(db, last.id, endpointId)) || limitHeld(db, endpointId))
    return "skip";
  const due =
    !last ||
    (notes.length < MAX_HOLDER_RETRIES &&
      progressed(db, node, { last, endpointId, aliveUntil }));
  const retry = work && canLaunch && due ? { work, n: notes.length + 1 } : null;
  return (
    recheckFor(db, node, { work, canLaunch, retry, generation: recheck }) ??
    retry ??
    "exhausted"
  );
}

// The death is of the process that holds the row now: the generation that died is current and
// (supervised) the exiting launch still speaks for the row (launchIdentity: token, pid, start
// identity). A late exit of an older launch, or one a reopened pane replaced, is inert.
function fenced(db, { endpointId, generation, capture }) {
  const endpoint = db
    .prepare(
      "SELECT process_generation, owner_launch_token, owner_process_pid, owner_process_start_identity FROM endpoints WHERE id = ?",
    )
    .get(endpointId);
  if (endpoint?.process_generation !== generation) return true;
  return Boolean(capture) && !launchIdentity(endpoint, capture);
}

/**
 * Decides one observed death of `endpointId` at process `generation`
 * (`capture`: the exiting supervised launch's custody capture;
 * `onlyRetried`: the exiting launch's own request is still pending its
 * attempt retry, so a node never sent a cut-off note may not have taken its
 * brief: leave it to that retry). Returns
 * the nodes it re-woke and the nodes the caller must close as failed
 * (`{ id, generation }`, ready as capturedNodes for reconcileCustodyLoss).
 */
export function decideHolderDeath(
  context,
  {
    endpointId,
    generation,
    capture = null,
    now = new Date(),
    source,
    onlyRetried = false,
    aliveUntil = now,
    unsupervised = false,
  },
) {
  const { db } = context;
  const canLaunch = launchable(context, endpointId);
  const decided = withTransaction(db, () => {
    const result = { retried: [], exhausted: [], sends: [] };
    const nodes = fenced(db, { endpointId, generation, capture })
      ? []
      : heldNodes(db, endpointId).filter(
          (node) => !onlyRetried || notesFor(db, node.id).length > 0,
        );
    for (const node of nodes) {
      const outcome = nodeOutcome(db, node, {
        endpointId,
        canLaunch,
        aliveUntil,
        recheck: unsupervised ? generation : null,
      });
      if (outcome === "exhausted")
        result.exhausted.push({ id: node.id, generation: node.generation });
      if (typeof outcome !== "object") continue;
      result.sends.push(
        sendRetry(context, node, { endpointId, ...outcome, now }),
      );
      result.retried.push(node.id);
    }
    return result;
  });
  for (const { conversationId, sent } of decided.sends)
    publish(context, conversationId, sent);
  context.logger?.info?.({
    event: "holder_death_decided",
    params: {
      endpoint_id: endpointId,
      generation,
      source,
      launchable: canLaunch,
    },
    result: {
      retried: decided.retried,
      exhausted: decided.exhausted.map((node) => node.id),
    },
    status: "ok",
  });
  return { retried: decided.retried, exhausted: decided.exhausted };
}

/**
 * One observed death, end to end: resume what can be resumed, and hand what
 * is exhausted to `close(capturedNodes)` (the caller's fenced custody
 * reconcile; returns whether it decided). Returns 1 when work was closed.
 * Never throws: a failure here must not break the observer's pass.
 */
export function settleHolderDeath(
  context,
  {
    endpointId,
    generation,
    capture = null,
    source,
    now,
    died,
    close,
    onlyRetried = false,
    aliveUntil = now,
    unsupervised = false,
  },
) {
  if (!died) return 0;
  try {
    const death = decideHolderDeath(context, {
      endpointId,
      generation,
      capture,
      now,
      source,
      onlyRetried,
      aliveUntil,
      unsupervised,
    });
    return death.exhausted.length > 0 && close(death.exhausted) ? 1 : 0;
  } catch (error) {
    context.logger?.error?.({
      event: "holder_death_failed",
      params: { endpoint_id: endpointId, source },
      result: { message: error.message, stack: error.stack },
      status: "error",
    });
    return 0;
  }
}

// An owner process the reconciler saw exit (retirement_executor.mjs): only one
// that was BUSY was cut off mid-work; an idle exit is a stop, not a death.
export function settleOwnerDeath(context, row, now) {
  const observedProcessGeneration = row.process_generation;
  // r32: a tracked supervised child's own exit callback decides limit versus death for its launch, and the
  // owner pass can see the provider PID gone before it runs. The exit is recorded (the caller's UPDATE); the
  // decision waits, but only for the launch that is the recorded owner (its token is the row's, r33): a newer
  // process that restamped the row owns this death.
  // Only 'registered' defers (not 'unchanged'): a never-registered tracked child must not defer an earlier
  // owner's real death; the control test in holder_limit_identity pins it.
  const owner =
    row.state === "busy"
      ? context.db
          .prepare(
            "SELECT owner_launch_token, owner_process_pid, owner_process_start_identity FROM endpoints WHERE id = ?",
          )
          .get(row.id)
      : null;
  const inFlight = owner
    ? liveSupervisedChildFor(context, row.id, owner)
    : null;
  if (inFlight) {
    context.logger?.info?.({
      event: "holder_death.owner_exit_deferred",
      params: { endpoint_id: row.id, in_flight_request_id: inFlight.requestId },
      result: { decision: "left_to_supervised_exit" },
      status: "ok",
    });
    return 0;
  }
  return settleHolderDeath(context, {
    endpointId: row.id,
    generation: observedProcessGeneration,
    source: "owner_exit",
    now,
    aliveUntil: null,
    unsupervised: Boolean(row.owner_launch_token),
    died: row.state === "busy",
    close: (capturedNodes) =>
      reconcileCustodyLoss(context, {
        endpointId: row.id,
        evidenceKind: "owner_exit",
        observedProcessGeneration,
        capturedNodes,
        now,
      }).decided,
  });
}
