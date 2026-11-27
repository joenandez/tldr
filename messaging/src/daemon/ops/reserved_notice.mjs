// Daemon-owned `metadata.notice` values: tier 0 at claim time (delivery_priority.mjs TIER_NOTICES)
// and, for "busy", the Slack thread-lock bypass. Only the daemon's own staging (stageOriginNotice,
// which inserts the row directly) may write them; a client commit is refused (r3 finding 3).
import { TightbeamError } from "../../protocol/envelope.mjs";
import { validateMetadata } from "./message_shared.mjs";

export const RESERVED_NOTICES = Object.freeze([
  "busy",
  "resume_failed",
  "holder_failed",
]);

// Daemon-owned idempotency key prefixes: holder death reads its retry and terminal markers, and
// the resume-failure notice that already told a requester, by key (holder_failed_notice.mjs), so
// a client key with these prefixes could pre-empt or silence them.
export const RESERVED_KEY_PREFIXES = Object.freeze([
  "holder-retry:",
  "holder-limit:",
  "holder-failed:",
  "resume-failure:",
]);

// The daemon notes meant for the holder alone: its cut-off and limit notes. A conversation read
// shows them to the endpoints they were delivered to and to nobody else (the requester's view).
const HOLDER_ONLY_KEY_PREFIXES = ["holder-retry:", "holder-limit:"];

/**
 * SQL for a read of conversation messages aliased `alias`: true unless the message is a
 * holder-only note that none of `endpointIds` holds a delivery for. Bind `endpointIds` after it.
 */
export function holderNoteVisibleSql(alias, endpointIds) {
  const marks = endpointIds.map(() => "?").join(", ");
  const holderOnly = HOLDER_ONLY_KEY_PREFIXES.map(
    (prefix) =>
      `substr(${alias}.idempotency_key, 1, ${prefix.length}) = '${prefix}'`,
  ).join(" OR ");
  return `(NOT (${holderOnly}) OR EXISTS (SELECT 1 FROM deliveries hd WHERE hd.message_id = ${alias}.id AND hd.endpoint_id IN (${marks})))`;
}

/** message.commit's metadata and key check: no reserved notice value, no reserved key prefix. */
export function validateCommitMetadata(metadata, idempotencyKey) {
  if (
    RESERVED_KEY_PREFIXES.some((prefix) => idempotencyKey?.startsWith(prefix))
  ) {
    throw new TightbeamError(
      "malformed_request",
      `idempotency_key "${idempotencyKey}" uses a prefix reserved for daemon notices`,
      { field: "idempotency_key", reason: "reserved_key" },
    );
  }
  validateMetadata(metadata);
  const notice = metadata?.notice;
  if (RESERVED_NOTICES.includes(notice)) {
    throw new TightbeamError(
      "malformed_request",
      `metadata.notice "${notice}" is reserved for daemon notices`,
      {
        field: "metadata.notice",
        reason: "reserved_notice",
      },
    );
  }
}
