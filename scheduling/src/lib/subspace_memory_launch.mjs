import { accessSync, constants, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const STANDALONE_ENV_COMMAND = "/usr/bin/env";

export function buildMemoryContext(cwd) {
  return JSON.stringify({ workspace_cwd: cwd });
}

function isReadable(path) {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function effectiveClaudeSettings(path) {
  try {
    const settings = JSON.parse(readFileSync(path, "utf8"));
    let changed = false;
    for (const group of settings?.hooks?.Stop || []) {
      for (const hook of group?.hooks || []) {
        if (
          hook?.async === true &&
          typeof hook.command === "string" &&
          hook.command.includes("subspace-memory") &&
          hook.command.includes("stop-lifecycle")
        ) {
          hook.async = false;
          changed = true;
        }
      }
    }
    return changed ? JSON.stringify(settings) : path;
  } catch {
    return path;
  }
}

function withSubspaceClaudeSettings(command, args, env) {
  const settings = join(
    env.SUBSPACE_HOME || "",
    "claude-code-subspace-settings.json",
  );
  if (!env.SUBSPACE_HOME || !isReadable(settings)) return { command, args };
  const effectiveSettings = effectiveClaudeSettings(settings);

  const commandName = basename(command);
  if (
    ["sh", "bash", "zsh"].includes(commandName) &&
    args[0] === "-c" &&
    typeof args[1] === "string" &&
    args[1].includes('"$0" "$@"') &&
    typeof args[2] === "string"
  ) {
    const nested = withSubspaceClaudeSettings(args[2], args.slice(3), env);
    return {
      command,
      args: [...args.slice(0, 2), nested.command, ...nested.args],
    };
  }
  if (commandName === "claude") {
    if (args.includes("--settings")) return { command, args };
    return { command, args: ["--settings", effectiveSettings, ...args] };
  }
  if (commandName !== "academy" || args[0] !== "run") {
    return { command, args };
  }

  const separator = args.indexOf("--");
  const academyArgs = separator === -1 ? args : args.slice(0, separator);
  const usesCodex = academyArgs.some(
    (arg, index) =>
      arg === "--agent=codex" ||
      (arg === "--agent" && academyArgs[index + 1] === "codex"),
  );
  if (usesCodex || args.includes("--settings")) return { command, args };
  if (separator === -1) {
    return {
      command,
      args: [...args, "--", "--settings", effectiveSettings],
    };
  }
  return {
    command,
    args: [
      ...args.slice(0, separator + 1),
      "--settings",
      effectiveSettings,
      ...args.slice(separator + 1),
    ],
  };
}

export function buildSubspaceMemoryLaunch({
  command,
  args,
  env,
  cwd,
  requestedMode,
}) {
  const configured = withSubspaceClaudeSettings(command, args, env);
  return {
    args: [
      STANDALONE_ENV_COMMAND,
      "-u",
      "GROVE_PANE_ID",
      "-u",
      "SUBSPACE_PANE_ID",
      configured.command,
      ...configured.args,
    ],
    env: {
      ...env,
      GROVE_MEMORY_ENABLED: "1",
      HELM_MEMORY_CONTEXT: buildMemoryContext(cwd),
      HELM_MEMORY_MODE: requestedMode,
    },
  };
}
