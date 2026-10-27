import path from "node:path";

export const COPILOT_CAPABILITY_FIELDS = new Set([
  "stdoutInjection",
  "blockExitCodes",
  "idleWake",
  "hookEffects",
]);
export const COPILOT_HOOK_EFFECTS = Object.freeze([
  "session-start-context",
  "user-prompt",
  "tool-result",
]);

function rejection(code, message, field) {
  return { ok: false, code, message, field };
}

function firstRejection(checks) {
  return checks.find(Boolean) ?? null;
}

export function isCopilotProjectSettingsPath(settingsPath) {
  if (typeof settingsPath !== "string" || !path.isAbsolute(settingsPath)) {
    return false;
  }
  if (path.normalize(settingsPath) !== settingsPath) return false;
  const filename = path.basename(settingsPath);
  const hooksDirectory = path.dirname(settingsPath);
  const githubDirectory = path.dirname(hooksDirectory);
  return (
    filename !== ".json" &&
    path.extname(filename) === ".json" &&
    path.basename(hooksDirectory) === "hooks" &&
    path.basename(githubDirectory) === ".github"
  );
}

// The package's source-owned plugin hooks file, loaded with
// `--plugin-dir <package root>/.copilot-plugin`; it is never rewritten.
export function isCopilotPluginHooksPath(settingsPath) {
  if (typeof settingsPath !== "string" || !path.isAbsolute(settingsPath)) {
    return false;
  }
  if (path.normalize(settingsPath) !== settingsPath) return false;
  const hooksDirectory = path.dirname(settingsPath);
  return (
    path.basename(settingsPath) === "hooks.json" &&
    path.basename(hooksDirectory) === "hooks" &&
    path.basename(path.dirname(hooksDirectory)) === ".copilot-plugin"
  );
}

export function isCopilotHooksPath(settingsPath) {
  return (
    isCopilotProjectSettingsPath(settingsPath) ||
    isCopilotPluginHooksPath(settingsPath)
  );
}

export const COPILOT_SETTINGS_PATH_RULE =
  'contractVersion "1.1" requires an absolute, normalized project path ending in ".github/hooks/*.json" or a package ".copilot-plugin/hooks/hooks.json"';

export function parseCopilotCapabilities(capabilities) {
  const effects = capabilities.hookEffects;
  const invalid = firstRejection([
    capabilities.stdoutInjection !== false &&
      rejection(
        "invalid_field",
        'contractVersion "1.1" requires capabilities.stdoutInjection false',
        "capabilities.stdoutInjection",
      ),
    (!Array.isArray(capabilities.blockExitCodes) ||
      capabilities.blockExitCodes.length !== 0) &&
      rejection(
        "invalid_field",
        'contractVersion "1.1" requires empty capabilities.blockExitCodes',
        "capabilities.blockExitCodes",
      ),
    capabilities.idleWake !== "unsupported" &&
      rejection(
        "invalid_field",
        'contractVersion "1.1" requires capabilities.idleWake "unsupported"',
        "capabilities.idleWake",
      ),
    (!Array.isArray(effects) ||
      effects.some((effect) => typeof effect !== "string")) &&
      rejection(
        "invalid_field",
        "capabilities.hookEffects must be an array of strings",
        "capabilities.hookEffects",
      ),
    Array.isArray(effects) &&
      (effects.length !== COPILOT_HOOK_EFFECTS.length ||
        COPILOT_HOOK_EFFECTS.some(
          (effect, index) => effects[index] !== effect,
        )) &&
      rejection(
        "invalid_field",
        `capabilities.hookEffects must be exactly ${JSON.stringify(COPILOT_HOOK_EFFECTS)}`,
        "capabilities.hookEffects",
      ),
  ]);
  if (invalid) return invalid;
  return {
    ok: true,
    capabilities: Object.freeze({
      stdoutInjection: false,
      blockExitCodes: Object.freeze([]),
      idleWake: "unsupported",
      hookEffects: COPILOT_HOOK_EFFECTS,
    }),
  };
}

export function parseManifestCapabilities(
  capabilities,
  contractVersion,
  options,
) {
  if (contractVersion === "1.1") return parseCopilotCapabilities(capabilities);
  const blockExitCodes = capabilities.blockExitCodes;
  const idleWake = Object.hasOwn(capabilities, "idleWake")
    ? capabilities.idleWake
    : options.defaultIdleWake;
  const invalid = firstRejection([
    !Object.hasOwn(capabilities, "stdoutInjection") &&
      rejection(
        "missing_required_field",
        "capabilities.stdoutInjection is required",
        "capabilities.stdoutInjection",
      ),
    Object.hasOwn(capabilities, "stdoutInjection") &&
      typeof capabilities.stdoutInjection !== "boolean" &&
      rejection(
        "invalid_field",
        "capabilities.stdoutInjection must be a boolean",
        "capabilities.stdoutInjection",
      ),
    !Object.hasOwn(capabilities, "blockExitCodes") &&
      rejection(
        "missing_required_field",
        "capabilities.blockExitCodes is required",
        "capabilities.blockExitCodes",
      ),
    Object.hasOwn(capabilities, "blockExitCodes") &&
      !Array.isArray(blockExitCodes) &&
      rejection(
        "invalid_field",
        "capabilities.blockExitCodes must be an array of non-negative integers",
        "capabilities.blockExitCodes",
      ),
    Array.isArray(blockExitCodes) &&
      blockExitCodes.length > options.maxBlockExitCodes &&
      rejection(
        "array_length_limit",
        `capabilities.blockExitCodes exceeds ${options.maxBlockExitCodes} entries`,
        "capabilities.blockExitCodes",
      ),
    Array.isArray(blockExitCodes) &&
      blockExitCodes.some((code) => !Number.isSafeInteger(code) || code < 0) &&
      rejection(
        "invalid_field",
        "capabilities.blockExitCodes entries must be non-negative integers",
        "capabilities.blockExitCodes",
      ),
    !options.idleWakeModes.includes(idleWake) &&
      rejection(
        "invalid_field",
        `capabilities.idleWake must be ${options.idleWakeModes.map((mode) => `"${mode}"`).join(" or ")}`,
        "capabilities.idleWake",
      ),
  ]);
  if (invalid) return invalid;
  return {
    ok: true,
    capabilities: Object.freeze({
      stdoutInjection: capabilities.stdoutInjection,
      blockExitCodes: Object.freeze([...blockExitCodes]),
      idleWake,
    }),
  };
}

export function admitCopilotHookContract(record) {
  const parsed = parseCopilotCapabilities(record.capabilities ?? {});
  const invalid = firstRejection([
    record.resumeStrategy !== "external" &&
      rejection(
        "unsupported_contract_version",
        'contractVersion "1.1" supports external runtimes only',
        "resumeStrategy",
      ),
    record.hooksInstall?.format !== "copilot-json" &&
      rejection(
        "unsupported_hooks_format",
        'contractVersion "1.1" requires hooksInstall.format "copilot-json"',
        "hooksInstall.format",
      ),
    !isCopilotHooksPath(record.hooksInstall?.settingsPath) &&
      rejection(
        "unsupported_settings_path",
        COPILOT_SETTINGS_PATH_RULE,
        "hooksInstall.settingsPath",
      ),
    !parsed.ok && {
      ...parsed,
      code: `unsupported_${parsed.field
        .split(".")
        .at(-1)
        .replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
    },
  ]);
  return invalid ?? { ok: true };
}

// tldr's own contract-1.1 `copilot` manifest for a package hooks file. Setup
// registers it, and runtime.register replaces a stored record only when it
// has exactly this shape (Academy's copilotRuntimeManifest matches it).
export const tldrCopilotRuntimeManifest = (settingsPath) => ({
  id: "copilot",
  contractVersion: "1.1",
  resumeStrategy: "external",
  identity: { sessionEnvVars: [], envMarkers: [], transcriptHints: [] },
  hooksInstall: { settingsPath, format: "copilot-json" },
  capabilities: {
    stdoutInjection: false,
    blockExitCodes: [],
    idleWake: "unsupported",
    hookEffects: [...COPILOT_HOOK_EFFECTS],
  },
});
