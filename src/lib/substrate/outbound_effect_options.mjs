import { prepareBeaconOutboundEffect } from "../tldr_agent_beacon_outbound_effect.mjs";

export function isBeaconOutboundEffect(finalRow) {
  return ["beacon_confirmation", "beacon_terminal"].includes(
    finalRow.metadata?.purpose,
  );
}

export function isBeaconFailedDefiniteRetry(finalRow, config = {}) {
  return (
    config.reclaim_failed_definite === true && isBeaconOutboundEffect(finalRow)
  );
}

export function prepareCanonicalOutboundEffect(finalRow, config = {}) {
  const beaconClaim = ["beacon_confirmation", "beacon_terminal"].includes(
    finalRow.metadata?.purpose,
  )
    ? {
        kind: "beacon_delivery_pending",
        purpose: finalRow.metadata?.purpose,
        scopeId: finalRow.workspace_id,
        sessionId:
          finalRow.metadata?.originator_session_id ||
          finalRow.metadata?.session_id,
        obligationId: finalRow.metadata?.obligation_id,
        messageId: finalRow.message_id,
      }
    : null;
  return prepareBeaconOutboundEffect({
    home: config.home,
    namespace: config.namespace || "substrate_message",
    logicalRunKey: config.logical_run_key || null,
    logicalEventKey:
      config.logical_event_key ||
      config.logicalEventKey ||
      finalRow.idempotency_key ||
      finalRow.message_id,
    effect: config.effect || "message",
    channel: finalRow.transport,
    recipient: config.recipient || finalRow.target,
    payload: {
      kind: finalRow.kind,
      target: finalRow.target,
      subject: finalRow.subject,
      body: finalRow.body,
    },
    renderInputs: {
      workspace_id: finalRow.workspace_id,
      scheduled_for: finalRow.scheduled_for,
    },
    templateVersion: config.template_version || config.templateVersion || null,
    reclaimFailedDefinite: isBeaconFailedDefiniteRetry(finalRow, config),
    claimGuard: beaconClaim,
  });
}
