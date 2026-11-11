// runtime_option_catalog — the per-provider table runtime_options.mjs validates,
// publishes, and renders from. Every value here is one the provider's CLI
// accepts: effort and permission values are proven against the installed CLIs
// (`claude --help`, `codex debug models`); model ids are free-form because each
// CLI rejects an unknown model at launch.

const enumerated = (values, render, defaultValue = null) => ({
  values: Object.freeze(values),
  free_form: false,
  default: defaultValue,
  render,
});

// Model ids move faster than Helm releases, and each CLI rejects an unknown
// model at launch, so any well-formed id is accepted (free_form). `values` is
// the suggestion list a picker offers, kept an array so 1.3 pickers that map
// over it still work. shortcut: a snapshot of `claude --help` aliases and
// `codex debug models` (codex-cli 0.167.0, default = priority 1); refresh them
// when either CLI's catalog moves.
const freeForm = (suggested, defaultValue, render) => ({
  values: Object.freeze(suggested),
  free_form: true,
  default: defaultValue,
  render,
});

const CLAUDE_MODELS = Object.freeze(["fable", "opus", "sonnet"]);
const CODEX_MODELS = Object.freeze([
  "gpt-6.1-sol",
  "gpt-6-astra",
  "gpt-6.1-terra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);
export const COPILOT_PERMISSION_MODES = Object.freeze([
  "approve-all",
  "approve-reads",
  "deny-all",
]);
const MODEL_FLAG = (suggested, defaultValue) =>
  freeForm(suggested, defaultValue, (value) => ["--model", value]);

// Direct providers. A provider absent from a spec accepts that option nowhere.
export const PROVIDER_SPECS = Object.freeze({
  claude: {
    model: MODEL_FLAG(CLAUDE_MODELS, "sonnet"),
    reasoning_effort: enumerated(
      ["low", "medium", "high", "xhigh", "max"],
      (value) => ["--effort", value],
    ),
    permission_mode: enumerated(
      [
        "default",
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
    model: MODEL_FLAG(CODEX_MODELS, "gpt-6.1-sol"),
    // `minimal` is in no current model's list but stays accepted: 1.3 stored it.
    reasoning_effort: enumerated(
      ["minimal", "low", "medium", "high", "xhigh", "max"],
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

export const ACADEMY_RUNTIME_SPECS = Object.freeze({
  copilot: {
    permission_mode: enumerated(COPILOT_PERMISSION_MODES, (value) => [
      "--permission-mode",
      value,
    ]),
  },
});

// Academy wraps a runtime, so its applicable options are that runtime's. The
// runtime list mirrors the runtimes the academy adapter can actually launch.
export const DELEGATING_PROVIDERS = Object.freeze({
  academy: {
    config_key: "academy_runtime",
    default: "claude",
    runtimes: ["claude", "codex", "copilot"],
  },
});
