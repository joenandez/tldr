#!/usr/bin/env node

// Must stay first: installs the node:sqlite ExperimentalWarning filter before
// the Starport runtime imports node:sqlite through its dependency graph.
import "./lib/node_sqlite_warning.mjs";
import { defaultStarportOperation } from "./lib/tldr_agent_gui_session.mjs";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { createProductionStarportRuntime } from "./lib/starport_runtime.mjs";

const OPERATIONS = new Set([
  "setup",
  "status",
  "configure",
  "repair",
  "uninstall",
]);

function runAppLauncher(operation) {
  const launcher = fileURLToPath(
    new URL("../install/tldr-agent-bootstrap.sh", import.meta.url),
  );
  try {
    return execFileSync("/bin/sh", [launcher, "--operation", operation], {
      encoding: "utf8",
      timeout: 15_000,
    });
  } catch (error) {
    if (error.stdout) return String(error.stdout);
    throw error;
  }
}

function unsupported() {
  return Object.freeze({
    ok: false,
    data: null,
    error: Object.freeze({
      code: "STARPORT_OPERATION_UNSUPPORTED",
      message: "tldr; does not support that lifecycle operation.",
      retryable: false,
      remediation: "Check tldr;",
    }),
  });
}

function unavailable(error) {
  if (error?.code === "STARPORT_INSTALLATION_INACCESSIBLE") {
    return Object.freeze({
      ok: false,
      data: null,
      error: Object.freeze({
        code: "STARPORT_INSTALLATION_INACCESSIBLE",
        message: "tldr; secure setup is installed but unavailable.",
        retryable: false,
        remediation: "Reinstall tldr;",
      }),
    });
  }
  if (error?.code === "STARPORT_INSTALLATION_INCOMPLETE") {
    return Object.freeze({
      ok: false,
      data: null,
      error: Object.freeze({
        code: "STARPORT_INSTALLATION_INCOMPLETE",
        message: "tldr; installation did not complete.",
        retryable: true,
        remediation: "Set up tldr;",
      }),
    });
  }
  if (error?.code === "STARPORT_RELEASE_INVALID") {
    return Object.freeze({
      ok: false,
      data: null,
      error: Object.freeze({
        code: "STARPORT_RELEASE_INVALID",
        message: "tldr; release verification failed.",
        retryable: false,
        remediation: "Reinstall tldr;",
      }),
    });
  }
  return Object.freeze({
    ok: false,
    data: null,
    error: Object.freeze({
      code: "STARPORT_UNAVAILABLE",
      message: "tldr; could not complete the lifecycle operation.",
      retryable: true,
      remediation: "Repair tldr;",
    }),
  });
}

export async function dispatchStarportOperation(
  operation,
  {
    createRuntime = createProductionStarportRuntime,
    openApp = () => JSON.parse(runAppLauncher("configure")),
  } = {},
) {
  if (!OPERATIONS.has(operation)) return unsupported();
  try {
    if (operation === "configure") return await openApp();
    const runtime = await createRuntime();
    if (typeof runtime?.[operation] !== "function") return unsupported();
    return await runtime[operation]();
  } catch (error) {
    return unavailable(error);
  }
}

export async function main(
  args = process.argv.slice(2),
  {
    dispatch = dispatchStarportOperation,
    write = (value) => process.stdout.write(value),
    setExitCode = (value) => {
      process.exitCode = value;
    },
  } = {},
) {
  const operation = args[0] ?? defaultStarportOperation();
  if (
    ["--help", "-h", "help"].includes(operation) ||
    (OPERATIONS.has(operation) &&
      args.some((arg) => ["--help", "-h"].includes(arg)))
  ) {
    write(runAppLauncher("--help"));
    return null;
  }
  if (args.slice(1).some((argument) => argument !== "--json")) {
    const invalid = unsupported();
    write(`${JSON.stringify(invalid)}\n`);
    setExitCode(1);
    return invalid;
  }
  const result = await dispatch(operation);
  write(`${JSON.stringify(result)}\n`);
  if (!result.ok) setExitCode(1);
  return result;
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

export const _internals = Object.freeze({ OPERATIONS });
