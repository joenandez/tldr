#!/usr/bin/env node

// Must stay first: installs the node:sqlite ExperimentalWarning filter before
// the Starport runtime imports node:sqlite through its dependency graph.
import "./lib/node_sqlite_warning.mjs";
import { defaultStarportOperation } from "./lib/tldr_agent_gui_session.mjs";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import {
  EMAIL_DISCONNECT_OPERATIONS,
  runEmailDisconnectOperation,
} from "./lib/email_disconnect_entry.mjs";
import {
  PRODUCT_UNINSTALL,
  runProductUninstallOperation,
} from "./lib/product_uninstall_entry.mjs";
import { createProductionStarportRuntime } from "./lib/starport_runtime.mjs";
import {
  COPILOT_RUNTIME_RETRY,
  registerOwnCopilotRuntime,
  runCommand,
} from "./lib/copilot_runtime_registration.mjs";
import { defaultTightbeamInvocation } from "./lib/tightbeam_channel_runtime.mjs";

// The disconnect and product-uninstall operations are for the signed app
// only; the agent-facing bootstrap front door does not admit them.
const OPERATIONS = new Set([
  "setup",
  "status",
  "configure",
  "repair",
  "uninstall",
  ...EMAIL_DISCONNECT_OPERATIONS,
  PRODUCT_UNINSTALL,
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

// The bootstrap runs this file from the ~/.tldr-agents/agent/install/tldr-agent
// copy, which is the native runtime only: its front door has no activation
// manifest, so its Copilot hooks cannot run. The package that ran setup (the
// bootstrap's --package-root) is the active tldr; an ambient Claude plugin
// path is never registered.
function setupPackageRoot() {
  const root = process.env.TLDR_AGENT_SETUP_PACKAGE_ROOT;
  // Required: without it only the copy is known, and its hooks would refuse every session.
  if (!root) {
    throw Object.assign(
      new Error(
        "the package that ran setup is unknown; run it through tldr-agents setup",
      ),
      { code: "copilot_runtime_package_root_missing" },
    );
  }
  return root;
}

function copilotRuntimeFailure(error) {
  return Object.freeze({
    ok: false,
    data: null,
    error: Object.freeze({
      code: error?.code ?? "copilot_runtime_failed",
      message: `tldr; could not register its Copilot runtime: ${error?.message}`,
      retryable: true,
      remediation: COPILOT_RUNTIME_RETRY,
    }),
  });
}

// Ensure the messaging daemon (bootstrap is idempotent), then register the
// setup package's Copilot hooks file through this copy's Tightbeam entrypoint.
export async function registerInstalledCopilotRuntime({
  messaging = (args) => {
    const { command, commandPrefix = [] } = defaultTightbeamInvocation();
    return runCommand(command, [...commandPrefix, ...args]);
  },
} = {}) {
  const packageRoot = setupPackageRoot();
  if (!(await messaging(["bootstrap"])).ok) {
    throw Object.assign(new Error("messaging bootstrap failed"), {
      code: "copilot_runtime_bootstrap_failed",
    });
  }
  return registerOwnCopilotRuntime({ packageRoot, messaging });
}

// Setup and repair register the Copilot runtime after the native operation
// returns ok; a registration failure fails the operation (A2).
export function withCopilotRuntime(
  runtime,
  register = registerInstalledCopilotRuntime,
) {
  const addCopilotRuntime = (result) =>
    register().then(
      (copilot) => ({
        ...result,
        data: { ...result.data, copilot_runtime: copilot },
      }),
      copilotRuntimeFailure,
    );
  const registered = (operation) => async () => {
    const result = await runtime[operation]();
    return result?.ok ? addCopilotRuntime(result) : result;
  };
  return {
    ...runtime,
    setup: registered("setup"),
    repair: registered("repair"),
  };
}

const createInstalledRuntime = async () =>
  withCopilotRuntime(await createProductionStarportRuntime());

export async function dispatchStarportOperation(
  operation,
  {
    createRuntime = createInstalledRuntime,
    openApp = () => JSON.parse(runAppLauncher("configure")),
    emailDisconnect = runEmailDisconnectOperation,
    productUninstall = runProductUninstallOperation,
  } = {},
) {
  if (!OPERATIONS.has(operation)) return unsupported();
  try {
    if (operation === "configure") return await openApp();
    if (operation === PRODUCT_UNINSTALL) return await productUninstall();
    if (EMAIL_DISCONNECT_OPERATIONS.has(operation)) {
      return await emailDisconnect(operation);
    }
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
