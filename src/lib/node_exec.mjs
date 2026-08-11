import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const _require = createRequire(import.meta.url);

export function resolveExecutable(name) {
  const result = spawnSync("sh", ["-lc", `command -v ${name}`], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const value = (result.stdout || "").trim();
  if (!value) return null;
  return value;
}

function usable(path) {
  if (!path) return false;
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function parseVersionTag(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value || "").trim());
  if (!match) return null;
  return match.slice(1).map(Number);
}

function compareSemverDesc(a, b) {
  for (let index = 0; index < 3; index += 1) {
    const delta = b[index] - a[index];
    if (delta !== 0) return delta;
  }
  return 0;
}

export function resolveLatestNvmNodeExecutable(homePath = homedir()) {
  const root = resolve(homePath, ".nvm", "versions", "node");
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      version: parseVersionTag(entry.name),
    }))
    .filter((entry) => entry.version)
    .sort((left, right) => compareSemverDesc(left.version, right.version));

  for (const candidate of candidates) {
    const executable = resolve(root, candidate.name, "bin", "node");
    if (usable(executable)) return executable;
  }

  return null;
}

export function resolveNodeExecutable() {
  const candidates = [
    process.execPath,
    process.argv0 && process.argv0 !== "node" ? process.argv0 : null,
    resolveExecutable("node"),
  ]
    .filter(Boolean)
    .map((value) => (value.startsWith("/") ? value : resolve(value)));

  for (const candidate of candidates) {
    if (usable(candidate)) return candidate;
  }

  return process.execPath;
}

export function resolveServiceNodeExecutable() {
  const candidates = [
    resolveLatestNvmNodeExecutable(),
    process.execPath,
    process.argv0 && process.argv0 !== "node" ? process.argv0 : null,
    resolveExecutable("node"),
  ]
    .filter(Boolean)
    .map((value) => (value.startsWith("/") ? value : resolve(value)));

  for (const candidate of candidates) {
    if (usable(candidate)) return candidate;
  }

  return process.execPath;
}

// Minimum supported Node. node:sqlite landed in 22.5.0 behind
// --experimental-sqlite and was unflagged in 22.13.0 (and 23.4.0), so 22.13.0
// is the lowest version where the CLI runs without extra node flags.
export const MIN_NODE_VERSION = "22.13.0";
const MIN_NODE = { major: 22, minor: 13, patch: 0 };
const UPGRADE_HINT = "Upgrade: nvm install 24 && nvm alias default 24";

function parseNodeVersion(versionString) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(versionString));
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function belowMinimum(version) {
  if (!version) return true;
  if (version.major !== MIN_NODE.major) return version.major < MIN_NODE.major;
  if (version.minor !== MIN_NODE.minor) return version.minor < MIN_NODE.minor;
  return version.patch < MIN_NODE.patch;
}

/**
 * Assert that the current Node runtime satisfies the Halcyon contract:
 *   - Node version >= 22.13.0 (the first release with node:sqlite unflagged)
 *   - node:sqlite loads without error
 *
 * Throws an Error with a human-readable remediation message on failure.
 * Called at service install, service update, and daemon startup paths.
 *
 * @param {object} [opts]
 * @param {string} [opts.overrideVersionString]  - inject a fake version string
 *   (e.g. "v20.0.0") to test the version branch without downgrading Node.
 * @param {boolean} [opts.simulateSqliteUnavailable] - throw as if node:sqlite
 *   load failed, to test the sqlite branch.
 */
export function assertNodeRuntimeContract({
  overrideVersionString,
  simulateSqliteUnavailable,
} = {}) {
  const versionString = overrideVersionString || process.version;

  if (belowMinimum(parseNodeVersion(versionString))) {
    const err = new Error(
      `node_runtime_contract_failed: Node ${versionString} is below the minimum required version. ` +
        `Helm requires Node >=${MIN_NODE_VERSION} — node:sqlite is only unflagged from ${MIN_NODE_VERSION}. ` +
        UPGRADE_HINT,
    );
    err.code = "node_runtime_contract_failed";
    err.detected_version = versionString;
    throw err;
  }

  if (simulateSqliteUnavailable) {
    const err = new Error(
      `node_runtime_contract_failed: node:sqlite failed to load. ` +
        `Helm requires node:sqlite (Node built-in, >=${MIN_NODE_VERSION}). ` +
        UPGRADE_HINT,
    );
    err.code = "node_runtime_contract_failed";
    throw err;
  }

  // Verify node:sqlite loads in the live process (catches unusual builds).
  try {
    _require("node:sqlite");
  } catch {
    // node:sqlite is a Node built-in — any throw means it is unavailable.
    const err = new Error(
      `node_runtime_contract_failed: node:sqlite failed to load under Node ${versionString}. ` +
        `Helm requires node:sqlite (Node built-in, >=${MIN_NODE_VERSION}). ` +
        UPGRADE_HINT,
    );
    err.code = "node_runtime_contract_failed";
    throw err;
  }
}

export function runtimePath(extraExecutables = []) {
  const entries = [
    ...extraExecutables.filter(Boolean).map((path) => dirname(path)),
    ...(process.env.PATH || "").split(":").filter(Boolean),
  ];
  return [...new Set(entries)].join(":");
}
