// PRFAQ-0-1 Phase 1 — helm-tasks bootstrap-hooks command.
//
// Idempotently installs Helm's SessionStart/UserPromptSubmit/Stop hooks
// into the agent runtime's hook settings. Supports --install, --uninstall,
// and --dry-run.
//
// Supported runtimes (probed in this order):
//   claude   →  $HOME/.claude/settings.json
//   codex    →  $HOME/.codex/hooks.json
//
// Hook entries are tagged with a tldr; marker so --uninstall can remove
// only entries this tool installed, leaving user-authored entries intact.

import {
  accessSync,
  constants as fsConstants,
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

const HELM_MARKER = "tldr-agent-managed:runtime-hooks-v1";
const TACHYON_STOP_HOOK_TIMEOUT_SECONDS = 4 * 60 * 60;

// PRFAQ-0-7 B-T3.1 (plan_review OQ-4) — marker allow-set.
// When TASK-848D9F88 (Agent Adapter Contract v2) lands it appends a new
// marker generation here (e.g., 'helm-managed:adapter-contract-v2'); the
// allow-set lets isHelmGroup recognize both generations so a v1 install
// cleanly upgrades to v2 on the next bootstrap-hooks --install. Replacement
// logic in planChanges already overwrites any group matching isHelmGroup().
export const HELM_MARKERS = [HELM_MARKER];

// The hook script names. Resolved at install-time to absolute paths
// inside the running helm install so the recorded command is portable.
const HOOK_FILES = {
  SessionStart: "tldr-agent-capture-session-identity.sh",
  UserPromptSubmit: "tldr-agent-mark-session-busy.sh",
  Stop: "tldr-agent-hold-stop-for-unread.sh",
  PreToolUse: "tldr-agent-prefetch-session-inbox.sh",
  PostToolUse: "tldr-agent-inject-session-messages.sh",
};

const LEGACY_HOOK_FILES = {
  SessionStart: ["helm-session-start.sh", "helm-capture-session-identity.sh"],
  UserPromptSubmit: ["helm-user-prompt-submit.sh", "helm-mark-session-busy.sh"],
  Stop: ["helm-stop.sh", "helm-hold-stop-for-unread.sh"],
  PreToolUse: ["helm-pre-tool-use.sh", "helm-prefetch-session-inbox.sh"],
  PostToolUse: ["helm-post-tool-use.sh", "helm-inject-session-messages.sh"],
};

function helmRepoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

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

// Claude Code's hooks structure (canonical):
//   { "hooks": { "<EventName>": [ { "hooks": [ { "type": "command", "command": "..." } ] } ] } }
// We append one matcher-less group per event with our Helm-tagged command.
function buildHookGroup(event) {
  const cmd = hookScriptPath(HOOK_FILES[event]);
  const hook = { type: "command", command: cmd, _tldr_agent: HELM_MARKER };
  if (event === "Stop") hook.timeout = TACHYON_STOP_HOOK_TIMEOUT_SECONDS;
  return {
    hooks: [hook],
  };
}

function isHelmGroup(group) {
  if (!group || !Array.isArray(group.hooks)) return false;
  return group.hooks.some(
    (h) =>
      h &&
      typeof h._tldr_agent === "string" &&
      HELM_MARKERS.includes(h._tldr_agent),
  );
}

function isCurrentHelmGroup(group, event) {
  if (!group || !Array.isArray(group.hooks) || !HOOK_FILES[event]) return false;
  const command = hookScriptPath(HOOK_FILES[event]);
  return group.hooks.some(
    (h) =>
      h?.type === "command" &&
      h?.command === command &&
      h?._tldr_agent === HELM_MARKER,
  );
}

function isTldrAgentCommand(command, event) {
  if (typeof command !== "string" || !HOOK_FILES[event]) return false;
  return [HOOK_FILES[event], ...(LEGACY_HOOK_FILES[event] ?? [])].some(
    (file) => command === hookScriptPath(file),
  );
}

function isRemovableHelmGroup(group, event) {
  if (isHelmGroup(group)) return true;
  return group?.hooks?.some(
    (hook) =>
      hook?.type === "command" && isTldrAgentCommand(hook.command, event),
  );
}

function detectedHelmMarker(group) {
  return (
    group?.hooks?.find(
      (h) =>
        h &&
        typeof h._tldr_agent === "string" &&
        HELM_MARKERS.includes(h._tldr_agent),
    )?._tldr_agent || null
  );
}

function isExecutable(path) {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// PRFAQ-0-7 B-T3.2 — read-only inspection of installed Helm hooks.
// Returns shape suitable for behavior.hooks.<runtime>_hooks_installed and
// for the verify stage's FOR hint generation. Picks up PRFAQ-0-6's eventual
// PreToolUse/PostToolUse hooks automatically (HOOK_FILES is the source of
// truth for the event taxonomy).
export function inspectInstalledHooks({ runtime } = {}) {
  if (!runtime) {
    return { ok: false, error: "missing_runtime" };
  }
  const file = settingsPath(runtime);
  const { exists, value } = readSettings(file);
  const events = {};
  for (const event of Object.keys(HOOK_FILES)) {
    const groups =
      exists && Array.isArray(value?.hooks?.[event]) ? value.hooks[event] : [];
    const helmGroup = groups.find((group) => isCurrentHelmGroup(group, event));
    const legacyHelmGroup = groups.find(isHelmGroup);
    const scriptPath = hookScriptPath(HOOK_FILES[event]);
    const markerDetected = detectedHelmMarker(helmGroup);
    const legacyMarkerDetected = detectedHelmMarker(legacyHelmGroup);
    const commandEntry =
      helmGroup?.hooks?.find((h) => h?.type === "command") ||
      legacyHelmGroup?.hooks?.find((h) => h?.type === "command");
    events[event] = {
      installed: Boolean(helmGroup),
      command: commandEntry?.command || null,
      marker_present: Boolean(markerDetected),
      marker_detected: markerDetected || legacyMarkerDetected,
      script_exists: existsSync(scriptPath),
      script_executable: isExecutable(scriptPath),
    };
  }
  return { runtime, file, events };
}

function planChanges(settings, action) {
  const next = JSON.parse(JSON.stringify(settings.value || {}));
  if (!next.hooks || typeof next.hooks !== "object") next.hooks = {};
  const changes = [];
  for (const event of Object.keys(HOOK_FILES)) {
    const existing = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    if (action === "install") {
      const desired = buildHookGroup(event);
      const filtered = existing.filter((g) => !isRemovableHelmGroup(g, event));
      const helmish = existing.filter((g) => isRemovableHelmGroup(g, event));
      if (helmish.length === 0) {
        changes.push({
          event,
          op: "add",
          command: hookScriptPath(HOOK_FILES[event]),
        });
        next.hooks[event] = [...existing, desired];
      } else {
        const prev = helmish.find(isHelmGroup) || helmish[0];
        // Idempotent re-install: refresh the command path in case helm moved.
        const prevCommand = prev?.hooks?.[0]?.command;
        const nextCommand = hookScriptPath(HOOK_FILES[event]);
        const prevMarker = detectedHelmMarker(prev);
        const prevTimeout = prev?.hooks?.find(
          (hook) => hook?.type === "command" && hook?.command === nextCommand,
        )?.timeout;
        if (
          prevCommand !== nextCommand ||
          prevMarker !== HELM_MARKER ||
          (event === "Stop" &&
            prevTimeout !== TACHYON_STOP_HOOK_TIMEOUT_SECONDS) ||
          helmish.length > 1
        ) {
          changes.push({
            event,
            op: "refresh",
            from: prevCommand,
            to: nextCommand,
            from_marker: prevMarker,
            to_marker: HELM_MARKER,
          });
          next.hooks[event] = [...filtered, desired];
        } else {
          changes.push({ event, op: "noop", command: nextCommand });
        }
      }
    } else if (action === "uninstall") {
      const filtered = existing.filter((g) => !isRemovableHelmGroup(g, event));
      if (filtered.length !== existing.length) {
        changes.push({ event, op: "remove" });
      } else {
        changes.push({ event, op: "absent" });
      }
      if (filtered.length === 0) {
        delete next.hooks[event];
      } else {
        next.hooks[event] = filtered;
      }
    }
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
    const { next, changes } = planChanges(settings, action);
    const entry = {
      runtime: rt,
      file,
      settings_existed: settings.exists,
      changes,
    };
    if (dryRun) {
      entry.status = "dry_run";
      entry.preview = next;
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
    hook_marker: HELM_MARKER,
    helm_marker: HELM_MARKER,
    hook_files: HOOK_FILES,
  };
}

export const _internals = {
  HELM_MARKER,
  HELM_MARKERS,
  HOOK_FILES,
  LEGACY_HOOK_FILES,
  hookScriptPath,
  settingsPath,
  planChanges,
  helmRepoRoot,
  isHelmGroup,
  isCurrentHelmGroup,
  isExecutable,
};
