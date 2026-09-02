import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";

import {
  openInstallerAndWait,
  verifyPackageWithMacOS,
} from "./aegis_native_distribution.mjs";
import { requireGuiSession } from "./tldr_agent_gui_session.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const MINIMUM_MACOS = "13.0";
const FIXED_AEGIS_APP =
  "/Library/Application Support/Codename/Aegis/TldrAgentAegis.app";
const BROKER_LABEL = "system/ai.codename.aegis.broker";

function lifecycleError(code, message, cause) {
  return Object.assign(new Error(message, { cause }), { code });
}

function inspectInstalledAegis({ artifact }) {
  const appVisible = existsSync(FIXED_AEGIS_APP);
  const receipt = spawnSync(
    "/usr/sbin/pkgutil",
    ["--pkg-info", artifact.package_identifier],
    { stdio: "ignore", timeout: 5_000 },
  );
  const service = spawnSync("/bin/launchctl", ["print", BROKER_LABEL], {
    stdio: "ignore",
    timeout: 5_000,
  });
  return Object.freeze({
    app_visible: appVisible,
    receipt_present: receipt.status === 0,
    broker_ready: service.status === 0,
  });
}

function installationSignals(value) {
  if (value && typeof value === "object") {
    return Object.freeze({
      app_visible: value.app_visible === true,
      receipt_present: value.receipt_present === true,
      broker_ready: value.broker_ready === true,
    });
  }
  const healthy = value === true;
  return Object.freeze({
    app_visible: healthy,
    receipt_present: healthy,
    broker_ready: healthy,
  });
}

function logInstallationVisibility(signals) {
  const fields = Object.entries(signals)
    .map(([name, value]) => `${name}=${value}`)
    .join(" ");
  spawnSync(
    "/usr/bin/logger",
    ["-t", "TldrAgentAegis", `[🪳 TEMP AEGIS_INSTALL_VISIBILITY] ${fields}`],
    { stdio: "ignore", timeout: 5_000 },
  );
}

export async function installVerifiedLocalAegisPackage({
  packagePath,
  artifact,
  verifyPackage = verifyPackageWithMacOS,
  installPackage = openInstallerAndWait,
  inspectInstallation = inspectInstalledAegis,
  logInstallation = logInstallationVisibility,
} = {}) {
  if (
    typeof packagePath !== "string" ||
    !existsSync(packagePath) ||
    !artifact ||
    !SHA256.test(artifact.sha256 ?? "") ||
    statSync(packagePath).size !== artifact.bytes ||
    createHash("sha256").update(readFileSync(packagePath)).digest("hex") !==
      artifact.sha256 ||
    artifact.minimum_macos !== MINIMUM_MACOS ||
    !/^[A-Z0-9]{10}$/.test(artifact.installer_team_id ?? "") ||
    artifact.package_identifier !== `ai.codename.aegis.${artifact.architecture}`
  ) {
    throw lifecycleError(
      "STARPORT_RELEASE_INVALID",
      "tldr; release verification failed.",
    );
  }
  try {
    await verifyPackage(packagePath, artifact);
  } catch (error) {
    throw lifecycleError(
      "STARPORT_RELEASE_INVALID",
      "tldr; release verification failed.",
      error,
    );
  }
  let signals;
  try {
    requireGuiSession();
    await installPackage(packagePath, artifact);
    signals = installationSignals(await inspectInstallation({ artifact }));
  } catch (error) {
    throw lifecycleError(
      "STARPORT_INSTALLATION_INCOMPLETE",
      "tldr; installation did not complete.",
      error,
    );
  }
  try {
    logInstallation(signals);
  } catch {
    // Diagnostics must never alter the verified installation result.
  }
  if (!signals.app_visible && signals.receipt_present && signals.broker_ready) {
    throw lifecycleError(
      "STARPORT_INSTALLATION_INACCESSIBLE",
      "tldr; secure setup is installed but unavailable.",
    );
  }
  if (!Object.values(signals).every(Boolean)) {
    throw lifecycleError(
      "STARPORT_INSTALLATION_INCOMPLETE",
      "tldr; installation did not complete.",
    );
  }
  return Object.freeze({
    ok: true,
    architecture: artifact.architecture,
    sha256: artifact.sha256,
  });
}
