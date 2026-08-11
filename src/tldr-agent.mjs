#!/usr/bin/env node

// Must stay first: installs the node:sqlite ExperimentalWarning filter before
// any module that imports node:sqlite is evaluated.
import "./lib/node_sqlite_warning.mjs";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  dispatchTldrAgent,
  findForbiddenRecipientSelector,
  renderTldrAgentHelp,
} from "./lib/tldr_agent_cli.mjs";

export { dispatchTldrAgent } from "./lib/tldr_agent_cli.mjs";

export function configureTldrAgentProcessEnv({
  env = process.env,
  userHome = homedir(),
} = {}) {
  const home = resolve(env.TLDR_AGENT_HOME || join(userHome, ".tldr-agent"));
  env.TLDR_AGENT_HOME = home;
  // Retained internals still consume this compatibility name. The public
  // binary owns its value so ambient Helm configuration cannot redirect it.
  env.HELM_HOME = home;
  env.HELM_CANONICAL_SQLITE = "1";
  delete env.HELM_CANONICAL_SQLITE_KILL_SWITCH;
  return { home, sqlite: true };
}

export function tldrAgentHelp({ json = false } = {}) {
  return renderTldrAgentHelp(null, { json });
}

function helpCommand(args) {
  if (args[0] === "inbox" && args[1] === "get") return "inbox get";
  if (args[0] === "logs" && args[1] === "purge") return "logs purge";
  if (args[0] === "diagnostics" && ["create", "inspect"].includes(args[1])) {
    return `diagnostics ${args[1]}`;
  }
  if (
    args[0] === "followup" &&
    ["require", "complete", "cancel"].includes(args[1])
  ) {
    return `followup ${args[1]}`;
  }
  if (
    ["send", "reply", "status", "update", "uninstall", "logs"].includes(args[0])
  ) {
    return args[0];
  }
  return null;
}

export async function main(
  args = process.argv.slice(2),
  { dispatch = dispatchTldrAgent } = {},
) {
  if (findForbiddenRecipientSelector(args)) {
    const result = await dispatchTldrAgent(args);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 1;
    return;
  }
  const helpRequested =
    args[0] === "help" ||
    args.includes("--help") ||
    args.includes("--help-json");
  if (helpRequested) {
    process.stdout.write(
      renderTldrAgentHelp(helpCommand(args), {
        json: args.includes("--help-json"),
      }),
    );
    return;
  }
  if (process.platform === "darwin") {
    configureTldrAgentProcessEnv();
  }
  const result = await dispatch(args);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
})();
if (isMain) await main();
