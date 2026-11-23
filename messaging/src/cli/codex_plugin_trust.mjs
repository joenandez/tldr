// Codex plugin hook trust, mirrored from codex-rs (hooks/src/engine): the
// per-hook declaration hash and, since Codex 0.169, the plugin bundle pin.
// Read-only: this never writes Codex trust.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { TIGHTBEAM_MARKER } from "./hooks_install.mjs";

const CODEX_HOOK_EVENT_KEYS = Object.freeze({
  PreToolUse: "pre_tool_use",
  PermissionRequest: "permission_request",
  PostToolUse: "post_tool_use",
  PreCompact: "pre_compact",
  PostCompact: "post_compact",
  SessionStart: "session_start",
  SessionEnd: "session_end",
  UserPromptSubmit: "user_prompt_submit",
  SubagentStart: "subagent_start",
  SubagentStop: "subagent_stop",
  Stop: "stop",
  Interrupt: "interrupt",
});

const CODEX_MATCHER_EVENTS = new Set([
  "pre_tool_use",
  "permission_request",
  "post_tool_use",
  "pre_compact",
  "post_compact",
  "session_start",
  "session_end",
  "subagent_start",
  "subagent_stop",
]);

const CODEX_ADDITIONAL_CONTEXT_EVENTS = new Set([
  "pre_tool_use",
  "post_tool_use",
  "session_start",
  "user_prompt_submit",
  "subagent_start",
]);

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJson(value[key])]),
  );
}

function normalizedCodexCommandHandler(eventKey, handler) {
  if (!handler || handler.type !== "command") return null;
  const platformCommand =
    process.platform === "win32"
      ? (handler.commandWindows ?? handler.command_windows ?? handler.command)
      : handler.command;
  if (
    typeof platformCommand !== "string" ||
    platformCommand.trim().length === 0
  )
    return null;
  const requestedTimeout = handler.timeout;
  if (
    requestedTimeout !== undefined &&
    (!Number.isSafeInteger(requestedTimeout) || requestedTimeout < 0)
  )
    return null;
  const timeout =
    eventKey === "session_end" || eventKey === "interrupt"
      ? Math.min(3, Math.max(1, requestedTimeout ?? 1))
      : Math.max(1, requestedTimeout ?? 600);
  const normalized = {
    type: "command",
    command: platformCommand,
    timeout,
    async: handler.async === true,
  };
  if (typeof handler.statusMessage === "string")
    normalized.statusMessage = handler.statusMessage;
  if (
    CODEX_ADDITIONAL_CONTEXT_EVENTS.has(eventKey) &&
    Number.isSafeInteger(handler.additionalContextLimit) &&
    handler.additionalContextLimit >= 0 &&
    handler.additionalContextLimit !== 2500
  ) {
    normalized.additionalContextLimit = handler.additionalContextLimit;
  }
  return normalized;
}

function codexHookHash(eventKey, group, handler) {
  const normalizedHandler = normalizedCodexCommandHandler(eventKey, handler);
  if (!normalizedHandler) return null;
  const identity = { event_name: eventKey };
  if (CODEX_MATCHER_EVENTS.has(eventKey) && typeof group.matcher === "string")
    identity.matcher = group.matcher;
  identity.hooks = [normalizedHandler];
  const serialized = JSON.stringify(canonicalJson(identity));
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}

function u64le(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
}

/**
 * Codex's plugin bundle fingerprint ("codex-plugin-bundle-v1", codex-rs
 * hooks/src/engine/plugin_fingerprint.rs). Since Codex 0.169 a hook approval
 * pins this hash of the whole plugin folder, and Codex refuses the plugin's
 * hooks once any file in it changes. Returns null for an entry Codex cannot
 * fingerprint (a symlink or special file), which Codex treats as untrusted.
 */
export function codexPluginBundleFingerprint(root) {
  const hash = createHash("sha256").update("codex-plugin-bundle-v1");
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const relative = path.relative(root, current);
    if (relative && BUNDLE_EXCLUDED.test(path.basename(relative))) continue;
    if (!hashBundleEntry({ hash, pending }, current, relative)) return null;
  }
  return `sha256:${hash.digest("hex")}`;
}

const BUNDLE_EXCLUDED = /^(?:__pycache__|\.venv)$|\.(?:pyc|egg-info)$/u;

// Depth-first, children in byte order, matching Codex's walk.
function hashBundleEntry({ hash, pending }, current, relative) {
  const nameBytes = Buffer.from(relative);
  hash.update(u64le(nameBytes.length)).update(nameBytes);
  const stat = fs.lstatSync(current);
  if (stat.isDirectory()) {
    hash.update("directory");
    const entries = fs
      .readdirSync(current)
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    for (const entry of entries.reverse())
      pending.push(path.join(current, entry));
    return true;
  }
  if (!stat.isFile()) return false;
  const bytes = fs.readFileSync(current);
  hash.update("file").update(u64le(bytes.length)).update(bytes);
  return true;
}

function codexPluginIdentity(codexHome, hookFile) {
  const cacheRoot = path.join(codexHome, "plugins", "cache");
  const relative = path.relative(cacheRoot, hookFile);
  const parts = relative.split(path.sep);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    parts.length < 5
  )
    return null;
  const [marketplace, plugin, , ...sourceParts] = parts;
  if (!marketplace || !plugin || sourceParts.length === 0) return null;
  return {
    pluginId: `${plugin}@${marketplace}`,
    sourceRelativePath: sourceParts.join("/"),
    root: path.join(cacheRoot, marketplace, plugin, parts[2]),
  };
}

function codexHookStates(config) {
  const states = new Map();
  let current = null;
  for (const line of config.split(/\r?\n/)) {
    const header = line.match(
      /^\s*\[hooks\.state\."((?:\\.|[^"\\])*)"\]\s*(?:#.*)?$/,
    );
    if (header) {
      try {
        current = JSON.parse(`"${header[1]}"`);
      } catch {
        current = null;
      }
      if (current !== null && !states.has(current)) states.set(current, {});
      continue;
    }
    if (/^\s*\[/.test(line)) {
      current = null;
      continue;
    }
    if (current === null) continue;
    const trustedHash = line.match(
      /^\s*trusted_hash\s*=\s*"([^"]+)"\s*(?:#.*)?$/,
    );
    if (trustedHash) {
      states.get(current).trustedHash = trustedHash[1];
      continue;
    }
    const trustedContentHash = line.match(
      /^\s*trusted_content_hash\s*=\s*"([^"]+)"\s*(?:#.*)?$/,
    );
    if (trustedContentHash) {
      states.get(current).trustedContentHash = trustedContentHash[1];
      continue;
    }
    const enabled = line.match(/^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/);
    if (enabled) states.get(current).enabled = enabled[1] === "true";
  }
  return states;
}

export function expectedCodexPluginTrust(codexHome, hookFile) {
  const identity = codexPluginIdentity(codexHome, hookFile);
  if (!identity) return null;
  let hooks;
  try {
    hooks = JSON.parse(fs.readFileSync(hookFile, "utf8")).hooks;
  } catch {
    return null;
  }
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return null;
  const expected = [];
  for (const [eventName, groups] of Object.entries(hooks)) {
    const eventKey = CODEX_HOOK_EVENT_KEYS[eventName];
    if (!eventKey || !Array.isArray(groups)) continue;
    for (const [groupIndex, group] of groups.entries()) {
      if (!group || !Array.isArray(group.hooks)) continue;
      for (const [handlerIndex, handler] of group.hooks.entries()) {
        if (handler?._tightbeam !== TIGHTBEAM_MARKER) continue;
        const trustedHash = codexHookHash(eventKey, group, handler);
        if (!trustedHash) return null;
        expected.push({
          key: `${identity.pluginId}:${identity.sourceRelativePath}:${eventKey}:${groupIndex}:${handlerIndex}`,
          trustedHash,
        });
      }
    }
  }
  return expected.length > 0 ? expected : null;
}

export function codexPluginTrustPresent(codexHome, hookFile) {
  let config;
  try {
    config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
  } catch {
    return false;
  }
  if (/^\s*bypass_hook_trust\s*=\s*true\s*$/m.test(config)) return true;
  const expected = expectedCodexPluginTrust(codexHome, hookFile);
  if (!expected) return false;
  const states = codexHookStates(config);
  const declared = expected.every(({ key, trustedHash }) => {
    const state = states.get(key);
    return state?.enabled !== false && state?.trustedHash === trustedHash;
  });
  if (!declared) return false;
  // Codex 0.169+ also pins the bundle; a pin from another build means Codex refuses the hooks.
  const identity = codexPluginIdentity(codexHome, hookFile);
  let bundle;
  try {
    bundle = codexPluginBundleFingerprint(identity.root);
  } catch {
    return false;
  }
  if (!bundle) return false;
  // Codex reads the legacy baseline even when a pin matches; an unreadable one skips the hook.
  const baseline = codexLegacyTrustBaseline(codexHome, identity.pluginId);
  if (baseline === undefined) return false;
  return expected.every(({ key }) => {
    const pinned = states.get(key).trustedContentHash ?? baseline;
    // No pin and no legacy baseline: Codex pins this bundle on its first run.
    return pinned === null || pinned === bundle;
  });
}

// Codex keeps a pre-pin ("legacy") approval's bundle baseline in
// <CODEX_HOME>/.hook-trust/<sha256 of the length-prefixed config path and plugin id>
// (codex-rs hooks/src/engine/plugin_trust.rs legacy_trust_path). Codex may key
// it on the canonical CODEX_HOME, so read both spellings and fail closed if
// they disagree. Returns null when absent, undefined when unreadable or split.
function codexLegacyTrustBaseline(codexHome, pluginId) {
  const values = new Set(
    codexHomeSpellings(codexHome).map((keyHome) =>
      readLegacyBaseline(codexHome, keyHome, pluginId),
    ),
  );
  values.delete(null);
  if (values.size === 0) return null;
  return values.size === 1 ? [...values][0] : undefined;
}

function codexHomeSpellings(codexHome) {
  try {
    return [codexHome, fs.realpathSync(codexHome)];
  } catch {
    return [codexHome];
  }
}

function readLegacyBaseline(codexHome, keyHome, pluginId) {
  const id = createHash("sha256");
  for (const part of [
    Buffer.from(path.join(keyHome, "config.toml")),
    Buffer.from(pluginId),
  ])
    id.update(u64le(part.length)).update(part);
  try {
    return fs.readFileSync(
      path.join(codexHome, ".hook-trust", id.digest("hex")),
      "utf8",
    );
  } catch (err) {
    return err.code === "ENOENT" ? null : undefined;
  }
}
