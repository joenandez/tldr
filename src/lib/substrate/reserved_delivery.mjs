const PURPOSES = new Set(["beacon_confirmation", "beacon_terminal"]);
const OUTCOMES = new Set(["success", "failure", "blocked"]);
const RESERVATION_KEYS = new Set([
  "message_id",
  "thread_id",
  "obligation_id",
  "purpose",
  "terminal_outcome",
]);
const METADATA_KEYS = ["obligation_id", "purpose", "terminal_outcome"];

function invalid(reason) {
  return {
    ok: false,
    error: {
      code: "beacon_delivery_reservation_invalid",
      message: `Reserved Beacon delivery refused: ${reason}.`,
      hint: "Use the exact reserved message, bound thread, obligation, and lifecycle purpose.",
    },
  };
}

function nonempty(value) {
  return typeof value === "string" && value.trim() === value && value !== "";
}

function containsReservedMetadata(metadata) {
  return METADATA_KEYS.some((key) => metadata?.[key] !== undefined);
}

export function applyReservedDelivery({ kind, payload = {}, opts = {} }) {
  const reservation = opts.reserved_delivery;
  if (!reservation) {
    return containsReservedMetadata(payload.metadata)
      ? invalid("lifecycle metadata requires a canonical reservation")
      : { ok: true, payload, opts, messageId: null };
  }
  if (
    typeof reservation !== "object" ||
    Object.keys(reservation).some((key) => !RESERVATION_KEYS.has(key))
  ) {
    return invalid("reservation fields are not allowlisted");
  }
  const { message_id, thread_id, obligation_id, purpose, terminal_outcome } =
    reservation;
  if (![message_id, thread_id, obligation_id].every(nonempty)) {
    return invalid("message, thread, and obligation pointers are required");
  }
  if (!PURPOSES.has(purpose))
    return invalid("lifecycle purpose is not allowed");
  if (purpose === "beacon_terminal") {
    if (kind !== "reply" || !OUTCOMES.has(terminal_outcome)) {
      return invalid("terminal delivery requires a valid reply outcome");
    }
  } else if (terminal_outcome !== null && terminal_outcome !== undefined) {
    return invalid("confirmation delivery cannot carry a terminal outcome");
  }
  if (containsReservedMetadata(payload.metadata)) {
    return invalid("lifecycle metadata must come from the reservation seam");
  }
  if (opts.thread_id && opts.thread_id !== thread_id) {
    return invalid("bound thread pointer changed");
  }
  const idempotencyKey = `beacon:${message_id}`;
  if (opts.idempotency_key && opts.idempotency_key !== idempotencyKey) {
    return invalid("canonical idempotency identity was overridden");
  }
  const { reserved_delivery: _reserved, ...canonicalOpts } = opts;
  return {
    ok: true,
    messageId: message_id,
    payload: {
      ...payload,
      metadata: {
        ...(payload.metadata || {}),
        obligation_id,
        purpose,
        ...(terminal_outcome ? { terminal_outcome } : {}),
      },
    },
    opts: {
      ...canonicalOpts,
      message_id,
      thread_id,
      idempotency_key: idempotencyKey,
    },
  };
}
