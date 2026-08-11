import { spawnSync } from "node:child_process";

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

const RESUME_HELP_ARGS = Object.freeze({
  claude: Object.freeze(["--help"]),
  codex: Object.freeze(["exec", "resume", "--help"]),
});

const RESUME_HELP_SIGNALS = Object.freeze({
  claude: Object.freeze([
    ["exact_resume", /--resume\b/],
    ["structured_output", /--output-format\b/],
  ]),
  codex: Object.freeze([
    ["exact_resume", /\bresume\b/],
    ["stdin_resume", /(?:<SESSION_ID>|SESSION_ID|session)[\s\S]*\s-|stdin/i],
    ["structured_output", /--json\b|thread\.started|turn\.completed/],
  ]),
});

export function probeRuntimeResumeCapabilities({
  runtime,
  adapter,
  exec = (command, args, options) => spawnSync(command, args, options),
} = {}) {
  const missing = [];
  if (!RESUME_HELP_ARGS[runtime] || adapter?.name !== runtime) {
    return {
      ok: false,
      ready: false,
      runtime: runtime || null,
      missing: ["supported_runtime"],
      error: "runtime_unsupported",
    };
  }
  const manifest = adapter.raw || {};
  if (adapter.capabilities?.session_identity !== true)
    missing.push("session_capture");
  if (adapter.capabilities?.session_start_hook !== true)
    missing.push("session_start_hook");
  if (adapter.capabilities?.exact_resume !== true) missing.push("exact_resume");
  if (adapter.capabilities?.stdin_resume !== true) missing.push("stdin_resume");
  if (
    adapter.capabilities?.structured_output !== true ||
    manifest.resume?.structured_output !== true
  ) {
    missing.push("structured_output");
  }
  if (manifest.resume?.stdin !== "generated_brief")
    missing.push("stdin_resume");
  if (!Array.isArray(manifest.resume?.argv) || !manifest.resume.argv.length)
    missing.push("exact_resume");

  let result;
  try {
    result = exec(runtime, RESUME_HELP_ARGS[runtime], {
      encoding: "utf8",
      timeout: adapter.timeouts?.provider_version_sec
        ? adapter.timeouts.provider_version_sec * 1000
        : 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    result = null;
  }
  if (!result || result.status !== 0) {
    missing.push("runtime_executable");
  } else {
    const help = `${result.stdout || ""}\n${result.stderr || ""}`;
    for (const [name, pattern] of RESUME_HELP_SIGNALS[runtime]) {
      if (!pattern.test(help)) missing.push(name);
    }
  }
  const uniqueMissing = [...new Set(missing)];
  return {
    ok: uniqueMissing.length === 0,
    ready: uniqueMissing.length === 0,
    runtime,
    missing: uniqueMissing,
    error:
      uniqueMissing.length > 0 ? "runtime_resume_capability_missing" : null,
  };
}
