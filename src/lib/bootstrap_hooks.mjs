import {
  chmodSync,
  existsSync,
  readFileSync,
  mkdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { defaultStateRoot, legacyStateRoot } from "./store.mjs";

const TLDR_MARKER = "tldr-agent-managed:runtime-hooks-v1";
const LEGACY_MARKERS = new Set([TLDR_MARKER]);
const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "PreToolUse",
  "PostToolUse",
];
const RETIRED_HOOK_NAMES = new Set([
  "tldr-agent-capture-session-identity.sh",
  "tldr-agent-mark-session-busy.sh",
  "tldr-agent-hold-stop-for-unread.sh",
  "tldr-agent-prefetch-session-inbox.sh",
  "tldr-agent-inject-session-messages.sh",
  "helm-session-start.sh",
  "helm-capture-session-identity.sh",
  "helm-user-prompt-submit.sh",
  "helm-mark-session-busy.sh",
  "helm-stop.sh",
  "helm-hold-stop-for-unread.sh",
  "helm-pre-tool-use.sh",
  "helm-prefetch-session-inbox.sh",
  "helm-post-tool-use.sh",
  "helm-inject-session-messages.sh",
]);

function settingsPath(runtime, home = homedir()) {
  if (runtime === "claude") return join(home, ".claude", "settings.json");
  if (runtime === "codex") return join(home, ".codex", "hooks.json");
  throw new Error(`unknown runtime: ${runtime}`);
}

function readSettings(file) {
  if (!existsSync(file)) return { exists: false, value: {} };
  return { exists: true, value: JSON.parse(readFileSync(file, "utf8")) };
}

function atomicWriteJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
  writeFileSync(temporary, JSON.stringify(value, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(temporary, mode);
  renameSync(temporary, file);
}

function commandTokens(command) {
  return (
    command
      .match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
      ?.map((token) => token.replace(/^(?:"|')|(?:"|')$/g, "")) ?? []
  );
}

// Retired hook commands were written with the legacy ~/.tldr-agent path, so
// that literal stays a matcher; the state root default is matched too.
function retiredHookRoots(home) {
  return [legacyStateRoot("agent", home), defaultStateRoot("agent", home)].map(
    (root) => join(root, "install", "tldr-agent", "hooks"),
  );
}

function isRetiredCommand(command, home) {
  if (typeof command !== "string") return false;
  const hookRoots = retiredHookRoots(home);
  return commandTokens(command).some((token) =>
    hookRoots.some((hookRoot) =>
      [...RETIRED_HOOK_NAMES].some((name) => token === join(hookRoot, name)),
    ),
  );
}

function isOwnedHook(hook, home) {
  return (
    LEGACY_MARKERS.has(hook?._tldr_agent) ||
    isRetiredCommand(hook?.command, home)
  );
}

function removeOwnedHooks(group, home) {
  if (!Array.isArray(group?.hooks)) return group;
  const hooks = group.hooks.filter((hook) => !isOwnedHook(hook, home));
  if (hooks.length === group.hooks.length) return group;
  if (hooks.length === 0) return null;
  return { ...group, hooks };
}

function planRemoval(settings, home) {
  const next = structuredClone(settings.value || {});
  if (!next.hooks || typeof next.hooks !== "object")
    return { next, changes: [], changed: false };
  const changes = [];
  for (const event of EVENTS) {
    const groups = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    const retained = groups
      .map((group) => removeOwnedHooks(group, home))
      .filter(Boolean);
    if (
      retained.length === groups.length &&
      retained.every((group, index) => group === groups[index])
    )
      continue;
    changes.push({ event, op: "remove" });
    if (retained.length === 0) delete next.hooks[event];
    else next.hooks[event] = retained;
  }
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return { next, changes, changed: changes.length > 0 };
}

export function bootstrapHooks({
  action,
  runtime = null,
  dryRun = false,
  home = homedir(),
} = {}) {
  if (!["install", "uninstall"].includes(action))
    return { ok: false, error: { code: "invalid_action" } };
  const report = [];
  for (const currentRuntime of runtime ? [runtime] : ["claude", "codex"]) {
    const file = settingsPath(currentRuntime, home);
    const settings = readSettings(file);
    const removal = planRemoval(settings, home);
    const entry = {
      runtime: currentRuntime,
      file,
      settings_existed: settings.exists,
      changes: removal.changes,
      status: dryRun ? "dry_run" : removal.changed ? "written" : "unchanged",
    };
    if (dryRun) entry.preview = removal.next;
    else if (removal.changed) atomicWriteJson(file, removal.next);
    report.push(entry);
  }
  return { ok: true, action, dryRun, report, hook_marker: TLDR_MARKER };
}

export const _internals = {
  TLDR_MARKER,
  RETIRED_HOOK_NAMES,
  settingsPath,
  isOwnedHook,
  removeOwnedHooks,
  planRemoval,
};
