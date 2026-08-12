import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";

import {
  openInstallerAndWait,
  verifyPackageWithMacOS,
} from "./aegis_native_distribution.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const MINIMUM_MACOS = "13.0";
const FIXED_AEGIS_APP =
  "/Library/Application Support/Codename/Aegis/TldrAgentAegis.app";
const BROKER_LABEL = "system/ai.codename.aegis.broker";

function lifecycleError(code, message, cause) {
  return Object.assign(new Error(message, { cause }), { code });
}

function inspectInstalledAegis({ artifact }) {
  if (!existsSync(FIXED_AEGIS_APP)) return false;
  const receipt = spawnSync(
    "/usr/sbin/pkgutil",
    ["--pkg-info", artifact.package_identifier],
    { stdio: "ignore", timeout: 5_000 },
  );
  if (receipt.status !== 0) return false;
  const service = spawnSync("/bin/launchctl", ["print", BROKER_LABEL], {
    stdio: "ignore",
    timeout: 5_000,
  });
  return service.status === 0;
}

export async function installVerifiedLocalAegisPackage({
  packagePath,
  artifact,
  verifyPackage = verifyPackageWithMacOS,
  installPackage = openInstallerAndWait,
  inspectInstallation = inspectInstalledAegis,
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
  try {
    await installPackage(packagePath, artifact);
    if (!(await inspectInstallation({ artifact }))) {
      throw new Error("Aegis installer closed without a healthy installation");
    }
  } catch (error) {
    throw lifecycleError(
      "STARPORT_INSTALLATION_INCOMPLETE",
      "tldr; installation did not complete.",
      error,
    );
  }
  return Object.freeze({
    ok: true,
    architecture: artifact.architecture,
    sha256: artifact.sha256,
  });
}
