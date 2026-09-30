// helm-tasks bootstrap-hooks command.
//
// Helm no longer has runtime hooks. Its SessionStart/UserPromptSubmit/Stop
// hooks wrote session identity and busy/idle files; Tightbeam's session
// hooks record the same facts and Helm reads them through the tightbeam CLI
// (src/lib/tightbeam_sessions.mjs), so each session event has one hook.
//
// This command now only REMOVES Helm-owned entries (every marker generation
// and every exact Helm script path, current or legacy) from the agent
// runtime's hook settings. --install and --uninstall both remove; neither
// ever adds an entry, and a file with nothing Helm-owned is left untouched.
// Supports --dry-run.
//
// Supported runtimes (probed in this order):
//   claude   →  $HOME/.claude/settings.json
//   codex    →  $HOME/.codex/hooks.json
//
// Ownership belongs to each entry: user-authored entries, their order, and
// the enclosing matcher/options are preserved.

import {
  existsSync,
  readFileSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

// The last marker Helm stamped on the hooks it installed.
const HELM_MARKER = "helm-managed:runtime-hooks-v1";

// Every marker generation Helm ever stamped; an entry carrying any of them
// is Helm-owned.
export const HELM_MARKERS = [
  "helm-managed:prfaq-0-1",
  "helm-managed:prfaq-0-6",
  HELM_MARKER,
];

// Helm installs no runtime hooks. Kept as an (empty) map because the
// sentinel and doctor derive the events Helm requires from it.
const HOOK_FILES = {};

// Hooks Helm previously installed: session identity and busy/idle state
// (now Tightbeam's), and inbox delivery before that. Their names are kept
// only to recognize exact Helm-owned commands that lost their marker.
const RETIRED_HOOK_FILES = {
  SessionStart: ["helm-capture-session-identity.sh"],
  UserPromptSubmit: ["helm-mark-session-busy.sh"],
  Stop: ["helm-hold-stop-for-unread.sh"],
  PreToolUse: ["helm-prefetch-session-inbox.sh"],
  PostToolUse: ["helm-inject-session-messages.sh"],
};

const LEGACY_HOOK_FILES = {
  SessionStart: ["helm-session-start.sh"],
  UserPromptSubmit: ["helm-user-prompt-submit.sh"],
  Stop: ["helm-stop.sh"],
  PreToolUse: ["helm-pre-tool-use.sh"],
  PostToolUse: ["helm-post-tool-use.sh"],
};

const HELM_HOOK_EVENTS = [
  ...new Set([
    ...Object.keys(RETIRED_HOOK_FILES),
    ...Object.keys(LEGACY_HOOK_FILES),
  ]),
];

function helmRepoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

// Where a Helm hook script lived inside this checkout. The scripts are gone;
// the path is still how an unmarked Helm entry is recognized.
function hookScriptPath(name) {
  return join(helmRepoRoot(), "hooks", name);
}

function settingsPath(runtime) {
  if (runtime === "claude") return join(homedir(), ".claude", "settings.json");
  if (runtime === "codex") return join(homedir(), ".codex", "hooks.json");
  throw new Error(`unknown runtime: ${runtime}`);
}

function readSettings(file) {
  if (!existsSync(file)) return { exists: false, value: {} };
  try {
    return { exists: true, value: JSON.parse(readFileSync(file, "utf8")) };
  } catch (err) {
    throw new Error(`failed to parse ${file}: ${err.message}`);
  }
}

function atomicWriteJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmp, file);
}

function hasHelmMarker(hook) {
  return typeof hook?._helm === "string" && HELM_MARKERS.includes(hook._helm);
}

function isHelmGroup(group) {
  return Array.isArray(group?.hooks) && group.hooks.some(hasHelmMarker);
}

function isExactHelmCommand(hook, event) {
  const names = [
    ...(RETIRED_HOOK_FILES[event] || []),
    ...(LEGACY_HOOK_FILES[event] || []),
  ];
  return (
    hook?.type === "command" &&
    names.some((name) => hook.command === hookScriptPath(name))
  );
}

function isExactHelmCommandGroup(group, event) {
  return (
    Array.isArray(group?.hooks) &&
    group.hooks.some((hook) => isExactHelmCommand(hook, event))
  );
}

function isHelmHook(hook, event) {
  return hasHelmMarker(hook) || isExactHelmCommand(hook, event);
}

// Drop Helm-owned entries only; a group left empty is dropped with them.
function withoutHelmHooks(groups, event) {
  return groups.flatMap((group) => {
    if (!Array.isArray(group?.hooks)) return [group];
    const hooks = group.hooks.filter((hook) => !isHelmHook(hook, event));
    if (hooks.length === group.hooks.length) return [group];
    return hooks.length ? [{ ...group, hooks }] : [];
  });
}

function detectedHelmMarker(group) {
  return group?.hooks?.find(hasHelmMarker)?._helm || null;
}

// Every Helm-owned entry still present in a settings value.
function retiredHelmGroups(value) {
  const retired = [];
  for (const event of HELM_HOOK_EVENTS) {
    const groups = Array.isArray(value?.hooks?.[event])
      ? value.hooks[event]
      : [];
    for (const group of groups) {
      const hook = group?.hooks?.find((entry) => isHelmHook(entry, event));
      if (!hook) continue;
      retired.push({
        event,
        command: hook?.command || null,
        marker_detected: detectedHelmMarker(group),
      });
    }
  }
  return retired;
}

// Read-only inspection. `events` is empty because Helm requires no runtime
// hooks; `retired_groups` lists any Helm-owned entry that should go.
export function inspectInstalledHooks({ runtime } = {}) {
  if (!runtime) {
    return { ok: false, error: "missing_runtime" };
  }
  const file = settingsPath(runtime);
  const { value } = readSettings(file);
  return { runtime, file, events: {}, retired_groups: retiredHelmGroups(value) };
}

function planChanges(settings) {
  const next = JSON.parse(JSON.stringify(settings.value || {}));
  const changes = [];
  if (!next.hooks || typeof next.hooks !== "object") {
    return { next, changes };
  }
  for (const event of HELM_HOOK_EVENTS) {
    const existing = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    const filtered = withoutHelmHooks(existing, event);
    if (JSON.stringify(filtered) === JSON.stringify(existing)) {
      changes.push({ event, op: "absent" });
      continue;
    }
    changes.push({ event, op: "remove" });
    if (filtered.length === 0) delete next.hooks[event];
    else next.hooks[event] = filtered;
  }
  return { next, changes };
}

export function bootstrapHooks({
  action,
  runtime = null,
  dryRun = false,
} = {}) {
  if (!["install", "uninstall"].includes(action)) {
    return {
      ok: false,
      error: {
        code: "invalid_action",
        message: `action must be install or uninstall (got ${action})`,
      },
    };
  }
  const runtimes = runtime ? [runtime] : ["claude", "codex"];
  const report = [];
  for (const rt of runtimes) {
    const file = settingsPath(rt);
    const settings = readSettings(file);
    const { next, changes } = planChanges(settings);
    const entry = {
      runtime: rt,
      file,
      settings_existed: settings.exists,
      changes,
    };
    if (dryRun) {
      entry.status = "dry_run";
      entry.preview = next;
    } else if (!changes.some((change) => change.op === "remove")) {
      // Nothing Helm-owned to remove: leave the file (or its absence) alone.
      entry.status = "unchanged";
    } else {
      atomicWriteJson(file, next);
      entry.status = "written";
    }
    report.push(entry);
  }
  return {
    ok: true,
    action,
    dryRun,
    report,
    helm_marker: HELM_MARKER,
    hook_files: HOOK_FILES,
  };
}

export const _internals = {
  HELM_MARKER,
  HELM_MARKERS,
  HOOK_FILES,
  RETIRED_HOOK_FILES,
  LEGACY_HOOK_FILES,
  hookScriptPath,
  settingsPath,
  planChanges,
  helmRepoRoot,
  isHelmGroup,
  isExactHelmCommandGroup,
  retiredHelmGroups,
};
