// The daemon's local session notice (contract C5): one owner-bound
// JSON line (carrying the capped body of a user's own message, nothing else's) per exact presentation in `<session dir>/inbox.notices.jsonl`, so
// a PreToolUse hook can show a new message without contacting the daemon.
// Written only after the enclosing transaction commits and only for a delivery
// the session's current owner may receive now (the live-session receipt rule,
// message_receive_live.mjs). The watermark is written in the transaction, as
// on base. Hint-only sites (adoption, admission retry) write the watermark alone.
//
// Format: append-only, one complete line per write, in delivery order. A
// reader skips a torn last line and bounds its work by reading the tail.

import fs from "node:fs";
import path from "node:path";

import { afterCommit } from "../db.mjs";
import {
  isSafeSessionId,
  markMessagingUsed,
  sessionPaths,
} from "../../protocol/session_paths.mjs";
import { refreshSessionWatermark } from "./message_shared.mjs";
import { earlierAdmittedExistsSql } from "./delivery_admission.mjs";
import { notificationContext } from "./notification_context.mjs";
import { MAX_BODY_CHARS } from "../../cli/arrival_notification.mjs";
import { isEndpointOwnerGone, ownerGoneSql } from "../listener_owner_loss.mjs";

// shortcut: a fixed size cap, not a ledger; consumers dedupe by (id, attempt), so dropping old lines is safe.
export const NOTICE_FILE_MAX_BYTES = 64 * 1024;

// Primary-key lookup: bounded, and it re-checks after commit that the row is
// still unread and nonfailed on the session's current owner, and that it is the
// endpoint's admission head (openOldestUnreadAdmission, admissionHead): a later
// one is noticed when receiving the one before it opens its admission.
function exactDelivery(db, { deliveryId, sessionId }) {
  return db
    .prepare(
      `SELECT d.id AS delivery_id, d.message_id, d.retry_armed_at,
              m.origin = 'inbound' AND m.origin_channel_route_id IS NOT NULL AS has_external_origin,
              e.created_by_app_id AS app_id, e.id AS endpoint_id, e.provider_session_id, e.process_generation
         FROM deliveries d
         JOIN messages m ON m.id = d.message_id
         JOIN endpoints e ON e.id = d.endpoint_id
        WHERE d.id = ? AND d.read_at IS NULL AND d.state != 'failed'
          AND e.provider_session_id = ? AND e.state IN ('idle', 'busy')
          AND NOT ${ownerGoneSql("e")}
          AND NOT ${earlierAdmittedExistsSql("d", "older", "older.endpoint_id = d.endpoint_id AND older.state != 'failed' AND older.read_at IS NULL AND older.admitted_at IS NULL")}`,
    )
    .get(deliveryId, sessionId);
}

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null; // a torn line or an unreadable watermark: nothing to protect
  }
};

// Atomic rewrite (temp + rename) so a reader never sees a partial file.
// Keeps whole lines only, newest first, within half the cap: the next trim is dozens of notices away and the file stays inside the hook's tail window.
// The line the current watermark points to (delivery_id and attempt) is never dropped, even when it is older than that window.
// An older, unshown line that falls off is caught by the detached drain, which stages it from the daemon.
// Exported for the test: in a live append the watermark already points at the newest line.
export function trimNoticeFile(file, watermarkFile) {
  if (fs.statSync(file).size <= NOTICE_FILE_MAX_BYTES) return;
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  let bytes = 0;
  let keepFrom = lines.length;
  while (keepFrom > 0) {
    bytes += Buffer.byteLength(lines[keepFrom - 1]) + 1;
    if (bytes > NOTICE_FILE_MAX_BYTES / 2) break;
    keepFrom -= 1;
  }
  // The newest line is always kept, even if it alone exceeds the half cap.
  keepFrom = Math.min(keepFrom, lines.length - 1);
  const kept = lines.slice(keepFrom);
  const mark = fs.existsSync(watermarkFile)
    ? parseJson(fs.readFileSync(watermarkFile, "utf8").trim())
    : null;
  const protectedLine =
    mark?.delivery_id &&
    lines.slice(0, keepFrom).findLast((line) => {
      const notice = parseJson(line);
      return (
        notice?.delivery_id === mark.delivery_id &&
        (!mark.attempt || notice.attempt === mark.attempt)
      );
    });
  if (protectedLine) kept.unshift(protectedLine);
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.tmp`);
  fs.writeFileSync(temp, `${kept.join("\n")}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

// The watermark carries the same value, so the hook matches it to this line by (delivery_id, attempt).
// A retry armed between commit and this write makes the line say "retry" under an "initial" watermark: safe, the mismatch counts as not found and the drain stages it.
const noticeAttempt = (delivery) =>
  delivery.retry_armed_at ? "retry" : "initial";

// ac-kf9rt review v2: a body is presented only to an endpoint whose owning app holds read_inbox.
export const endpointReadsInbox = (db, endpointId) =>
  Boolean(
    db
      .prepare(
        `SELECT 1 FROM endpoints e JOIN application_permissions p
            ON p.app_id = e.created_by_app_id AND p.permission = 'read_inbox'
         WHERE e.id = ?`,
      )
      .get(endpointId),
  );

// A user's own message, cut where the renderer's cap cannot be reached by line breaks alone
// (a CRLF pair renders as one break), so a cut body always renders as cut. Typed notices and agent mail carry none.
function noticeBody(db, delivery, context) {
  if (
    !delivery.has_external_origin ||
    context.notice ||
    !endpointReadsInbox(db, delivery.endpoint_id)
  )
    return {};
  const row = db
    .prepare("SELECT body FROM messages WHERE id = ?")
    .get(delivery.message_id);
  return typeof row?.body === "string" && row.body !== ""
    ? { body: row.body.slice(0, 2 * MAX_BODY_CHARS + 2) }
    : {};
}

function writeNotice(db, delivery, { stateRoot, sessionId, logger }) {
  const context = notificationContext(db, delivery.message_id, {
    deliveryId: delivery.delivery_id,
  });
  const notice = {
    delivery_id: delivery.delivery_id,
    message_id: delivery.message_id,
    attempt: noticeAttempt(delivery),
    has_external_origin: Boolean(delivery.has_external_origin),
    ...context,
    ...noticeBody(db, delivery, context),
    app_id: delivery.app_id,
    endpoint_id: delivery.endpoint_id,
    provider_session_id: delivery.provider_session_id,
    process_generation: delivery.process_generation,
  };
  const paths = sessionPaths(stateRoot, sessionId);
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  // One write per line: a crash leaves at most a torn last line for readers to skip.
  fs.appendFileSync(paths.notices, `${JSON.stringify(notice)}\n`, {
    mode: 0o600,
  });
  markMessagingUsed(paths, { logger: (entry) => logger?.warn?.(entry) });
  // After the marker: a failed trim only leaves the file long; it must not skip the marker.
  try {
    trimNoticeFile(paths.notices, paths.watermark);
  } catch (err) {
    logger?.warn?.({
      event: "session_notice_trim_failed",
      params: { session_id: sessionId, delivery_id: delivery.delivery_id },
      status: "warn",
      error: err.message,
      stack: err.stack,
    });
  }
  logger?.debug?.({
    event: "session_notice_appended",
    params: {
      session_id: sessionId,
      delivery_id: delivery.delivery_id,
      message_id: delivery.message_id,
    },
    status: "ok",
  });
}

/**
 * Appends the notice for one delivery. Best effort: any failure logs a warn;
 * it never throws into the committed delivery.
 */
export function appendSessionNotice(
  db,
  { stateRoot, sessionId, deliveryId, expectedGeneration, logger },
) {
  if (!stateRoot || !isSafeSessionId(sessionId)) return;
  try {
    const delivery = exactDelivery(db, { deliveryId, sessionId });
    if (
      delivery &&
      expectedGeneration !== undefined &&
      delivery.process_generation !== expectedGeneration
    )
      logger?.debug?.({
        event: "session_notice_skipped",
        params: { session_id: sessionId, delivery_id: deliveryId },
        result: { reason: "process_generation_changed" },
        status: "ok",
      });
    else if (delivery)
      writeNotice(db, delivery, { stateRoot, sessionId, logger });
    else
      logger?.debug?.({
        event: "session_notice_skipped",
        params: { session_id: sessionId, delivery_id: deliveryId },
        result: { reason: "not_receivable_by_current_owner" },
        status: "ok",
      });
  } catch (err) {
    logger?.warn?.({
      event: "session_notice_write_failed",
      params: { session_id: sessionId, delivery_id: deliveryId },
      result: { error: err.message },
      status: "warn",
      stack: err.stack,
    });
  }
}

/**
 * An exact presentation site: the watermark is written in the transaction, as
 * before the notice existed, so a crash between COMMIT and the notice still
 * leaves the hook a change to drain. Only the notice waits for commit (a
 * phantom notice is the harmful case); a rollback drops it.
 */
export function publishSessionNotice(
  db,
  { stateRoot, sessionId, deliveryId, wake = null, logger },
) {
  const row = db
    .prepare(
      "SELECT e.process_generation, d.retry_armed_at FROM deliveries d JOIN endpoints e ON e.id = d.endpoint_id WHERE d.id = ?",
    )
    .get(deliveryId);
  const expectedGeneration = row?.process_generation;
  refreshSessionWatermark({
    stateRoot,
    sessionId,
    deliveryId,
    attempt: row && noticeAttempt(row),
    wake,
    logger,
  });
  afterCommit(
    db,
    () =>
      appendSessionNotice(db, {
        stateRoot,
        sessionId,
        deliveryId,
        expectedGeneration,
        logger,
      }),
    logger,
  );
}

/**
 * A listener's pending presentation was just marked missed: the delivery stays
 * unread, so the same session reads it at its next tool boundary, but only
 * while that same session and generation can still drain it.
 */
export function publishMissedPresentation(
  db,
  { stateRoot, logger, listener, deliveryId },
) {
  const endpoint = db
    .prepare(
      "SELECT state, provider_session_id, process_generation, owner_process_exited_at, launch_mode FROM endpoints WHERE id = ?",
    )
    .get(listener.endpoint_id);
  const sameCurrentOwner = [
    ["idle", "busy"].includes(endpoint?.state),
    endpoint && !isEndpointOwnerGone(endpoint),
    endpoint?.provider_session_id === listener.provider_session_id,
    endpoint?.process_generation === listener.process_generation,
  ].every(Boolean);
  if (!sameCurrentOwner) return;
  publishSessionNotice(db, {
    stateRoot,
    sessionId: endpoint.provider_session_id,
    deliveryId,
    logger,
  });
}

/**
 * A routed delivery: only an enqueued row is presented at the session's tool
 * boundary, so only it gets the notice. A parked listener or a resume
 * presents the rest; they ring the watermark alone.
 */
export function publishRoutedDelivery(db, route, watermark) {
  if (route === "enqueue_only") publishSessionNotice(db, watermark);
  else refreshSessionWatermark(watermark);
}
