import { reserveBeaconRegistration } from "./tldr_agent_beacon_marker.mjs";
import { readBeaconMessageEvidence } from "./tldr_agent_beacon_message_evidence.mjs";
import { dispatchTldrAgentMessage } from "./tldr_agent_message_dispatch.mjs";
import { checkRuntimeStoreReadiness } from "./runtime_store.mjs";
import { assertOwningSessionForReply } from "./substrate/thread_ownership.mjs";

export const BEACON_FALLBACK_SUBJECT = "tldr; outcome follow-up";

const CONFIRMATION_PREFIX =
  "tldr; registered this follow-up. I am working on:\n\n";
const CONFIRMATION_SUFFIX =
  "\n\nI will email the outcome in this thread when the work is finished.";

function nonempty(value) {
  return typeof value === "string" && value.trim() !== "";
}

function failure(code, retryable = false) {
  return { ok: false, error: { code, retryable } };
}

function escapedSummary(summary) {
  return String(summary)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "�")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export function renderBeaconConfirmation(summary) {
  if (!nonempty(summary)) {
    throw new TypeError("Beacon confirmation summary is required");
  }
  return `${CONFIRMATION_PREFIX}${escapedSummary(summary)}${CONFIRMATION_SUFFIX}`;
}

function markerOptions(options) {
  return {
    home: options.home,
    path: options.path,
    now: options.now,
    retryMs: options.retryMs,
    intervalMs: options.intervalMs,
    createObligationId: options.createObligationId,
    createThreadId: options.createThreadId,
    createConfirmationMessageId: options.createConfirmationMessageId,
  };
}

function evidenceOptions(input, options) {
  return {
    scope: input.scope,
    sessionId: input.sessionId,
    owner: input.owner,
    home: options.home,
    path: options.path,
  };
}

function evidenceFailure(evidence) {
  if (evidence === "ambiguous") {
    return failure("FOLLOWUP_DELIVERY_AMBIGUOUS");
  }
  if (evidence === "mismatch") {
    return failure("FOLLOWUP_REGISTRATION_CONFLICT");
  }
  return failure("FOLLOWUP_NOT_CONFIRMED", evidence === "failed_definite");
}

function registrationResult(marker) {
  return {
    ok: true,
    data: {
      obligationId: marker.obligationId,
      boundThreadId: marker.boundThreadId,
      confirmationMessageId: marker.confirmationMessageId,
      status: "pending",
    },
  };
}

function validInput(input) {
  const hasOrigin =
    input?.originThreadId !== null && input?.originThreadId !== undefined;
  return (
    input?.scope &&
    nonempty(input.scope.scope_id) &&
    nonempty(input.sessionId) &&
    nonempty(input.owner) &&
    nonempty(input.registrationKey) &&
    nonempty(input.summary) &&
    input.runtimeReady !== false &&
    (!hasOrigin || nonempty(input.originThreadId)) &&
    (hasOrigin
      ? input.subject === null || input.subject === undefined
      : input.subject === null ||
        input.subject === undefined ||
        nonempty(input.subject))
  );
}

export async function requireBeaconFollowup(input, options = {}) {
  if (!validInput(input)) return failure("ARGUMENT_INVALID");

  const checkStore = options.checkStoreReadiness ?? checkRuntimeStoreReadiness;
  let readiness;
  try {
    readiness = checkStore({ home: options.home, path: options.path });
  } catch {
    return failure("FOLLOWUP_STORE_BUSY", true);
  }
  if (!readiness?.ok) return failure("FOLLOWUP_STORE_BUSY", true);

  const originThreadId = input.originThreadId ?? null;
  if (originThreadId) {
    const assertOwnership =
      options.assertThreadOwnership ?? assertOwningSessionForReply;
    let ownership;
    try {
      ownership = assertOwnership(input.scope, originThreadId, input.sessionId);
    } catch {
      return failure("THREAD_UNKNOWN");
    }
    if (!ownership?.ok) {
      return failure(
        ownership?.reason === "thread_owner_missing"
          ? "THREAD_UNKNOWN"
          : "THREAD_OWNER_MISMATCH",
      );
    }
  }

  const reserve = options.reserveRegistration ?? reserveBeaconRegistration;
  const reserved = reserve(
    {
      scopeId: input.scope.scope_id,
      sessionId: input.sessionId,
      registrationKey: input.registrationKey,
      originThreadId,
    },
    markerOptions(options),
  );
  if (!reserved?.ok) return reserved;
  const marker = reserved.marker;

  const readEvidence = options.readMessageEvidence ?? readBeaconMessageEvidence;
  const read = () =>
    readEvidence(marker, "confirmation", evidenceOptions(input, options));
  const priorEvidence = read();
  if (priorEvidence === "mismatch") return evidenceFailure(priorEvidence);

  const subject = originThreadId
    ? undefined
    : input.subject === null || input.subject === undefined
      ? BEACON_FALLBACK_SUBJECT
      : input.subject;
  const dispatch = options.dispatchMessage ?? dispatchTldrAgentMessage;
  let delivery;
  try {
    delivery = await dispatch({
      kind: originThreadId ? "reply" : "new",
      owner: input.owner,
      sessionId: input.sessionId,
      scope: input.scope,
      threadId: marker.boundThreadId,
      messageId: marker.confirmationMessageId,
      purpose: "beacon_confirmation",
      obligationId: marker.obligationId,
      subject,
      body: renderBeaconConfirmation(input.summary),
      home: options.home,
      reclaimFailedDefinite: priorEvidence === "failed_definite",
    });
  } catch {
    return evidenceFailure(read());
  }
  if (!delivery?.ok) {
    if (delivery?.error?.code === "beacon_obligation_not_pending") {
      return failure("FOLLOWUP_ALREADY_RESOLVED");
    }
    if (delivery?.error?.code === "idempotency_collision") {
      return failure("FOLLOWUP_REGISTRATION_CONFLICT");
    }
    return evidenceFailure(read());
  }

  const evidence = read();
  return evidence === "accepted"
    ? registrationResult(marker)
    : evidenceFailure(evidence);
}
