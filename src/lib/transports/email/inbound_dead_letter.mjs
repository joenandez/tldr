// Opportunity #1 (reliability review 2026-06-11): durable dead-letter ledger
// for inbounds that could not be persisted into any scope. A scope-null
// inbound used to be silently reported as success (suppressing AgentMail's
// provider retry) while nothing was written anywhere.
import { join } from "node:path";
import { appendJsonLine, helmHome } from "../../store.mjs";
import { appendActivityEvent } from "../../tldr_agent_diagnostics.mjs";

export function inboundDeadLetterPath() {
  // helmHome() (not identity's getHelmHome) so HELM_HOME isolation holds.
  return join(helmHome(), "email", "dead-letter.jsonl");
}

export function deadLetterInbound({ payload, reason, startedAt }) {
  const record = {
    at: new Date().toISOString(),
    reason,
    external_id: payload?.messageId || null,
    external_thread_id: payload?.threadId || null,
    from:
      typeof payload?.from === "string"
        ? payload.from
        : payload?.from?.address || null,
    subject: payload?.subject || null,
    text_preview:
      typeof payload?.text === "string" ? payload.text.slice(0, 500) : null,
  };
  appendJsonLine(inboundDeadLetterPath(), record, { durable: true });
  appendActivityEvent({
    type: "transport_email_inbound_dead_lettered",
    level: "error",
    scope_id: null,
    cwd: null,
    duration_ms: Date.now() - startedAt,
    data: {
      transport: "email",
      reason,
      external_id: record.external_id,
      external_thread_id: record.external_thread_id,
      ledger_path: inboundDeadLetterPath(),
    },
  });
  return record;
}
