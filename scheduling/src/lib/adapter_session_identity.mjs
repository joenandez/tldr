function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function identityFromAdapter(finalized = {}, prepared = {}) {
  const sessionId = nonEmpty(finalized.session_id);
  if (!sessionId) return null;
  const minted =
    prepared.strategy === "external_mint" && prepared.session_id === sessionId;
  return {
    session_id: sessionId,
    thread_id: nonEmpty(finalized.thread_id) || sessionId,
    resume_command: finalized.resume_command || null,
    resume_cwd: finalized.resume_cwd || null,
    confidence: finalized.resume_confidence || (minted ? "high" : null),
    source: minted ? "adapter_minted" : "adapter_stdout",
  };
}

function identityFromHook(hook = {}) {
  if (!hook) return null;
  const sessionId = nonEmpty(hook.session_id);
  if (!sessionId) return null;
  return {
    session_id: sessionId,
    thread_id: nonEmpty(hook.thread_id) || sessionId,
    resume_command: hook.resume_command || null,
    resume_cwd: hook.resume_cwd || null,
    confidence: hook.confidence || "medium",
    source: "session_start_hook",
    evidence_path: hook.evidence_path || null,
  };
}

export function mergeAdapterSessionIdentity({
  finalized = {},
  prepared = {},
  hookIdentity = null,
  sessionRequired = true,
} = {}) {
  const adapterIdentity = identityFromAdapter(finalized, prepared);
  const hook = identityFromHook(hookIdentity);
  if (
    adapterIdentity &&
    hook &&
    (adapterIdentity.session_id !== hook.session_id ||
      adapterIdentity.thread_id !== hook.thread_id)
  ) {
    return {
      ok: false,
      status: "conflict",
      reason: "session_identity_conflict",
      identity: null,
      candidates: [adapterIdentity, hook],
    };
  }
  const identity = adapterIdentity || hook;
  if (!identity) {
    return {
      ok: !sessionRequired,
      status: "missing",
      reason: sessionRequired
        ? "managed_session_identity_missing"
        : "session_identity_not_required",
      identity: null,
      candidates: [],
    };
  }
  return {
    ok: true,
    status: "resolved",
    reason: "session_identity_resolved",
    identity,
    candidates: [adapterIdentity, hook].filter(Boolean),
  };
}

export function validateAdapterCapabilities({
  adapter,
  sessionRequired = true,
  requireSessionStartHook = false,
} = {}) {
  const errors = [];
  if (!adapter) errors.push("adapter_required");
  if (adapter && !Number.isInteger(adapter.version)) {
    errors.push("adapter_manifest_version_invalid");
  }
  if (sessionRequired && adapter?.capabilities?.session_identity !== true) {
    errors.push("adapter_session_identity_capability_missing");
  }
  if (
    requireSessionStartHook &&
    adapter?.capabilities?.session_start_hook !== true
  ) {
    errors.push("adapter_session_start_hook_capability_missing");
  }
  for (const key of ["startup_sec", "finalize_sec", "provider_version_sec"]) {
    const value = adapter?.timeouts?.[key];
    if (!Number.isInteger(value) || value <= 0) {
      errors.push(`adapter_timeout_invalid:${key}`);
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    capabilities: adapter?.capabilities || null,
    timeouts: adapter?.timeouts || null,
    provider_version: adapter?.provider_version || null,
  };
}
