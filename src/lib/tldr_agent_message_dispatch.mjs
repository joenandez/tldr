import { withBeaconLifecycleMutexAsync } from "./tldr_agent_beacon_marker.mjs";

function reservedDelivery(input) {
  const values = [
    input.messageId,
    input.purpose,
    input.obligationId,
    input.terminalOutcome,
  ];
  if (values.every((value) => value === null || value === undefined)) {
    return null;
  }
  return {
    message_id: input.messageId,
    thread_id: input.threadId,
    obligation_id: input.obligationId,
    purpose: input.purpose,
    terminal_outcome: input.terminalOutcome,
  };
}

export async function dispatchTldrAgentMessage(input) {
  await import("./transports/email.mjs");
  const { message } = await import("./substrate/kernel.mjs");
  const dispatch = () =>
    message({
      kind: input.kind,
      target: `email://${input.owner}`,
      schedule: { type: "now" },
      payload: {
        subject: input.subject,
        body: input.body,
        metadata: {
          session_id: input.sessionId,
          originator_session_id: input.sessionId,
          ...(input.emailState
            ? { tldr_agent_email_state: input.emailState }
            : {}),
          ...(input.replyInstruction
            ? { reply_instruction: input.replyInstruction }
            : {}),
          ...(input.securityNotice
            ? { security_notice: input.securityNotice }
            : {}),
        },
      },
      scope: input.scope,
      opts: {
        thread_id: input.threadId,
        sender_session_id: input.sessionId,
        idempotency_key: input.idempotencyKey,
        tldr_agent_reply_candidate: input.tldrAgentReplyCandidate === true,
        reserved_delivery: reservedDelivery(input),
        outbound_effect: {
          home: input.home,
          reclaim_failed_definite: input.reclaimFailedDefinite === true,
        },
      },
    });
  if (input.purpose !== "beacon_terminal") return dispatch();
  return withBeaconLifecycleMutexAsync(
    {
      scopeId: input.scope.scope_id,
      sessionId: input.sessionId,
      obligationId: input.obligationId,
    },
    {
      home: input.home,
      path: input.path,
      mutexOptions: input.mutexOptions,
    },
    dispatch,
  );
}
