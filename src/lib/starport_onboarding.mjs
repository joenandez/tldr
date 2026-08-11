import { dispatchTldrAgentMessage } from "./tldr_agent_message_dispatch.mjs";
import {
  findMessageByIdempotencyKey,
  getTransportState,
} from "./substrate/canonical_store.mjs";
import { renderTldrAgentWelcomeEmail } from "./transports/email/templates.mjs";

export const WELCOME_IDEMPOTENCY_KEY = "tldr-agent-welcome:v1";

function canonicalWelcomeEvidence({ scope, idempotencyKey }) {
  const message = findMessageByIdempotencyKey(scope, idempotencyKey);
  if (!message) return "not-started";
  const transport = getTransportState(scope, message.message_id);
  if (["sent", "delivered"].includes(transport?.delivery_state)) {
    return "accepted";
  }
  if (
    transport?.delivery_state === "ambiguous" ||
    transport?.delivery_state === "pending"
  ) {
    return "ambiguous";
  }
  return transport?.delivery_state === "failed" ? "failed" : "not-started";
}

function status(value) {
  return Object.freeze({ status: value });
}

export function createStarportOnboarding({
  sessionId,
  scope,
  home = null,
  owner = "owner",
  readEvidence = canonicalWelcomeEvidence,
  dispatchMessage = dispatchTldrAgentMessage,
} = {}) {
  if (!sessionId || !scope?.scope_id) {
    throw new TypeError("Starport onboarding requires setup session and scope");
  }

  async function readStatus() {
    const evidence = await readEvidence({
      scope,
      home,
      idempotencyKey: WELCOME_IDEMPOTENCY_KEY,
    });
    return status(
      ["accepted", "ambiguous", "failed"].includes(evidence)
        ? evidence
        : "not-started",
    );
  }

  async function send() {
    const before = await readStatus();
    if (before.status === "accepted") return before;
    const template = renderTldrAgentWelcomeEmail();
    let delivery;
    try {
      delivery = await dispatchMessage({
        kind: "new",
        owner,
        sessionId,
        scope,
        subject: template.subject,
        body: template.body,
        idempotencyKey: WELCOME_IDEMPOTENCY_KEY,
        emailState: "conversation",
        replyInstruction: template.replyInstruction,
        securityNotice: template.securityNotice,
        tldrAgentReplyCandidate: true,
        home,
      });
    } catch (error) {
      return status(error?.ambiguous === true ? "ambiguous" : "failed");
    }
    if (delivery?.ok === false && delivery.error?.ambiguous !== true) {
      const afterFailure = await readStatus();
      return afterFailure.status === "not-started"
        ? status("failed")
        : afterFailure;
    }
    if (delivery?.error?.ambiguous === true) return status("ambiguous");
    const after = await readStatus();
    return after.status === "accepted" ? after : status("ambiguous");
  }

  return Object.freeze({ status: readStatus, send });
}

export const _internals = Object.freeze({ canonicalWelcomeEvidence });
