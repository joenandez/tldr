// runtime_options — per-provider agent runtime options for scheduled work.
//
// A job's provider decides which runtime knobs exist: Claude takes a permission
// mode but has no reasoning-effort flag, Codex takes a reasoning effort and a
// sandbox mode, and Academy delegates to whichever runtime it wraps. Callers
// cannot know that mapping, so Helm owns it here: one table drives validation,
// the published capability surface (`runtime-options`), and the argv rendered
// into the launch. A value that survives validation always reaches the process;
// an option the provider does not accept is rejected, never dropped.
//
// The table lives in code rather than in the adapter manifests because these
// values are validated and published, not merely expanded — a manifest can only
// describe argv, it cannot describe an accepted-value set.
//
// Stored under `execution_hints.provider_config.runtime_options`. Assignment
// creation requires permission_mode; the other launch argv only changes for
// jobs that explicitly opt in. `execution_hints.model` is mirrored alongside
// it because that is Helm's canonical model field.

import { ASSIGNMENTS_COMMAND } from "./helm_context.mjs";

export const RUNTIME_OPTION_FIELDS = Object.freeze([
  "model",
  "reasoning_effort",
  "permission_mode",
]);

export const ASSIGNMENTS_CONTRACT_VERSION = "1.1";

export const RUNTIME_OPTION_FLAGS = Object.freeze({
  model: "model",
  reasoning_effort: "reasoning-effort",
  permission_mode: "permission-mode",
});

const enumerated = (values, render, defaultValue = null) => ({
  values: Object.freeze(values),
  free_form: false,
  default: defaultValue,
  render,
});

const CLAUDE_MODELS = Object.freeze(["claude-opus-4-1", "claude-sonnet-4-5"]);
const CODEX_MODELS = Object.freeze(["gpt-5-codex", "gpt-5.1-codex"]);
const MODEL_FLAG = (values, defaultValue) =>
  enumerated(values, (value) => ["--model", value], defaultValue);

// Direct providers. A provider absent from a spec accepts that option nowhere.
const PROVIDER_SPECS = Object.freeze({
  claude: {
    model: MODEL_FLAG(CLAUDE_MODELS, "claude-sonnet-4-5"),
    permission_mode: enumerated(
      [
        "acceptEdits",
        "auto",
        "bypassPermissions",
        "manual",
        "dontAsk",
        "plan",
        "yolo",
      ],
      (value) => [
        "--permission-mode",
        value === "yolo" ? "bypassPermissions" : value,
      ],
    ),
  },
  codex: {
    model: MODEL_FLAG(CODEX_MODELS, "gpt-5.1-codex"),
    reasoning_effort: enumerated(
      ["minimal", "low", "medium", "high"],
      (value) => ["-c", `model_reasoning_effort=${value}`],
    ),
    permission_mode: enumerated(
      ["read-only", "workspace-write", "danger-full-access", "yolo"],
      (value) =>
        value === "yolo"
          ? ["--dangerously-bypass-approvals-and-sandbox"]
          : ["--sandbox", value],
    ),
  },
  cursor: {},
  droid: {},
  gemini: {},
  hermes: {},
});

// Academy wraps a runtime, so its applicable options are that runtime's. The
// runtime list mirrors the runtimes the academy adapter can actually launch.
const DELEGATING_PROVIDERS = Object.freeze({
  academy: {
    config_key: "academy_runtime",
    default: "claude",
    runtimes: ["claude", "codex"],
  },
});

export function resolveOptionTarget(provider, providerConfig = null) {
  const delegate = DELEGATING_PROVIDERS[provider];
  if (!delegate) {
    return { provider, runtime: null, spec: PROVIDER_SPECS[provider] || null };
  }
  const runtime = providerConfig?.[delegate.config_key] || delegate.default;
  return {
    provider,
    runtime,
    spec: delegate.runtimes.includes(runtime)
      ? PROVIDER_SPECS[runtime] || null
      : null,
  };
}

function supportedOptionsFor(spec) {
  return RUNTIME_OPTION_FIELDS.filter((field) => Boolean(spec?.[field]));
}

function describeOptions(spec) {
  const described = {};
  for (const field of RUNTIME_OPTION_FIELDS) {
    const option = spec?.[field];
    described[field] = option
      ? {
          supported: true,
          values: option.values,
          default: option.default || null,
          free_form: option.free_form,
        }
      : { supported: false, values: null, default: null, free_form: false };
  }
  return described;
}

// Published discovery payload: every provider/runtime pair a client can target,
// with all three option fields always present so rendering is table-driven.
export function runtimeOptionCapabilities() {
  const entries = Object.keys(PROVIDER_SPECS).map((provider) => ({
    provider,
    runtime: null,
    options: describeOptions(PROVIDER_SPECS[provider]),
  }));
  for (const [provider, delegate] of Object.entries(DELEGATING_PROVIDERS)) {
    for (const runtime of delegate.runtimes) {
      entries.push({
        provider,
        runtime,
        options: describeOptions(PROVIDER_SPECS[runtime]),
        delegates_via: delegate.config_key,
      });
    }
  }
  entries.sort((a, b) => {
    const left = `${a.provider} ${a.runtime || ""}`;
    const right = `${b.provider} ${b.runtime || ""}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return { contract_version: ASSIGNMENTS_CONTRACT_VERSION, providers: entries };
}

// Reads the three flags. `null` (the string) clears a stored value, matching the
// existing --academy-agent/--academy-runtime convention on this CLI.
export function readRuntimeOptionFlags(flags = {}, permissionRequired = false) {
  const permission = flags[RUNTIME_OPTION_FLAGS.permission_mode];
  if (
    permissionRequired &&
    (permission === undefined || permission === true || permission === "null")
  ) {
    return {
      error: {
        code: "permission_mode_required",
        message: `--permission-mode is required and must be non-null; inspect provider-native choices with '${ASSIGNMENTS_COMMAND} runtime-options'`,
      },
    };
  }
  const patch = {};
  for (const field of RUNTIME_OPTION_FIELDS) {
    const raw = flags[RUNTIME_OPTION_FLAGS[field]];
    if (raw === undefined) continue;
    if (raw === true) {
      return {
        error: {
          code: "runtime_option_invalid_value",
          message: `--${RUNTIME_OPTION_FLAGS[field]} requires a value`,
          details: { option: field },
        },
      };
    }
    patch[field] = raw === "null" ? null : String(raw);
  }
  return { patch, present: Object.keys(patch).length > 0 };
}

function unsupportedError(field, target) {
  const supported = supportedOptionsFor(target.spec);
  const label = target.runtime
    ? `${target.provider} (runtime ${target.runtime})`
    : target.provider;
  return {
    code: "runtime_option_unsupported",
    message: `provider ${label} does not accept --${RUNTIME_OPTION_FLAGS[field]}; it accepts: ${supported.length ? supported.join(", ") : "no runtime options"}`,
    details: {
      option: field,
      provider: target.provider,
      runtime: target.runtime,
      supported_options: supported,
    },
  };
}

// Validates a patch against the provider it will run under. Returns
// {options} on success or {error} — never a silently narrowed patch.
export function validateRuntimeOptions({
  provider,
  providerConfig = null,
  patch = {},
  existing = null,
}) {
  const fields = RUNTIME_OPTION_FIELDS.filter(
    (field) => patch[field] !== undefined,
  );
  if (fields.length === 0) return { options: existing || null };
  if (!provider) {
    return {
      error: {
        code: "runtime_options_require_provider",
        message:
          `runtime options need a provider; pass --provider (accepted values: ${ASSIGNMENTS_COMMAND} runtime-options)`,
        details: { options: fields },
      },
    };
  }
  const target = resolveOptionTarget(provider, providerConfig);
  for (const field of fields) {
    const value = patch[field];
    if (value === null) continue;
    const option = target.spec?.[field];
    if (!option) return { error: unsupportedError(field, target) };
    if (option.values && !option.values.includes(value)) {
      return {
        error: {
          code: "runtime_option_invalid_value",
          message: `--${RUNTIME_OPTION_FLAGS[field]}=${value} is not accepted by ${target.runtime || target.provider}; accepted values: ${option.values.join(", ")}`,
          details: {
            option: field,
            value,
            provider: target.provider,
            runtime: target.runtime,
            accepted_values: option.values,
          },
        },
      };
    }
  }
  const merged = { ...(existing || {}) };
  for (const field of fields) {
    if (patch[field] === null) delete merged[field];
    else merged[field] = patch[field];
  }
  return { options: Object.keys(merged).length > 0 ? merged : null };
}

export function storedRuntimeOptions(providerConfig) {
  const stored = providerConfig?.runtime_options;
  if (!stored || typeof stored !== "object" || Array.isArray(stored))
    return null;
  return stored;
}

// Published shape: every field always present, null when unset.
export function publishedRuntimeOptions(job) {
  const stored = storedRuntimeOptions(job?.execution_hints?.provider_config);
  const published = {};
  for (const field of RUNTIME_OPTION_FIELDS) {
    published[field] = stored?.[field] ?? null;
  }
  return published;
}

// Writes validated options into execution_hints, mirroring model into Helm's
// canonical execution_hints.model so every existing model reader still sees it.
//
// `patch` is the caller's raw flag patch. A model set through another path
// (helm-tasks update --model writes execution_hints.model directly) must
// survive an unrelated runtime-option update, so the mirror only clears the
// field when the caller explicitly passed the documented literal `null`.
export function applyRuntimeOptions(executionHints, options, patch = null) {
  const config = { ...(executionHints.provider_config || {}) };
  if (options && Object.keys(options).length > 0) {
    config.runtime_options = options;
  } else {
    delete config.runtime_options;
  }
  const next = { ...executionHints };
  if (Object.keys(config).length > 0) next.provider_config = config;
  else delete next.provider_config;
  if (options?.model !== undefined && options?.model !== null) {
    next.model = options.model;
  } else if (patch && patch.model === null) {
    next.model = null;
  }
  return next;
}

// Renders the launch flags for a job's stored options and splices them in ahead
// of the prompt, where a provider expects its own flags.
export function insertRuntimeOptionArgv({
  argv,
  rawArgv,
  provider,
  providerConfig,
}) {
  const options = storedRuntimeOptions(providerConfig);
  if (!options || !Array.isArray(argv)) return argv;
  const target = resolveOptionTarget(provider, providerConfig);
  const rendered = [];
  for (const field of RUNTIME_OPTION_FIELDS) {
    const value = options[field];
    const option = target.spec?.[field];
    if (value === null || value === undefined || !option) continue;
    rendered.push(...option.render(String(value)));
  }
  if (rendered.length === 0) return argv;
  const promptIndex = (rawArgv || []).findIndex(
    (entry) => typeof entry === "string" && entry.includes("{{prompt}}"),
  );
  const at = promptIndex >= 0 ? promptIndex : argv.length;
  return [...argv.slice(0, at), ...rendered, ...argv.slice(at)];
}
