import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";

import {
  openInstallerAndWait,
  verifyPackageWithMacOS,
} from "./aegis_native_distribution.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const MINIMUM_MACOS = "13.0";

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
    throw new Error("Aegis package integrity failed");
  }
  await verifyPackage(packagePath, artifact);
  await installPackage(packagePath, artifact);
  return Object.freeze({
    ok: true,
    architecture: artifact.architecture,
    sha256: artifact.sha256,
  });
}
