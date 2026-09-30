const MODES = new Set(["activity", "notify", "conversation"]);

export const COMPLETION_DELIVERY_MODES = Object.freeze([...MODES]);

export function completionDeliveryInput(value, { required = false } = {}) {
  if (value === undefined || value === null) {
    return required ? { error: "required" } : { value: null };
  }
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) return { error: required ? "required" : "invalid" };
  return MODES.has(normalized) ? { value: normalized } : { error: "invalid" };
}

export function effectiveCompletionDelivery(assignment) {
  const stored = assignment?.completion_delivery;
  if (stored === undefined || stored === null) {
    return "activity";
  }
  const parsed = completionDeliveryInput(stored);
  if (parsed.error) {
    throw new Error(`invalid completion_delivery: ${String(stored)}`);
  }
  return parsed.value;
}

export function assignmentRunContract(job) {
  if (!job?.tags?.includes("assignment")) return null;
  return {
    version: 1,
    completion_delivery: effectiveCompletionDelivery(job.metadata?.assignment),
  };
}

export function completionDeliveryFromStartedEvent(event) {
  const contract = event?.payload?.assignment_run_contract;
  if (contract?.version !== 1) return null;
  const parsed = completionDeliveryInput(contract.completion_delivery);
  return parsed.value || null;
}

export function communicationStatusFor({
  completionDelivery,
  terminalWork,
  hasTerminalReport,
  hasOriginThread,
  hasCompletionMessage,
  communicationIssue,
}) {
  if (completionDelivery === "activity") return "not_required";
  if (!terminalWork) return "pending";
  return hasTerminalReport &&
    hasOriginThread &&
    hasCompletionMessage &&
    !communicationIssue
    ? "satisfied"
    : "needs_review";
}

function nullableIdentifier(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function prospectiveCommunicationProjection({
  startedEvent,
  workStatus,
  outcomeSource,
  originThreadId,
  completionMessageId,
  communicationIssue,
}) {
  const completionDelivery = completionDeliveryFromStartedEvent(startedEvent);
  if (!completionDelivery) return null;
  const origin_thread_id = nullableIdentifier(originThreadId);
  const completion_message_id = nullableIdentifier(completionMessageId);
  return {
    completion_delivery: completionDelivery,
    origin_thread_id,
    completion_message_id,
    communication_status: communicationStatusFor({
      completionDelivery,
      terminalWork: [
        "succeeded",
        "failed",
        "skipped",
        "cancelled",
        "indeterminate",
      ].includes(workStatus),
      hasTerminalReport: outcomeSource === "agent_report",
      hasOriginThread: Boolean(origin_thread_id),
      hasCompletionMessage: Boolean(completion_message_id),
      communicationIssue,
    }),
  };
}
