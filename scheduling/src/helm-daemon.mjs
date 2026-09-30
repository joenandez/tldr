#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fail, parseArgs } from "./lib/json_io.mjs";
import { resolveScope } from "./lib/store.mjs";
import { runDaemonCommand } from "./lib/daemon_entrypoint.mjs";

function defaultSchedulerScriptPath() {
  return join(dirname(fileURLToPath(import.meta.url)), "helm-tasks.mjs");
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
  const scope = resolveScope({
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
