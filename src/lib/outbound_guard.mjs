import { emitSafetyEvent } from "./safety_events.mjs";

const SAFE_DATA_KEYS = new Set([
  "job_id",
  "message_id",
  "run_id",
  "target_class",
  "thread_id",
]);

function safeExtraData(data = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (!SAFE_DATA_KEYS.has(key)) continue;
    safe[key] = value;
  }
  return safe;
}

function sanitizedData({
  route,
  channel,
  sideEffectKind,
  mode,
  suppressed,
  reason,
  data = {},
}) {
  return {
    route,
    channel,
    side_effect_kind: sideEffectKind,
    mode,
    suppressed,
    reason,
    ...safeExtraData(data),
  };
}

export async function guardOutbound({
  route,
  channel,
  sideEffectKind,
  scope = null,
  data = {},
} = {}) {
  const { readOutboundState } = await import("./runtime_store.mjs");
  const state = readOutboundState({ initialize: false });
  const mode = state.mode || "disabled";
  const suppressed = mode === "disabled";
  const reason = suppressed
    ? state.configured
      ? "outbound_disabled"
      : state.reason || "outbound_state_missing"
    : "outbound_allowed";
  const decision = {
    ok: true,
    configured: state.configured,
    route,
    channel,
    side_effect_kind: sideEffectKind,
    mode,
    suppressed,
    reason,
  };

  emitSafetyEvent({
    type: "outbound_guard_decision",
    subsystem: "outbound",
    status: suppressed ? "suppressed" : "allowed",
    errorClass: suppressed ? reason : null,
    scope,
    metadata: sanitizedData({
      route,
      channel,
      sideEffectKind,
      mode,
      suppressed,
      reason,
      data,
    }),
  });

  return decision;
}
