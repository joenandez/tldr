// Daemon-owned `metadata.notice` values: tier 0 at claim time (delivery_priority.mjs TIER_NOTICES)
// and, for "busy", the Slack thread-lock bypass. Only the daemon's own staging (stageOriginNotice,
// which inserts the row directly) may write them; a client commit is refused (r3 finding 3).
import { TightbeamError } from "../../protocol/envelope.mjs";
import { validateMetadata } from "./message_shared.mjs";

export const RESERVED_NOTICES = Object.freeze(["busy", "resume_failed"]);

/** message.commit's metadata check: an object, and no reserved notice value. */
export function validateCommitMetadata(metadata) {
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
