import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  requestAegisSetupStateSafe,
  requestAegisStatusSafe,
} from "./aegis_client.mjs";
import {
  updateAegisRelease,
  validateReleaseManifest,
} from "./aegis_native_distribution.mjs";
import { PROTOCOL_VERSION } from "./aegis_protocol.mjs";
import { installVerifiedSourceRelease } from "./aegis_source_release_install.mjs";
import { createTldrAgentSourceInstallLifecycle } from "./tldr_agent_source_lifecycle.mjs";
import { tldrAgentSourceIdentity } from "./tldr_agent_runtime_identity.mjs";
import {
  inspectDefaultUninstallResidue,
  observeNativeSetup,
  observeNativeUninstall,
} from "./starport_native_lifecycle.mjs";

const NATIVE_SETUP_APP =
  "/Library/Application Support/Codename/Aegis/TldrAgentAegis.app";
const SETUP_EXECUTABLE = `${NATIVE_SETUP_APP}/Contents/MacOS/TldrAgentAegisSetup`;
const SIGNING_REQUIREMENT =
  'identifier "ai.codename.aegis.control" and anchor apple generic and certificate leaf[subject.OU] = "VVG962SM5J"';
const TLDR_AGENT_PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const UPDATE_UNAVAILABLE_MESSAGE = "No verified tldr; update is available.";

function updateUnavailable() {
  return Object.assign(new Error(UPDATE_UNAVAILABLE_MESSAGE), {
    code: "UPDATE_UNAVAILABLE",
    retryable: false,
  });
}

function installOwnedReleaseManifestPath(
  packageRoot = TLDR_AGENT_PACKAGE_ROOT,
) {
  const packageScope = dirname(packageRoot);
  const nodeModules = dirname(packageScope);
  const consumerRoot = dirname(nodeModules);
  if (
    packageRoot !== join(packageScope, "tldr") ||
    packageScope !== join(nodeModules, "@joenandez") ||
    nodeModules !== join(consumerRoot, "node_modules") ||
    consumerRoot !== join(dirname(consumerRoot), "tldr-agent")
  ) {
    throw new Error("tldr; package is not bootstrap-installed");
  }
  return join(dirname(consumerRoot), "release-manifest.json");
}

function loadInstallOwnedReleaseManifest() {
  return JSON.parse(readFileSync(installOwnedReleaseManifestPath(), "utf8"));
}

function verifiedReleaseManifest(manifest) {
  if (!validateReleaseManifest(manifest).ok) throw updateUnavailable();
  return manifest;
}

function result(status, remediation = null) {
  return Object.freeze({
    ok: true,
    data: Object.freeze({ status, remediation }),
  });
}

function projectStatus(value) {
  if (value === "ready") return result("ready");
  if (value === "pending_verification") return result("pending_verification");
  if (value === "unconfigured") return result("unconfigured");
  if (value === "corrupt") {
    return result("repair-required", "tldr-agent doctor --deep");
  }
  return null;
}

function projectError(error) {
  return error?.code === "BROKER_VERSION_UNSUPPORTED" ||
    /incompatible|hash|signature|notar|size|architecture|minimum|Node/i.test(
      error?.message ?? "",
    )
    ? result("incompatible", "rerun the verified tldr; bootstrap")
    : result("unavailable", "tldr-agent doctor --deep");
}

function createStatusSafeAdapter({
  requestStatusSafe = requestAegisStatusSafe,
} = {}) {
  async function read() {
    try {
      const raw = await requestStatusSafe();
      if (typeof raw !== "string" || raw.length > 64) return projectError();
      return { raw, projected: projectStatus(raw) };
    } catch (error) {
      return { error, projected: projectError(error) };
    }
  }
  return Object.freeze({
    async status() {
      const observed = await read();
      return (
        observed.projected ?? result("repair-required", "tldr-agent doctor")
      );
    },
  });
}

function launchFixedApp(path = NATIVE_SETUP_APP) {
  if (path !== NATIVE_SETUP_APP || !existsSync(SETUP_EXECUTABLE)) {
    throw Object.assign(new Error("NATIVE_SETUP_NOT_INSTALLED"), {
      code: "NATIVE_SETUP_NOT_INSTALLED",
    });
  }
  const verified = spawnSync(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", `-R=${SIGNING_REQUIREMENT}`, path],
    { encoding: "utf8", stdio: "ignore", timeout: 5_000 },
  );
  if (verified.status !== 0) {
    throw Object.assign(new Error("NATIVE_SETUP_INCOMPATIBLE"), {
      code: "BROKER_VERSION_UNSUPPORTED",
    });
  }
  const opened = spawnSync("/usr/bin/open", [path], {
    encoding: "utf8",
    stdio: "ignore",
    timeout: 5_000,
  });
  if (opened.status !== 0) {
    throw Object.assign(new Error("NATIVE_SETUP_UNAVAILABLE"), {
      code: "NATIVE_SETUP_UNAVAILABLE",
    });
  }
}

export function createProductionOwnerSetupService(dependencies = {}) {
  const adapter = createStatusSafeAdapter(dependencies);
  const launch = dependencies.launchFixedApp ?? launchFixedApp;
  const wait =
    dependencies.wait ??
    ((milliseconds) =>
      new Promise((resolvePromise) =>
        setTimeout(resolvePromise, milliseconds),
      ));
  const polling = {
    attempts: Math.max(1, Number(dependencies.polling?.attempts) || 5),
    intervalMs: Math.max(
      0,
      dependencies.polling?.intervalMs === undefined
        ? 1_000
        : Number(dependencies.polling.intervalMs) || 0,
    ),
  };
  const uninstallPolling = {
    attempts: Math.max(
      1,
      Number(dependencies.uninstallPolling?.attempts) || 301,
    ),
    intervalMs: Math.max(
      0,
      dependencies.uninstallPolling?.intervalMs === undefined
        ? 1_000
        : Number(dependencies.uninstallPolling.intervalMs) || 0,
    ),
  };
  const inspectUninstallResidue =
    dependencies.inspectUninstallResidue ??
    (() =>
      inspectDefaultUninstallResidue({ nativeSetupApp: NATIVE_SETUP_APP }));
  const launchOperation = async () => {
    try {
      await launch(NATIVE_SETUP_APP);
    } catch (error) {
      if (error?.code === "NATIVE_SETUP_NOT_INSTALLED") {
        return {
          ok: false,
          data: null,
          error: {
            code: "NATIVE_SETUP_NOT_INSTALLED",
            message: "tldr; is not installed.",
            retryable: false,
            remediation: "rerun the verified tldr; bootstrap",
          },
        };
      }
      return {
        ok: false,
        data: null,
        error: {
          code: "NATIVE_SETUP_UNAVAILABLE",
          message: "tldr; could not open.",
          retryable: true,
          remediation: projectError(error).data.remediation,
        },
      };
    }
    return null;
  };
  const launchAndRead = async () => {
    const failed = await launchOperation();
    return failed ?? adapter.status();
  };
  const setup = () =>
    observeNativeSetup({
      launchOperation,
      readStatus: () => adapter.status(),
      polling,
      wait,
      result,
    });
  const uninstall = () =>
    observeNativeUninstall({
      launchOperation,
      inspectUninstallResidue,
      polling: uninstallPolling,
      wait,
      result,
    });
  return Object.freeze({
    setup,
    configure: launchAndRead,
    repair: launchAndRead,
    uninstall,
    status: () => adapter.status(),
    close() {},
  });
}

export function createProductionInstallLifecycle(dependencies = {}) {
  const service = createProductionOwnerSetupService(dependencies);
  const sourceLifecycle =
    dependencies.sourceLifecycle ??
    createTldrAgentSourceInstallLifecycle({ home: dependencies.home });
  const pairedReleaseUpdate =
    dependencies.pairedReleaseUpdate ?? updateAegisRelease;
  const installSourceRelease =
    dependencies.installSourceRelease ?? installVerifiedSourceRelease;
  const requestSetupStateSafe =
    dependencies.requestSetupStateSafe ?? requestAegisSetupStateSafe;
  const sourceIdentity =
    dependencies.sourceIdentity ?? tldrAgentSourceIdentity();
  return Object.freeze({
    install: service.setup,
    async update() {
      let prepared = null;
      let sourceTransaction = null;
      let releaseManifest;
      if (dependencies.releaseManifest !== undefined) {
        releaseManifest = verifiedReleaseManifest(dependencies.releaseManifest);
      } else {
        try {
          releaseManifest = verifiedReleaseManifest(
            loadInstallOwnedReleaseManifest(),
          );
        } catch (error) {
          if (error?.code === "UPDATE_UNAVAILABLE") {
            throw error;
          }
          throw updateUnavailable();
        }
      }
      return pairedReleaseUpdate({
        ...(dependencies.pairedReleaseOptions ?? {}),
        manifest: releaseManifest,
        sourceRelease: {
          release: sourceIdentity.package_version,
          protocol_version: PROTOCOL_VERSION,
          setup_schema_version: 2,
        },
        snapshotSetupStateSafe: async () => requestSetupStateSafe(),
        quiesceSource: async () => {
          if (typeof sourceLifecycle.prepareUpdate !== "function") {
            throw new Error("Aegis source updater is incompatible");
          }
          prepared = await sourceLifecycle.prepareUpdate();
        },
        activateSource: async ({ source, bytes }) => {
          if (typeof sourceLifecycle.activatePreparedUpdate !== "function") {
            throw new Error("Aegis source updater is incompatible");
          }
          sourceTransaction = await installSourceRelease({
            source,
            bytes,
            sourceIdentity,
          });
          if (typeof sourceTransaction?.rollback !== "function") {
            throw new Error("Aegis source updater is incompatible");
          }
          await sourceLifecycle.activatePreparedUpdate(prepared);
        },
        restorePriorPair: async () => {
          await sourceTransaction?.rollback();
          sourceTransaction = null;
          if (
            prepared &&
            typeof sourceLifecycle.activatePreparedUpdate === "function"
          ) {
            await sourceLifecycle.activatePreparedUpdate(prepared);
          }
        },
        finalizeSourceRelease: async () => {
          await sourceTransaction?.finalize?.();
          sourceTransaction = null;
          prepared = null;
        },
        readSetupStateSafe: async () => requestSetupStateSafe(),
      });
    },
    uninstall: service.uninstall,
    status: service.status,
  });
}

export async function resolveOwnerIdentity() {
  return Object.freeze({ owner: "owner" });
}

export const _internals = Object.freeze({
  NATIVE_SETUP_APP,
  SETUP_EXECUTABLE,
  SIGNING_REQUIREMENT,
  TLDR_AGENT_PACKAGE_ROOT,
  createStatusSafeAdapter,
  installOwnedReleaseManifestPath,
  installVerifiedSourceRelease,
  inspectDefaultUninstallResidue,
});
