import { appendActivityEvent } from "../tldr_agent_diagnostics.mjs";
import {
  claimThreadIdentity,
  getTransportState,
  updateTransportState,
} from "./canonical_store.mjs";

export function prepareFailedDeliveryRetry({ scope, row, existing }) {
  if (!existing) return { retrying: false, begin: () => ({ ok: true }) };
  const state = getTransportState(scope, row.message_id);
  if (!["failed", "ambiguous"].includes(state?.delivery_state)) {
    return { retrying: false, begin: () => ({ ok: true }) };
  }
  return {
    retrying: true,
    begin() {
      const ownerSessionId =
        row.metadata?.originator_session_id || row.metadata?.session_id || null;
      if (row.transport === "email" && ownerSessionId) {
        const claim = claimThreadIdentity(scope, row.thread_id, ownerSessionId);
        if (!claim.ok) {
          return {
            ok: false,
            error: {
              code: claim.reason || "thread_owner_claim_failed",
              message: `Email thread ${row.thread_id} could not be reclaimed for provider retry.`,
              hint: "Only the session that established this delivery may retry it.",
            },
          };
        }
      }
      const retryAttemptCount = Number(state.retry_attempt_count || 0) + 1;
      updateTransportState(scope, row.message_id, {
        delivery_state: "pending",
        retry_attempt_count: retryAttemptCount,
        error: null,
      });
      appendActivityEvent({
        type: "substrate_kernel_failed_delivery_retry",
        level: "info",
        scope_id: scope.scope_id,
        cwd: scope.cwd,
        data: {
          message_id: row.message_id,
          transport: row.transport,
          retry_attempt_count: retryAttemptCount,
        },
      });
      return { ok: true };
    },
  };
}
