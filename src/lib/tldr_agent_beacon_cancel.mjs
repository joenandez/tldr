import { appendActivityEvent } from "./tldr_agent_diagnostics.mjs";
import {
  cancelBeaconObligation,
  withBeaconLifecycleMutex,
} from "./tldr_agent_beacon_marker.mjs";

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
  };
}

function cancelLocked(input, options) {
  const cancel = options.cancelObligation ?? cancelBeaconObligation;
  const cancelled = cancel(
    {
      scopeId: input.scope.scope_id,
      sessionId: input.sessionId,
      obligationId: input.obligationId,
      reason: input.reason,
      revocationRef: input.revocationRef,
    },
    markerOptions(options),
  );
  if (!cancelled?.ok) return cancelled;

  if (cancelled.changed) {
    const appendEvent = options.appendActivityEvent ?? appendActivityEvent;
    appendEvent(
      {
        type: "beacon_followup_cancelled",
        level: "info",
        status: "cancelled",
        data: { obligation_id: cancelled.marker.obligationId },
      },
      { home: options.home },
    );
  }

  return {
    ok: true,
    data: {
      obligationId: cancelled.marker.obligationId,
      status: "cancelled",
    },
  };
}

export function cancelBeaconFollowup(input, options = {}) {
  if (!nonempty(input?.reason) || !nonempty(input?.revocationRef)) {
    return failure("FOLLOWUP_REVOCATION_REQUIRED");
  }
  if (
    !nonempty(input?.scope?.scope_id) ||
    !nonempty(input?.sessionId) ||
    !nonempty(input?.obligationId)
  ) {
    return failure("ARGUMENT_INVALID");
  }
  try {
    return withBeaconLifecycleMutex(
      {
        scopeId: input.scope.scope_id,
        sessionId: input.sessionId,
        obligationId: input.obligationId,
      },
      options,
      () => cancelLocked(input, options),
    );
  } catch (error) {
    if (error?.name === "MutexTimeoutError") {
      return failure("FOLLOWUP_STORE_BUSY", true);
    }
    throw error;
  }
}
