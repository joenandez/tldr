// The Copilot permission-authority carrier, shared by the hook identity
// (cli) and the daemon without either importing the other (this is the
// runtimes leaf). Academy launches Copilot headlessly with an explicit
// permission mode and exports it as ACADEMY_COPILOT_PERMISSION_MODE; the
// hook only forwards what it can validate, the daemon stores it with the
// owner it was observed under, and only the stored value ever selects the
// wake's argv. Nothing here defaults, widens or infers a mode.

import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isCopilotPluginHooksPath } from "./copilot_contract.mjs";

export const ACADEMY_PERMISSION_MODES = Object.freeze([
  "approve-all",
  "approve-reads",
  "deny-all",
]);
export const ACADEMY_AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const COPILOT_OWNER_CAPTURE_SOURCE = "copilot-hook";
// Native `copilot` and `copilot --acp --stdio` under acpx share this
// command; `node` is deliberately not an owner for Copilot.
export const COPILOT_OWNER_COMMAND = /^copilot$/;
export const COPILOT_WAKE_SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const WAKE_MESSAGE_ID = /^msg_[0-9A-Za-z_-]{1,64}$/;

const OWN_PLUGIN_HOOKS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  ".copilot-plugin",
  "hooks",
  "hooks.json",
);

export function isAcademyPermissionMode(value) {
  return ACADEMY_PERMISSION_MODES.includes(value);
}

function readPackageIdentity(hooksPath) {
  // <root>/.copilot-plugin/hooks/hooks.json -> <root>/package.json
  const root = path.resolve(path.dirname(hooksPath), "..", "..");
  const { name, version } = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8"),
  );
  return `${name}@${version}`;
}

// One install, two copies: the daemon runs from its snapshot while the hook
// runs from the plugin-cache copy of the same build. Same bytes and the same
// package name and version make it this package's artifact; no path allowlist.
function isSameBuildCopy(declared, ownHooksPath) {
  return (
    readFileSync(declared).equals(readFileSync(ownHooksPath)) &&
    readPackageIdentity(declared) === readPackageIdentity(ownHooksPath)
  );
}

/**
 * True only for a registered contract-1.1 Copilot record whose plugin hooks
 * file is THIS package's own artifact: the same real path, or a copy of this
 * build (same hooks bytes, package name and version). A record that names
 * another package, version, or a project hooks file never carries wake
 * authority.
 */
export function isPackageBoundCopilotRecord(
  record,
  ownHooksPath = OWN_PLUGIN_HOOKS,
) {
  const declared = record?.hooksInstall?.settingsPath;
  const copilotPlugin =
    record?.contractVersion === "1.1" &&
    record.hooksInstall?.format === "copilot-json" &&
    isCopilotPluginHooksPath(declared);
  try {
    return (
      copilotPlugin &&
      (realpathSync(declared) === realpathSync(ownHooksPath) ||
        isSameBuildCopy(declared, ownHooksPath))
    );
  } catch {
    return false;
  }
}

/** The wake runtime ids of a registry: the same set the resumer wakes. */
export function packageBoundCopilotRuntimeIds(registry) {
  return registry
    .list()
    .filter((record) => isPackageBoundCopilotRecord(record))
    .map((record) => record.id);
}

function readPermissionMode(env, log) {
  const value = env.ACADEMY_COPILOT_PERMISSION_MODE;
  if (value === undefined || value === "") return null;
  if (isAcademyPermissionMode(value)) return value;
  if (typeof log === "function") {
    log({
      event: "academy.permission_mode_invalid",
      params: { field: "ACADEMY_COPILOT_PERMISSION_MODE" },
      status: "omitted",
    });
  }
  return null;
}

/**
 * What the hook forwards on endpoint.register. The permission mode is read
 * only for the package-bound Copilot record AND a valid Academy agent name:
 * Academy exports it on its own headless launch and removes it elsewhere, so
 * the pair names an Academy-launched session. An invalid value is omitted
 * with one debug record; registration is never refused for it.
 */
export function academyLaunchStamp(env, { record = null, log } = {}) {
  const name = ACADEMY_AGENT_NAME_PATTERN.test(env.ACADEMY_AGENT_NAME ?? "")
    ? env.ACADEMY_AGENT_NAME
    : null;
  const bound = isPackageBoundCopilotRecord(record);
  return {
    academy_agent_name: name,
    copilot_hook_bound: bound,
    academy_permission_mode:
      bound && name !== null ? readPermissionMode(env, log) : null,
  };
}

// The argv suffix per STORED mode. Only approve-all can run the exact
// `agent receive` the brief names (acpx denies the execute request under
// the other modes), so only it has an entry; an absent key is a refusal,
// never a fallback.
const WAKE_PERMISSION_ARGS = Object.freeze({
  "approve-all": Object.freeze(["--permission-mode", "approve-all"]),
});

export function hasWakeVehicle(mode) {
  return Object.hasOwn(WAKE_PERMISSION_ARGS, mode);
}

/**
 * The Academy-managed resume argv. Every element is a literal except the
 * three validated slots (agent name, session UUID, bodyless brief); the
 * caller checks them first, and this refuses a mode with no entry.
 * `--runtime-once`, not `--agent`: Academy persists an `--agent` choice and
 * re-registers the agent's jobs, so a wake of an old Copilot session would
 * undo a later switch to another runtime.
 */
export function buildCopilotWakeInvocation({
  agentName,
  sessionId,
  mode,
  prompt,
}) {
  if (!hasWakeVehicle(mode)) return null;
  return {
    form: "resume",
    command: "academy",
    args: [
      "run",
      agentName,
      "--runtime-once",
      "copilot",
      "--",
      "--managed-resume-stdin",
      "--resume",
      sessionId,
      ...WAKE_PERMISSION_ARGS[mode],
      "-p",
      prompt,
    ],
    prompt: null,
    debugFile: null,
  };
}
