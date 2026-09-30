import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import { helmHome as getHelmHome } from "./store.mjs";
import {
  LifecycleStoreError,
  lifecycleOriginIsRecorded,
} from "./tldr_agent_lifecycle_store.mjs";

// Replacement evidence for the source lifecycle: the verified 1.1.0 install
// that predates the lifecycle-store split, and the evidence file the
// bootstrap captures before it replaces an installed source. Split from
// tldr_agent_source_lifecycle.mjs (item 47), which re-exports the public names.

const PRE_SPLIT_MIGRATION_EVIDENCE = "tldr-agent-presplit-lifecycle.json";
export const VERIFIED_PRE_SPLIT_RELEASE = Object.freeze({
  packageVersion: "1.1.0",
  sourceLifecycleSha256:
    "33da40b4c8c830d0bb69eec6fbc2819afe97d77ccaa3c2b5c951a4d17fbfd74b",
  sourceRecordSha256:
    "3f5505944fcea137e520d446a3a76e9cf06e7f9badffff8def716c16be9d8f45",
});

export function readVerifiedInstalledPreSplitSource({
  home = getHelmHome(),
  installRoot = join(home, "install"),
} = {}) {
  const installedRoot = join(installRoot, "tldr-agent");
  const packagePath = join(installedRoot, "package.json");
  const sourceLifecycle = join(
    installedRoot,
    "src",
    "lib",
    "tldr_agent_source_lifecycle.mjs",
  );
  const lifecycleStore = join(
    installedRoot,
    "src",
    "lib",
    "tldr_agent_lifecycle_store.mjs",
  );
  const activationManifest = join(installRoot, "activation-manifest.json");
  try {
    const metadata = JSON.parse(readFileSync(packagePath, "utf8"));
    const manifest = JSON.parse(readFileSync(activationManifest, "utf8"));
    const sourceRecord = Object.values(manifest?.architectures || {})
      .map((architecture) => architecture?.tldr_agent)
      .find(
        (record) =>
          record?.sha256 === VERIFIED_PRE_SPLIT_RELEASE.sourceRecordSha256,
      );
    const sourceMatchesArchivedRelease =
      createHash("sha256")
        .update(readFileSync(sourceLifecycle))
        .digest("hex") === VERIFIED_PRE_SPLIT_RELEASE.sourceLifecycleSha256;
    const verifiedInstalledSource =
      metadata?.name === "@joenandez/tldr" &&
      metadata.version === VERIFIED_PRE_SPLIT_RELEASE.packageVersion &&
      manifest?.schema_version === 1 &&
      manifest.release === metadata.version &&
      sourceRecord &&
      sourceMatchesArchivedRelease &&
      existsSync(activationManifest);
    return {
      verifiedInstalledSource: Boolean(verifiedInstalledSource),
      sourcePredatesLifecycleSplit:
        Boolean(verifiedInstalledSource) &&
        !existsSync(lifecycleStore) &&
        !lifecycleOriginIsRecorded({ home }),
      path: installedRoot,
    };
  } catch {
    return {
      verifiedInstalledSource: false,
      sourcePredatesLifecycleSplit: false,
      path: installedRoot,
    };
  }
}

export function lifecycleMigrationEvidencePath(home = getHelmHome()) {
  return join(home, PRE_SPLIT_MIGRATION_EVIDENCE);
}

export function readCapturedPreSplitSource({ home = getHelmHome() } = {}) {
  const path = lifecycleMigrationEvidencePath(home);
  if (!existsSync(path)) return { captured: false };
  try {
    const evidence = JSON.parse(readFileSync(path, "utf8"));
    const isReplacementEvidence =
      evidence?.schema_version === 2 &&
      evidence.package_name === "@joenandez/tldr" &&
      typeof evidence.package_version === "string";
    const verifiedInstalledSource =
      isReplacementEvidence &&
      evidence.prior_source_kind === "verified_pre_split" &&
      evidence.package_version === VERIFIED_PRE_SPLIT_RELEASE.packageVersion &&
      evidence.source_lifecycle_sha256 ===
        VERIFIED_PRE_SPLIT_RELEASE.sourceLifecycleSha256 &&
      evidence.source_record_sha256 ===
        VERIFIED_PRE_SPLIT_RELEASE.sourceRecordSha256;
    return {
      captured: true,
      verifiedInstalledSource: Boolean(verifiedInstalledSource),
      sourcePredatesLifecycleSplit: Boolean(verifiedInstalledSource),
      validReplacementEvidence:
        Boolean(verifiedInstalledSource) ||
        (isReplacementEvidence && evidence.prior_source_kind === "post_split"),
      path,
    };
  } catch {
    return {
      captured: true,
      verifiedInstalledSource: false,
      sourcePredatesLifecycleSplit: false,
      validReplacementEvidence: false,
      path,
    };
  }
}

export function consumeCapturedPreSplitSource(evidence) {
  const consumedPath = `${evidence.path}.consumed`;
  try {
    renameSync(evidence.path, consumedPath);
  } catch {
    throw new LifecycleStoreError(
      "lifecycle_migration_evidence_unreadable",
      "tldr; lifecycle migration evidence cannot be consumed",
      { path: evidence.path },
    );
  }
  return () => rmSync(consumedPath, { force: true });
}
