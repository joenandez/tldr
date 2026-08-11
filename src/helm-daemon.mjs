#!/usr/bin/env node
// Must stay first: installs the node:sqlite ExperimentalWarning filter before
// any module that imports node:sqlite is evaluated.
import "./lib/node_sqlite_warning.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fail, parseArgs } from "./lib/json_io.mjs";
import { resolveDaemonCommandScope } from "./lib/tldr_agent_daemon_scope.mjs";
import { runDaemonCommand } from "./lib/daemon_entrypoint.mjs";

function defaultSchedulerScriptPath() {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    "tldr-agent-private-runner.mjs",
  );
}

async function run() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const pretty = Boolean(flags.pretty);
  const legacyDaemonRun =
    positionals.length === 2 &&
    positionals[0] === "daemon" &&
    positionals[1] === "run";
  if (positionals.length > 0 && !legacyDaemonRun) {
    fail(
      "daemon.run",
      "unknown_command",
      `unknown daemon runner command '${positionals.join(" ")}'`,
      { usage: "helm-daemon [--once] [--interval-sec N]" },
      pretty,
    );
    process.exit(2);
  }
  const scope = resolveDaemonCommandScope({
    cwd:
      flags.scope || flags.cwd || process.env.HELM_SCOPE_CWD || process.cwd(),
  });
  await runDaemonCommand({
    flags,
    scope,
    schedulerScriptPath:
      flags["scheduler-script"] || defaultSchedulerScriptPath(),
    command: "daemon.run",
    pretty,
  });
}

run().catch((err) => {
  fail(
    "runtime",
    "runtime_error",
    String(err?.message || err),
    { stack: err?.stack || "" },
    false,
  );
  process.exit(1);
});
