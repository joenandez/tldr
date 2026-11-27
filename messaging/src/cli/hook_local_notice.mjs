// hnbc 1.9.2: a changed watermark is answered from the daemon's local notice
// file (inbox.notices.jsonl, contract C5), never from a foreground daemon
// round trip. Notices are found by identity (delivery_id, attempt) through
// the shown ledger (notice_ledger.mjs), never by byte offset or line count:
// the daemon trims the file with temp + rename. The watermark is consumed only
// once its own notice was found; anything else is left to the detached drain.

import { randomUUID } from "node:crypto";
import fs from "node:fs";

import {
  hasLocalReplyMarker,
  isUserNotice,
  logAckGateOpened,
} from "../protocol/ack_gate.mjs";
import { detachPreToolUse } from "./ack_gate_reconcile.mjs";
import {
  renderNotification,
  shownEntries,
  withBodyPrefix,
} from "./arrival_notification.mjs";
import { reserveNoticeRefusals, showNoticeRefusal } from "./hook_ack_gate.mjs";
import {
  claimNotice,
  markNoticeShown,
  releaseNotice,
  shownSnapshot,
} from "./notice_ledger.mjs";

// The daemon trims past 64 KiB, so a tail this size holds every live notice.
export const NOTICE_TAIL_BYTES = 64 * 1024;

function readOrNull(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null; // absent: nothing delivered or consumed yet
  }
}

export function markCapturedWatermarkSeen(paths, watermark) {
  if (readOrNull(paths.seen)?.equals(watermark)) return; // already consumed: no fsync'd rewrite
  const temporary = `${paths.seen}.${process.pid}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, watermark);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(temporary, paths.seen);
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {}
    fs.rmSync(temporary, { force: true });
    throw err;
  }
}

/** Complete JSON lines of the file's last NOTICE_TAIL_BYTES; a torn last line waits for the next read. */
export function readNoticeTail(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  try {
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - NOTICE_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const read = fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, read).toString("utf8").split("\n");
    lines.pop(); // "" after the last newline, or a torn line still being written
    if (start > 0) lines.shift(); // a line cut by the tail's start
    return lines.flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  } finally {
    fs.closeSync(fd);
  }
}

const ATTEMPTS = new Set(["initial", "retry"]);
const ENDPOINT_FIELDS = ["app_id", "endpoint_id", "process_generation"];
const wellFormed = (notice) =>
  typeof notice?.delivery_id === "string" &&
  typeof notice.message_id === "string" &&
  ATTEMPTS.has(notice.attempt);
// The exact current owner: this app, this session, the cached endpoint and its process generation.
const sameOwner = (notice, { sessionId, appId, endpoint }) =>
  typeof appId === "string" &&
  notice.app_id === appId &&
  notice.provider_session_id === sessionId &&
  ENDPOINT_FIELDS.every((field) => notice[field] === endpoint?.[field]);
const ownedBy = (notice, session) =>
  wellFormed(notice) && sameOwner(notice, session);

function ownedNotices(paths, session) {
  const byDelivery = new Map();
  for (const notice of readNoticeTail(paths.notices))
    if (ownedBy(notice, session))
      byDelivery.set(`${notice.delivery_id}#${notice.attempt}`, notice);
  return [...byDelivery.values()];
}

const readWatermark = (paths) => readOrNull(paths.watermark);

function watermarkIdentity(watermark) {
  try {
    const { delivery_id: deliveryId, attempt } = JSON.parse(
      watermark.toString("utf8"),
    );
    return { deliveryId, attempt };
  } catch {
    return {};
  }
}

// The watermark's own notice, by (delivery_id, attempt). A watermark without an attempt
// (today's daemon) matches only an unshown line: a retry re-ring writes no line, so
// an already-shown line of the same delivery is the old presentation, not this one.
function isWatermarkNotice(isShown, notice, { deliveryId, attempt }) {
  if (typeof deliveryId !== "string" || notice.delivery_id !== deliveryId)
    return false;
  return attempt === undefined
    ? !isShown(notice.message_id, notice.attempt)
    : notice.attempt === attempt;
}

function safeOwnedNotices(paths, session) {
  try {
    return ownedNotices(paths, session);
  } catch (error) {
    const code = error.code || error.message;
    session.log({
      event: "local_notice_read_failed",
      session_id: session.sessionId,
      status: "error",
      error: code,
      stack: error.stack,
    });
    logAckGateOpened(paths, {
      reason: "notice_read_failed",
      event: "ack_gate.notice_read_failed",
      extra: { error: code },
    });
    return [];
  }
}

// Claims each unseen notice; `deferred` counts unseen ones another claimer holds.
function claimUnseen(paths, isShown, notices) {
  const claimed = [];
  let deferred = 0;
  for (const notice of notices) {
    const answered =
      isShown(notice.message_id, notice.attempt) ||
      hasLocalReplyMarker(paths, notice.message_id);
    const claim = answered
      ? null
      : claimNotice(paths, notice.message_id, notice.attempt);
    if (claim?.claimed) claimed.push(notice);
    else if (claim && claim.reason !== "shown") deferred += 1;
  }
  return { claimed, deferred };
}

/**
 * The zero-IPC local notice reader (contract for Claude PreToolUse now, and
 * Copilot UPS / PostToolUse later). Reads the watermark and the notice tail,
 * keeps notices owned by this exact endpoint, and claims each unseen one.
 *
 * @param paths sessionPaths of the session.
 * @param session { sessionId, appId, endpoint (the cached endpoint record),
 *   subagent (leave user notices to the main session), log }.
 * @returns { watermark, notices (claimed, oldest first), found, deferred,
 *   leftForMain, commit({ shown, complete }), release() }. commit records
 *   `shown` entries, then consumes the watermark only when its own notice was
 *   found, nothing is held elsewhere or left for the main session, `complete`
 *   (the caller showed or staged every notice) and every shown record landed
 *   (a busy lock fails one: logged, counted in `unrecorded`); it then
 *   releases the claims. release() alone ends the claims unshown (call it in
 *   a finally).
 */
export function readUnseenNotices(paths, session) {
  const watermark = readWatermark(paths);
  const owned = watermark ? safeOwnedNotices(paths, session) : [];
  const eligible = session.subagent
    ? owned.filter((notice) => !isUserNotice(notice))
    : owned;
  const leftForMain = owned.length - eligible.length;
  // Before claiming: the shown ledger must be read as it was before this hook.
  const identity = watermark ? watermarkIdentity(watermark) : {};
  const isShown = shownSnapshot(paths);
  const found = owned.some((notice) =>
    isWatermarkNotice(isShown, notice, identity),
  );
  const { claimed, deferred } = claimUnseen(paths, isShown, eligible);
  const release = () => {
    for (const notice of claimed)
      releaseNotice(paths, notice.message_id, notice.attempt);
  };
  const commit = ({ shown = [], complete = true } = {}) => {
    // Shown is recorded first: a watermark consumed past an unrecorded notice lets the drain stage it again.
    const unrecorded = shown.filter(
      (entry) => !markNoticeShown(paths, entry.message_id, entry.attempt),
    );
    if (unrecorded.length > 0)
      session.log({
        event: "local_notice_shown_unrecorded",
        session_id: session.sessionId,
        params: { message_ids: unrecorded.map((entry) => entry.message_id) },
        result: { reason: "scratch_lock_busy", consumed: false },
        status: "warn",
      });
    const nothingPending = leftForMain + deferred + unrecorded.length === 0;
    const consumed = found && complete && nothingPending;
    if (consumed) markCapturedWatermarkSeen(paths, watermark);
    release();
    return { consumed, unrecorded: unrecorded.length };
  };
  return {
    watermark,
    notices: claimed,
    found,
    deferred,
    leftForMain,
    commit,
    release,
  };
}

/**
 * The foreground Claude PreToolUse on a changed watermark (never Copilot or
 * the detached worker). A main-session user notice that takes a refusal slot
 * is the exit-2 refusal; every other notice is staged for PostToolUse. Opens
 * no daemon connection and hands the drain to the detached worker.
 * `remediation` (R6: the shell classified the call as receive, reply, ack,
 * park, complete or cancel) never refuses: every notice is staged, unshown,
 * for this call's PostToolUse.
 * deps: readCache, appendStagedEntry, stagedNotificationEntry.
 */
export function localPreToolUse(
  ctx,
  { stateRoot, runtime, payload, detach, remediation = false, deps, log },
) {
  const startedAt = performance.now();
  const subagent = Boolean(ctx.payload?.agent_id);
  const read = readUnseenNotices(ctx.paths, {
    sessionId: ctx.identity.session_id,
    appId: ctx.app_id,
    endpoint: deps.readCache(ctx.paths),
    subagent,
    log,
  });
  try {
    const entries = read.notices.map((notice) =>
      deps.stagedNotificationEntry(notice.attempt, notice),
    );
    const reserved = remediation
      ? []
      : reserveNoticeRefusals(ctx, entries, log);
    for (const entry of entries)
      if (!reserved.includes(entry)) deps.appendStagedEntry(ctx.paths, entry);
    const block = withBodyPrefix(reserved);
    // The subset of what is rendered (bodies dropped after the first bodiless entry change the sizes).
    const shown = shownEntries(block, { prefix: ctx.recipePrefix });
    // Before the commit. The runtime acts only on exit 2, so a crash before exit loses this
    // call's refusal in either order; written first, a notice whose commit fails is shown
    // again at a later boundary instead of being recorded shown and never seen.
    if (reserved.length > 0) {
      const text = renderNotification(block, { prefix: ctx.recipePrefix, log });
      showNoticeRefusal(ctx, text);
    }
    const { consumed, unrecorded } = read.commit({
      shown,
      complete: shown.length === reserved.length,
    });
    // An unrecorded shown notice skips the drain: it would stage it again for this call's PostToolUse.
    const handoff =
      read.watermark !== null &&
      !(subagent && read.leftForMain > 0) &&
      unrecorded === 0;
    if (handoff)
      detachPreToolUse({
        ctx,
        stateRoot,
        runtime,
        payload,
        detach,
        reason: "drain",
        log,
      });
    log({
      event: "local_notice_result",
      session_id: ctx.identity.session_id,
      params: { subagent, remediation },
      result: {
        notices: entries.length,
        refused: reserved.length,
        deferred: read.deferred,
        left_for_main: read.leftForMain,
        found: read.found,
        consumed,
        unrecorded,
        detached: handoff,
      },
      latency: Math.round(performance.now() - startedAt),
    });
    return {
      staged: entries.length - reserved.length,
      refused: reserved.length > 0,
      message_ids: entries.map((entry) => entry.message_id),
      detached: true,
    };
  } finally {
    read.release();
  }
}
