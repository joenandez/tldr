#!/usr/bin/env node

// Must stay first: installs the node:sqlite ExperimentalWarning filter before
// the Starport runtime imports node:sqlite through its dependency graph.
import "./lib/node_sqlite_warning.mjs";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createProductionStarportRuntime } from "./lib/starport_runtime.mjs";

const OPERATIONS = new Set([
  "setup",
  "status",
  "configure",
  "repair",
  "uninstall",
]);

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
  { createRuntime = createProductionStarportRuntime } = {},
) {
  if (!OPERATIONS.has(operation)) return unsupported();
  try {
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
  const operation = args[0] ?? "configure";
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
