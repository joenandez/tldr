import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Starport component inspection: whether the plugin, runtime, service, and
// Aegis pieces on disk match the activation manifest (or, for a local
// snapshot, its LOCAL-SNAPSHOT-MANIFEST.json), plus the file-record checks the
// bundled Aegis installer reuses. Split from starport_runtime.mjs (item 47),
// which re-exports both inspectors.

export const AEGIS_APP =
  "/Library/Application Support/Codename/Aegis/TldrAgentAegis.app";
const ARCHITECTURES = new Set(["arm64"]);

export function normalizedArchitecture(architecture = process.arch) {
  return ARCHITECTURES.has(architecture) ? architecture : null;
}

export function safeJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function matchesFileRecord(root, record) {
  if (
    !root ||
    !record ||
    typeof record.path !== "string" ||
    record.path.startsWith("/") ||
    record.path.split("/").includes("..")
  ) {
    return false;
  }
  try {
    const path = resolve(root, record.path);
    if (!path.startsWith(`${resolve(root)}/`) || !statSync(path).isFile()) {
      return false;
    }
    const bytes = readFileSync(path);
    return (
      bytes.length === record.bytes &&
      createHash("sha256").update(bytes).digest("hex") === record.sha256
    );
  } catch {
    return false;
  }
}

function matchesLocalFileRecord(root, record) {
  if (
    !root ||
    !record ||
    typeof record.path !== "string" ||
    record.path.startsWith("/") ||
    record.path.split("/").includes("..")
  ) {
    return false;
  }
  try {
    const path = resolve(root, record.path);
    if (!path.startsWith(`${resolve(root)}/`) || !statSync(path).isFile()) {
      return false;
    }
    return (
      createHash("sha256").update(readFileSync(path)).digest("hex") ===
      record.sha256
    );
  } catch {
    return false;
  }
}

function releaseMatchesSource(sourceRoot, release) {
  const packageJson = safeJson(join(sourceRoot, "package.json"));
  return (
    packageJson?.name === "@joenandez/tldr" && packageJson.version === release
  );
}

function localSnapshotMatches(root) {
  const manifest = safeJson(join(root || "", "LOCAL-SNAPSHOT-MANIFEST.json"));
  if (!manifest?.sourceDigest || !Array.isArray(manifest.files)) return false;
  try {
    for (const entry of manifest.files) {
      if (!matchesLocalFileRecord(root, entry)) return false;
    }
    const listed = manifest.files.map((entry) => entry.path).sort();
    const walk = (path, base = path) =>
      readdirSync(path, { withFileTypes: true })
        .flatMap((entry) => {
          const child = join(path, entry.name);
          return entry.isDirectory()
            ? walk(child, base)
            : entry.isFile() || entry.isSymbolicLink()
              ? [child.slice(base.length + 1)]
              : [];
        })
        .sort();
    const actual = walk(root).filter(
      (path) => path !== "LOCAL-SNAPSHOT-MANIFEST.json",
    );
    return JSON.stringify(actual) === JSON.stringify(listed);
  } catch {
    return false;
  }
}

export function createStarportComponentInspector({
  home,
  sourceRoot,
  pluginRoot,
  activationManifest,
  architecture = normalizedArchitecture(),
  aegisApp = AEGIS_APP,
  launchAgent = join(
    homedir(),
    "Library",
    "LaunchAgents",
    "ai.tldr-agent.daemon.plist",
  ),
  nodeExecutable = process.execPath,
} = {}) {
  return async () => {
    const activation = safeJson(activationManifest);
    const release = activation?.release;
    const pluginManifest = activation?.plugin_manifest;
    const installedNode = join(home, "install", "runtime", "bin", "node");
    let activationRecord = null;
    try {
      const bytes = readFileSync(activationManifest);
      activationRecord = {
        path: "release/activation-manifest.json",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    } catch {
      activationRecord = null;
    }
    const activationHealthy = matchesFileRecord(pluginRoot, activationRecord);
    const pluginHealthy =
      activationHealthy &&
      matchesFileRecord(pluginRoot, pluginManifest) &&
      releaseMatchesSource(sourceRoot, release);
    const runtimeHealthy =
      activationHealthy &&
      Boolean(activation?.architectures?.[architecture]?.runtime) &&
      resolve(nodeExecutable) === resolve(installedNode) &&
      releaseMatchesSource(sourceRoot, release);
    const nativeInstalled = existsSync(aegisApp);
    return Object.freeze({
      plugin: pluginHealthy,
      runtime: runtimeHealthy,
      service: existsSync(launchAgent),
      aegis: nativeInstalled,
      outbound: nativeInstalled,
    });
  };
}

export function createLocalSnapshotComponentInspector({
  home,
  sourceRoot,
  pluginRoot,
  aegisApp = AEGIS_APP,
  launchAgent = join(
    homedir(),
    "Library",
    "LaunchAgents",
    "ai.tldr-agent.daemon.plist",
  ),
  nodeExecutable = process.execPath,
} = {}) {
  return async () => {
    const snapshotHealthy =
      localSnapshotMatches(pluginRoot) &&
      resolve(pluginRoot) === resolve(sourceRoot);
    const installedNode = join(home, "install", "runtime", "bin", "node");
    const nativeInstalled = existsSync(aegisApp);
    return Object.freeze({
      plugin: snapshotHealthy,
      runtime:
        snapshotHealthy && resolve(nodeExecutable) === resolve(installedNode),
      service:
        snapshotHealthy &&
        existsSync(launchAgent) &&
        readFileSync(launchAgent, "utf8").includes(resolve(sourceRoot)),
      aegis: nativeInstalled,
      outbound: nativeInstalled,
    });
  };
}
