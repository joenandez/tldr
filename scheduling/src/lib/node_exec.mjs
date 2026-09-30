import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
    process.execPath,
    process.argv0 && process.argv0 !== "node" ? process.argv0 : null,
    resolveLatestNvmNodeExecutable(),
    resolveExecutable("node"),
  ]
    .filter(Boolean)
    .map((value) => (value.startsWith("/") ? value : resolve(value)));

  for (const candidate of candidates) {
    if (usable(candidate)) return candidate;
  }

  return process.execPath;
}

const UNIFIED_PACKAGE_NAME = "@joenandez/tldr";
// Item 50: the product this code belongs to, as release/activation-manifest.json
// names it. The unified product is the tldr-agents command and state root
// (tldr; + Helm + Tightbeam); the public tldr 1.x manifests carry no product.
export const UNIFIED_PRODUCT = "tldr-agents";
const RELEASE_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/u;
const INSTALLED_RUNTIME_SUFFIX = "/runtime/bin/node";

function readJsonFile(path) {
  try {
    return { present: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    return { present: error?.code !== "ENOENT", value: null };
  }
}

// A manifest carries a product when the field is set and not empty.
function carriedProduct(value) {
  return value === undefined || value === null || value === "" ? null : value;
}

/** The product an activation manifest names, or null when it names none. */
export function readManifestProduct(path) {
  return carriedProduct(readJsonFile(path).value?.product);
}

function logInstallIdentity(level, event, status, params) {
  process.stderr.write(
    `${JSON.stringify({ ts: new Date().toISOString(), level, event, status, params })}\n`,
  );
}

/**
 * Item 43: name a tldr; `install/` that is not the unified product. The rule
 * matches install/tldr-agent-bootstrap.sh: an install is this product when its
 * activation-manifest.json has schema_version 1 and a valid release, its
 * tldr-agent/package.json, when present, is @joenandez/tldr, and it is the
 * same product. On 2026-09-28 a public tldr 1.0.0 (Node 22) install replaced
 * the unified one.
 *
 * Item 50: the product is compared by the manifests' `product` field when
 * both the installed manifest and `product` (this package's) name one
 * ("product" rule). An installed manifest without the field (public tldr 1.x,
 * unified 0.1.x before item 50) falls back to the release line: 0.x is the
 * unified product, 1.x and later the public tldr ("version_line" rule). An
 * installed manifest that names a product this package cannot match, because
 * this package names none, is foreign ("product_incoming_missing" rule).
 *
 * Returns null when the install is this product or has no manifest to judge;
 * otherwise { installRoot, release, packageName, product, rule, reasons }.
 */
export function describeForeignTldrInstall(
  installRoot,
  { product = UNIFIED_PRODUCT, log = logInstallIdentity } = {},
) {
  const manifest = readJsonFile(join(installRoot, "activation-manifest.json"));
  if (!manifest.present) return null;
  const packageFile = readJsonFile(
    join(installRoot, "tldr-agent", "package.json"),
  );
  const release =
    typeof manifest.value?.release === "string" ? manifest.value.release : null;
  const packageName =
    typeof packageFile.value?.name === "string" ? packageFile.value.name : null;
  const installedProduct = carriedProduct(manifest.value?.product);
  const expectedProduct = carriedProduct(product);
  const rule =
    installedProduct === null
      ? "version_line"
      : expectedProduct === null
        ? "product_incoming_missing"
        : "product";
  const reasons = [];
  if (!manifest.value) reasons.push("activation-manifest.json is unreadable");
  else if (manifest.value.schema_version !== 1)
    reasons.push(
      `activation-manifest.json schema_version is ${JSON.stringify(manifest.value.schema_version ?? null)}, not 1`,
    );
  if (manifest.value && !RELEASE_PATTERN.test(release ?? ""))
    reasons.push(
      `activation-manifest.json release ${JSON.stringify(release)} is not a release`,
    );
  else if (rule === "product" && installedProduct !== expectedProduct)
    reasons.push(
      `activation-manifest.json product ${JSON.stringify(installedProduct)} is not ${JSON.stringify(expectedProduct)}`,
    );
  else if (rule === "product_incoming_missing")
    reasons.push(
      `activation-manifest.json product ${JSON.stringify(installedProduct)} cannot be matched: this package names no product`,
    );
  else if (rule === "version_line" && release && !release.startsWith("0."))
    reasons.push(
      `activation-manifest.json release ${release} is the public tldr line, not the unified 0.x line`,
    );
  if (packageFile.present && packageName !== UNIFIED_PACKAGE_NAME)
    reasons.push(
      `tldr-agent/package.json names ${JSON.stringify(packageName)}, not ${UNIFIED_PACKAGE_NAME}`,
    );
  log?.(
    reasons.length ? "warn" : "info",
    "install_product_identity",
    reasons.length ? "foreign" : "this_product",
    {
      install_root: installRoot,
      rule,
      installed_product: installedProduct,
      expected_product: expectedProduct,
      installed_release: release,
    },
  );
  if (reasons.length === 0) return null;
  return {
    installRoot,
    release,
    packageName,
    product: installedProduct,
    rule,
    reasons,
  };
}

/** The install root whose bundled runtime is `execPath`, or null. */
export function installRootForRuntime(execPath) {
  const path = String(execPath || "");
  if (!path.endsWith(INSTALLED_RUNTIME_SUFFIX)) return null;
  const installRoot = path.slice(0, -INSTALLED_RUNTIME_SUFFIX.length);
  return installRoot.endsWith("/install") ? installRoot : null;
}

export const FOREIGN_INSTALL_REMEDY =
  "run bin/tldr-agents setup from the tldr repository checkout";

/** One sentence naming a foreign install, its evidence, and the remedy. */
export function foreignTldrInstallMessage(
  foreign,
  { nodeVersion = null, remedy = FOREIGN_INSTALL_REMEDY } = {},
) {
  const evidence = [...foreign.reasons];
  if (nodeVersion) evidence.push(`its runtime is Node ${nodeVersion}`);
  return (
    `the tldr; install at ${foreign.installRoot} is a foreign install, not ` +
    `this unified product (${evidence.join("; ")}). To reinstall the unified ` +
    `product, ${remedy}.`
  );
}

function foreignRuntimeContractError(versionString, execPath, cause) {
  const installRoot = installRootForRuntime(execPath);
  const foreign = installRoot ? describeForeignTldrInstall(installRoot) : null;
  if (!foreign) return null;
  const err = new Error(
    `node_runtime_contract_failed: ${cause}. Helm is running on ` +
      foreignTldrInstallMessage(foreign, { nodeVersion: versionString }),
  );
  err.code = "node_runtime_contract_failed";
  err.detected_version = versionString;
  err.foreign_install = {
    install_root: foreign.installRoot,
    release: foreign.release,
    package_name: foreign.packageName,
    product: foreign.product,
    rule: foreign.rule,
    reasons: foreign.reasons,
  };
  return err;
}

/**
 * Assert that the current Node runtime satisfies the Halcyon contract:
 *   - Node major version >= 24 (node:sqlite is not available on Node <24)
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
 * @param {string} [opts.execPath] - the running Node binary. When it is the
 *   bundled runtime of a foreign tldr; install (item 43), the error names that
 *   install and the bin/tldr-agents setup remedy instead of an nvm upgrade.
 */
export function assertNodeRuntimeContract({
  overrideVersionString,
  simulateSqliteUnavailable,
  execPath = process.execPath,
} = {}) {
  const versionString = overrideVersionString || process.version;
  const match = /^v?(\d+)\./.exec(String(versionString));
  const major = match ? Number(match[1]) : 0;

  if (major < 24) {
    const foreign = foreignRuntimeContractError(
      versionString,
      execPath,
      `Node ${versionString} is below the minimum required version (Node 24 LTS, >=24)`,
    );
    if (foreign) throw foreign;
    const err = new Error(
      `node_runtime_contract_failed: Node ${versionString} is below the minimum required version. ` +
        `Helm requires Node 24 LTS (>=24) — node:sqlite is not available on Node <24. ` +
        `Upgrade: nvm install 24 && nvm alias default 24`,
    );
    err.code = "node_runtime_contract_failed";
    err.detected_version = versionString;
    throw err;
  }

  if (simulateSqliteUnavailable) {
    const foreign = foreignRuntimeContractError(
      versionString,
      execPath,
      "node:sqlite failed to load",
    );
    if (foreign) throw foreign;
    const err = new Error(
      `node_runtime_contract_failed: node:sqlite failed to load. ` +
        `Helm requires node:sqlite (Node built-in, >=24). ` +
        `Upgrade: nvm install 24 && nvm alias default 24`,
    );
    err.code = "node_runtime_contract_failed";
    throw err;
  }

  // Verify node:sqlite loads in the live process (catches unusual builds).
  try {
    _require("node:sqlite");
  } catch {
    // node:sqlite is a Node built-in — any throw means it is unavailable.
    const foreign = foreignRuntimeContractError(
      versionString,
      execPath,
      `node:sqlite failed to load under Node ${versionString}`,
    );
    if (foreign) throw foreign;
    const err = new Error(
      `node_runtime_contract_failed: node:sqlite failed to load under Node ${versionString}. ` +
        `Helm requires node:sqlite (Node built-in, >=24). ` +
        `Upgrade: nvm install 24 && nvm alias default 24`,
    );
    err.code = "node_runtime_contract_failed";
    throw err;
  }
}

// PATH entries that exist only for the process installing the service: npm
// run's node_modules/.bin chain and run-script shims, and the plugin bin/
// directories Claude Code adds to its Bash PATH (plugin caches and tldr's own
// local-release snapshots, which put the component launchers of an older
// snapshot on PATH and are pruned by later updates). A launchd service outlives
// the installer, so these never belong in its PATH.
const TRANSIENT_PATH_ENTRY = [
  /\/node_modules\/\.bin$/u,
  /\/@npmcli\/run-script\//u,
  /\/local-release\/snapshots\//u,
  /\/\.claude\/plugins\//u,
  /\/\.codex\/plugins\//u,
];

/** The service PATH: the given executables' directories, then the installer's PATH without transient entries. */
export function runtimePath(extraExecutables = [], { log = logInstallIdentity } = {}) {
  const inherited = (process.env.PATH || "").split(":").filter(Boolean);
  const dropped = inherited.filter((entry) =>
    TRANSIENT_PATH_ENTRY.some((pattern) => pattern.test(entry)),
  );
  if (dropped.length > 0) {
    log?.("info", "service_path_transient_entries_dropped", "ok", {
      dropped: dropped.length,
      kept: inherited.length - dropped.length,
    });
  }
  const entries = [
    ...extraExecutables.filter(Boolean).map((path) => dirname(path)),
    ...inherited.filter((entry) => !dropped.includes(entry)),
  ];
  return [...new Set(entries)].join(":");
}
