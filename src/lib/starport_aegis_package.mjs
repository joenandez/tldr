import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";

import {
  openInstallerAndWait,
  verifyPackageWithMacOS,
} from "./aegis_native_distribution.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const MINIMUM_MACOS = "13.0";

function lifecycleError(code, message, cause) {
  return Object.assign(new Error(message, { cause }), { code });
}

export async function installVerifiedLocalAegisPackage({
  packagePath,
  artifact,
  verifyPackage = verifyPackageWithMacOS,
  installPackage = openInstallerAndWait,
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
