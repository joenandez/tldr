import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { tldrAgentSourceIdentity } from "./tldr_agent_runtime_identity.mjs";

const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function sourceInstallError() {
  return new Error("Aegis verified source activation failed");
}

function sourceArtifactMetadata(path, release) {
  try {
    const metadata = JSON.parse(
      readFileSync(join(path, "package.json"), "utf8"),
    );
    return (
      metadata?.name === "@joenandez/tldr" &&
      metadata.version === release &&
      existsSync(join(path, "src"))
    );
  } catch {
    return false;
  }
}

// The native updater verifies the tarball hash before this transactional swap.
export function installVerifiedSourceRelease({
  source,
  bytes,
  packageRoot = PACKAGE_ROOT,
  sourceIdentity = tldrAgentSourceIdentity(),
} = {}) {
  if (
    !source ||
    typeof source.release !== "string" ||
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    sourceIdentity?.source_dirty === true
  ) {
    throw sourceInstallError();
  }
  const root = resolve(packageRoot);
  if (!existsSync(root)) throw sourceInstallError();
  const parent = dirname(root);
  const staging = mkdtempSync(join(parent, ".tldr-agent-source-"));
  const archive = join(staging, "tldr-agent.tgz");
  const unpacked = join(staging, "unpacked");
  let backup = null;
  let sourceActive = false;
  try {
    mkdirSync(unpacked, { mode: 0o700 });
    writeFileSync(archive, bytes, { mode: 0o600 });
    const extracted = spawnSync(
      "/usr/bin/tar",
      ["-xzf", archive, "--strip-components", "1", "-C", unpacked],
      { encoding: "utf8", stdio: "ignore", timeout: 30_000 },
    );
    if (
      extracted.status !== 0 ||
      !sourceArtifactMetadata(unpacked, source.release)
    ) {
      throw sourceInstallError();
    }
    backup = mkdtempSync(join(parent, ".tldr-agent-previous-"));
    rmSync(backup, { recursive: true, force: true });
    renameSync(root, backup);
    try {
      renameSync(unpacked, root);
      sourceActive = true;
    } catch (error) {
      renameSync(backup, root);
      backup = null;
      throw error;
    }
  } catch (error) {
    if (error?.message === sourceInstallError().message) throw error;
    throw sourceInstallError();
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  return Object.freeze({
    rollback() {
      if (!sourceActive) return;
      if (!backup || !existsSync(backup)) throw sourceInstallError();
      const displaced = mkdtempSync(join(parent, ".tldr-agent-failed-"));
      rmSync(displaced, { recursive: true, force: true });
      renameSync(root, displaced);
      try {
        renameSync(backup, root);
        sourceActive = false;
        backup = null;
      } catch (error) {
        renameSync(displaced, root);
        throw error;
      } finally {
        rmSync(displaced, { recursive: true, force: true });
      }
    },
    finalize() {
      if (!sourceActive || !backup) return;
      rmSync(backup, { recursive: true, force: true });
      backup = null;
    },
  });
}
