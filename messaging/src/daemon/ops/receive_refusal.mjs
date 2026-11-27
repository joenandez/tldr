// What message.receive answers when no receipt path matched (ac-jfv.171).
// A bare "not granted" left agents asking the user to resend; each case an
// agent can act on gets its own reason and words. All read-only.

import { TightbeamError } from "../../protocol/envelope.mjs";

// The caller's endpoint has no row for the message; another endpoint of the
// same principal (another session of this agent) does.
function heldByOtherSession(db, input) {
  return Boolean(
    db
      .prepare(
        `SELECT 1
           FROM endpoints e
           JOIN endpoints other ON other.principal_id = e.principal_id AND other.id != e.id
           JOIN deliveries od ON od.endpoint_id = other.id AND od.message_id = ? AND od.state != 'failed'
          WHERE e.id = ?
            AND NOT EXISTS (SELECT 1 FROM deliveries own WHERE own.endpoint_id = e.id AND own.message_id = ? AND own.state != 'failed')
          LIMIT 1`,
      )
      .get(input.message_id, input.endpoint_id, input.message_id),
  );
}

// No endpoint of the caller's principal was ever sent this message: it is
// another agent's, or one this agent sent.
function notSentToAgent(db, input) {
  return !db
    .prepare(
      `SELECT 1 FROM endpoints e
         JOIN endpoints any_e ON any_e.principal_id = e.principal_id
         JOIN deliveries d ON d.endpoint_id = any_e.id AND d.message_id = ?
        WHERE e.id = ? LIMIT 1`,
    )
    .get(input.message_id, input.endpoint_id);
}

const REFUSAL_CHECKS = [
  ["endpoint_unknown", (db, input, endpoint) => !endpoint],
  [
    "endpoint_takeover_pending",
    (db, input, endpoint) => endpoint.state === "takeover_pending",
  ],
  [
    "process_generation_stale",
    (db, input, endpoint) =>
      endpoint.process_generation !== input.process_generation,
  ],
  ["endpoint_dead", (db, input, endpoint) => endpoint.state === "dead"],
  [
    "message_unknown",
    (db, input) =>
      !db.prepare("SELECT 1 FROM messages WHERE id = ?").get(input.message_id),
  ],
  [
    "already_received",
    (db, input) =>
      db
        .prepare(
          "SELECT 1 FROM deliveries WHERE endpoint_id = ? AND message_id = ? AND state != 'failed' AND read_at IS NOT NULL",
        )
        .get(input.endpoint_id, input.message_id),
  ],
  ["received_by_other_session", (db, input) => heldByOtherSession(db, input)],
  ["not_a_recipient", (db, input) => notSentToAgent(db, input)],
];

/** The first matching refusal reason, else no_receipt_path. */
export function refusalReason(db, input, endpoint) {
  return (
    REFUSAL_CHECKS.find(([, matches]) => matches(db, input, endpoint))?.[0] ??
    "no_receipt_path"
  );
}

const ANSWERS = {
  already_received:
    "this message was already received here, so there is nothing new to receive: take no action and do not ask for a resend",
  received_by_other_session:
    "another session of this agent holds this message, so this session has nothing to receive: take no action and do not ask for a resend",
  not_a_recipient:
    "this message was not delivered to this agent (it is addressed to another agent, or this agent sent it), so there is nothing to receive: take no action",
};

/** The refusal an agent can act on for `reason`, or null for the generic one. */
export function answeredRefusal(reason, messageId) {
  const text = ANSWERS[reason];
  return text
    ? new TightbeamError("permission_denied", text, {
        reason,
        message_id: messageId,
      })
    : null;
}
