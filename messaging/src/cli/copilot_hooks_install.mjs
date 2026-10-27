import { rmSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import {
  unifiedPackageFrontDoorPath,
  unifiedPackageTightbeamPath,
} from "./package_context.mjs";
import {
  atomicWriteHookSettings,
  readHookSettings,
  serializeHookSettings,
} from "./hooks_install_io.mjs";
import { isCopilotPluginHooksPath } from "../runtimes/copilot_contract.mjs";

export const COPILOT_HOOK_MARKER = "tightbeam-managed:copilot-hooks-v1";
export const COPILOT_HOOK_EVENTS = Object.freeze([
  "sessionStart",
  "userPromptSubmitted",
  "postToolUse",
]);
const HOOK_VERBS = Object.freeze({
  sessionStart: "session-start",
  userPromptSubmitted: "user-prompt-submit",
  postToolUse: "post-tool-use",
});

export function hookInstallRuntimeIds(
  registry,
  { action, runtime, settingsFile },
) {
  if (settingsFile !== undefined || runtime !== null) return [runtime];
  return registry
    .names()
    .filter(
      (id) =>
        action !== "install" ||
        registry.get(id)?.hooksInstall?.format !== "copilot-json",
    );
}

// The exact hooks.json the source-owned .copilot-plugin ships for a runtime
// id: the three admitted callbacks through the sibling front door, no Stop.
export function copilotPluginHooks(runtime) {
  const command = (verb) => ({
    type: "command",
    command: `"\${CLAUDE_PLUGIN_ROOT}/../bin/tldr-agents" messaging hook ${verb} --runtime ${runtime}`,
  });
  return {
    hooks: {
      SessionStart: [{ matcher: "*", hooks: [command("session-start")] }],
      UserPromptSubmit: [{ hooks: [command("user-prompt-submit")] }],
      PostToolUse: [{ hooks: [command("post-tool-use")] }],
    },
  };
}

// A registered plugin artifact is package content: install only verifies it
// and uninstall leaves it; neither ever writes it.
function verifyCopilotPlugin({ action, id, file, report }) {
  const settings = readHookSettings(file);
  if (
    action === "install" &&
    !isDeepStrictEqual(settings.value, copilotPluginHooks(id))
  ) {
    const error = new Error(
      `${file} is not the source-owned tldr Copilot plugin for runtime ${id}; hooks install never rewrites it`,
    );
    error.code = "copilot_plugin_mismatch";
    throw error;
  }
  report.push({
    runtime: id,
    file,
    settings_existed: settings.exists,
    changes: [],
    status: action === "install" ? "verified" : "source_owned",
  });
  return true;
}

function shellQuote(value) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

function owned(entry) {
  return (
    entry?.type === "command" &&
    typeof entry.bash === "string" &&
    entry.bash.startsWith(`: '${COPILOT_HOOK_MARKER}' && `)
  );
}

function commandFor(event, runtime, { packageRoot }) {
  const cli = unifiedPackageTightbeamPath(packageRoot);
  const frontDoor = unifiedPackageFrontDoorPath(packageRoot);
  if (cli === null || frontDoor === null) {
    const error = new Error(
      `no tldr-agents package at ${packageRoot}; Copilot hooks install only from the unified package`,
    );
    error.code = "unified_package_missing";
    throw error;
  }
  const marker = `: '${COPILOT_HOOK_MARKER}' && `;
  return `${marker}${shellQuote(frontDoor)} messaging hook ${HOOK_VERBS[event]} --runtime ${shellQuote(runtime)}`;
}

function replaceOwnedEntries(existing, desired) {
  let kept = false;
  const entries = [];
  for (const entry of existing) {
    if (!owned(entry)) entries.push(entry);
    else if (!kept) {
      entries.push(desired);
      kept = true;
    }
  }
  if (!kept) entries.push(desired);
  return entries;
}

function planInstallEvent(event, existing, options) {
  const desired = {
    type: "command",
    bash: commandFor(event, options.runtime, options),
    timeoutSec: 10,
  };
  const ours = existing.filter(owned);
  const entries = replaceOwnedEntries(existing, desired);
  const unchanged =
    ours.length === 1 &&
    ours[0].bash === desired.bash &&
    ours[0].timeoutSec === desired.timeoutSec;
  const operation = ours.length === 0 ? "add" : unchanged ? "noop" : "refresh";
  return { entries, change: { event, op: operation, bash: desired.bash } };
}

function planUninstallEvent(event, existing) {
  const entries = existing.filter((entry) => !owned(entry));
  return {
    entries,
    change: {
      event,
      op: entries.length === existing.length ? "absent" : "remove",
    },
  };
}

export function planCopilotHookChanges(settings, action, options) {
  const next = prepareCopilotSettings(settings, action);
  const changes = COPILOT_HOOK_EVENTS.map((event) =>
    updateCopilotEvent({ next, event, action, options }),
  );
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return { next, changes };
}

export function planCopilotHookRollback(settings) {
  return planCopilotHookChanges(settings, "uninstall", {
    runtime: null,
    packageRoot: null,
  });
}

function prepareCopilotSettings(settings, action) {
  const next = structuredClone(settings.value ?? {});
  if (action === "install") {
    if (next.version !== undefined && next.version !== 1) {
      const error = new Error(
        "Copilot project hooks settings require version 1",
      );
      error.code = "unsupported_copilot_hooks_version";
      throw error;
    }
    next.version = 1;
  }
  if (next.hooks === undefined) next.hooks = {};
  else if (
    !next.hooks ||
    typeof next.hooks !== "object" ||
    Array.isArray(next.hooks)
  )
    throw malformedHooksSettings("hooks must be an object");
  for (const event of COPILOT_HOOK_EVENTS) {
    if (next.hooks[event] !== undefined && !Array.isArray(next.hooks[event])) {
      throw malformedHooksSettings(`hooks.${event} must be an array`);
    }
  }
  return next;
}

function malformedHooksSettings(detail) {
  const error = new Error(
    `malformed Copilot project hooks settings: ${detail}`,
  );
  error.code = "malformed_copilot_hooks_settings";
  return error;
}

function updateCopilotEvent({ next, event, action, options }) {
  const existing = next.hooks[event] ?? [];
  const planned =
    action === "install"
      ? planInstallEvent(event, existing, options)
      : planUninstallEvent(event, existing);
  if (planned.entries.length === 0) delete next.hooks[event];
  else next.hooks[event] = planned.entries;
  return planned.change;
}

export function installCopilotHooks({
  action,
  id,
  record,
  file,
  packageRoot,
  dryRun = false,
  report,
}) {
  if (record?.hooksInstall.format !== "copilot-json") return false;
  if (isCopilotPluginHooksPath(record.hooksInstall.settingsPath))
    return verifyCopilotPlugin({ action, id, file, report });
  const settings = readHookSettings(file);
  const { next, changes } = planCopilotHookChanges(settings, action, {
    runtime: id,
    packageRoot,
  });
  const contents = serializeHookSettings(next);
  const entry = {
    runtime: id,
    file,
    settings_existed: settings.exists,
    changes,
  };
  if (dryRun) {
    entry.status = "dry_run";
    entry.preview = next;
  } else if (settings.exists && settings.raw === contents) {
    entry.status = "unchanged";
  } else if (
    action === "uninstall" &&
    settings.exists &&
    Object.keys(next).length === 0
  ) {
    rmSync(file, { force: true });
    entry.status = "removed";
  } else if (!settings.exists && Object.keys(next).length === 0) {
    entry.status = "absent";
  } else {
    atomicWriteHookSettings(file, contents);
    entry.status = "written";
  }
  report.push(entry);
  return true;
}
