import {
  assignBeaconTerminal,
  readBeaconObligation,
} from "./tldr_agent_beacon_marker.mjs";
import {
  readBeaconMessageEvidence,
  reconcileBeaconObligation,
} from "./tldr_agent_beacon_message_evidence.mjs";
import { dispatchTldrAgentMessage } from "./tldr_agent_message_dispatch.mjs";

const TERMINAL_OUTCOMES = new Set(["success", "failure", "blocked"]);

function nonempty(value) {
  return typeof value === "string" && value.trim() !== "";
}

function failure(code, retryable = false) {
  return { ok: false, error: { code, retryable } };
}

function markerOptions(options) {
  return {
    home: options.home,
    path: options.path,
    now: options.now,
    retryMs: options.retryMs,
    intervalMs: options.intervalMs,
    createTerminalMessageId: options.createTerminalMessageId,
  };
}

function evidenceOptions(input, options) {
  return {
    scope: input.scope,
    sessionId: input.sessionId,
    owner: input.owner,
    home: options.home,
    path: options.path,
    mutexOptions: options.mutexOptions,
  };
}

function evidenceFailure(evidence, mismatchCode) {
  if (evidence === "ambiguous") {
    return failure("FOLLOWUP_DELIVERY_AMBIGUOUS");
  }
  if (evidence === "mismatch") return failure(mismatchCode);
  return failure("FOLLOWUP_NOT_CONFIRMED", evidence === "failed_definite");
}

function completionResult(marker) {
  return {
    ok: true,
    data: {
      obligationId: marker.obligationId,
      terminalMessageId: marker.terminalMessageId,
      outcome: marker.terminalOutcome,
      status: "fulfilled",
    },
  };
}

function validInput(input) {
  return (
    input?.scope &&
    nonempty(input.scope.scope_id) &&
    nonempty(input.sessionId) &&
    nonempty(input.owner) &&
    nonempty(input.obligationId) &&
    TERMINAL_OUTCOMES.has(input.outcome) &&
    nonempty(input.body)
  );
}

function assignTerminal(marker, input, options) {
  if (marker.terminalMessageId) {
    return marker.terminalOutcome === input.outcome
      ? { ok: true, marker }
      : failure("FOLLOWUP_TERMINAL_CONFLICT");
  }
  const assigned = (options.assignTerminal ?? assignBeaconTerminal)(
    {
      scopeId: input.scope.scope_id,
      sessionId: input.sessionId,
      obligationId: input.obligationId,
      outcome: input.outcome,
    },
    markerOptions(options),
  );
  return assigned?.ok ? { ok: true, marker: assigned.marker } : assigned;
}

export async function completeBeaconFollowup(input, options = {}) {
  if (!validInput(input)) return failure("ARGUMENT_INVALID");

  const readMarker = options.readObligation ?? readBeaconObligation;
  const marker = readMarker(
    {
      scopeId: input.scope.scope_id,
      sessionId: input.sessionId,
      obligationId: input.obligationId,
    },
    markerOptions(options),
  );
  if (!marker) return failure("FOLLOWUP_NOT_FOUND");
  if (marker.status === "cancelled") {
    return failure("FOLLOWUP_ALREADY_RESOLVED");
  }

  const readEvidence = options.readMessageEvidence ?? readBeaconMessageEvidence;
  const evidenceArgs = evidenceOptions(input, options);
  const confirmation = readEvidence(marker, "confirmation", evidenceArgs);
  if (confirmation !== "accepted") {
    return evidenceFailure(confirmation, "FOLLOWUP_NOT_CONFIRMED");
  }

  const assigned = assignTerminal(marker, input, options);
  if (!assigned?.ok) return assigned;
  const terminalMarker = assigned.marker;
  const priorEvidence = readEvidence(terminalMarker, "terminal", evidenceArgs);
  if (priorEvidence === "mismatch") {
    return failure("FOLLOWUP_TERMINAL_CONFLICT");
  }
  if (priorEvidence === "ambiguous") {
    return failure("FOLLOWUP_DELIVERY_AMBIGUOUS");
  }

  const dispatch = options.dispatchMessage ?? dispatchTldrAgentMessage;
  let delivery;
  try {
    delivery = await dispatch({
      kind: "reply",
      owner: input.owner,
      sessionId: input.sessionId,
      scope: input.scope,
      threadId: terminalMarker.boundThreadId,
      messageId: terminalMarker.terminalMessageId,
      purpose: "beacon_terminal",
      obligationId: terminalMarker.obligationId,
      terminalOutcome: terminalMarker.terminalOutcome,
      subject: null,
      body: input.body,
      home: options.home,
      path: options.path,
      mutexOptions: options.mutexOptions,
      reclaimFailedDefinite: priorEvidence === "failed_definite",
    });
  } catch (error) {
    if (error?.name === "MutexTimeoutError") {
      return failure("FOLLOWUP_STORE_BUSY", true);
    }
    return evidenceFailure(
      readEvidence(terminalMarker, "terminal", evidenceArgs),
      "FOLLOWUP_TERMINAL_CONFLICT",
    );
  }
  if (!delivery?.ok) {
    if (delivery?.error?.code === "beacon_obligation_not_pending") {
      return failure("FOLLOWUP_ALREADY_RESOLVED");
    }
    if (delivery?.error?.code === "idempotency_collision") {
      return failure("FOLLOWUP_TERMINAL_CONFLICT");
    }
    return evidenceFailure(
      readEvidence(terminalMarker, "terminal", evidenceArgs),
      "FOLLOWUP_TERMINAL_CONFLICT",
    );
  }

  const terminal = readEvidence(terminalMarker, "terminal", evidenceArgs);
  if (terminal !== "accepted") {
    return evidenceFailure(terminal, "FOLLOWUP_TERMINAL_CONFLICT");
  }
  const reconcile = options.reconcileObligation ?? reconcileBeaconObligation;
  const reconciled = reconcile(terminalMarker, {
    ...evidenceArgs,
    now: options.now,
    retryMs: options.retryMs,
    intervalMs: options.intervalMs,
  });
  if (reconciled?.error) return failure(reconciled.error.code);
  return reconciled?.marker?.status === "fulfilled"
    ? completionResult(reconciled.marker)
    : evidenceFailure(reconciled?.evidence, "FOLLOWUP_TERMINAL_CONFLICT");
}
