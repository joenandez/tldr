import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  requestAegisSetupStateSafe,
  requestAegisStatusSafe,
} from "./aegis_client.mjs";
import { sanitizeInstallerEnvironment } from "./aegis_installer_environment.mjs";
const PACKAGE_RELEASE = "0.1.0-rc.5";
const RELEASE_MANIFEST_SCHEMA = 2;
const BROKER_PROTOCOL_VERSION = 2;
const SETUP_STATE_SCHEMA_VERSION = 2;
const NODE_MINIMUM = "22.13.0";
const MINIMUM_MACOS = "13.0";
const FIXED_SETUP_APP =
  "/Library/Application Support/Codename/Aegis/TldrAgentAegis.app";
const REPOSITORY_BUILD_URL = new URL(
  "../../native/aegis-broker/build",
  import.meta.url,
);
const ARCHITECTURES = new Set(["arm64", "x86_64"]);
const SHA256 = /^[a-f0-9]{64}$/;

function invalid(reason) {
  return Object.freeze({ ok: false, error: reason });
}

function semverTuple(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? match.slice(1).map(Number) : null;
}

function atLeast(actual, minimum) {
  const left = semverTuple(actual);
  const right = semverTuple(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
}

export function validateReleaseManifest(
  manifest,
  { expectedRelease = PACKAGE_RELEASE } = {},
) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return invalid("manifest missing");
  }
  if (
    manifest.schema_version !== RELEASE_MANIFEST_SCHEMA ||
    manifest.release !== expectedRelease ||
    manifest.protocol_version !== BROKER_PROTOCOL_VERSION ||
    manifest.setup_schema_version !== SETUP_STATE_SCHEMA_VERSION ||
    manifest.node_minimum !== NODE_MINIMUM ||
    manifest.status !== "accepted" ||
    !validReleaseComponent(manifest.tldr_agent, manifest) ||
    !Array.isArray(manifest.node_runtimes) ||
    manifest.node_runtimes.length !== 2 ||
    !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length !== 2
  ) {
    return invalid("manifest version or release incompatible");
  }
  const nodeArchitectures = new Set();
  for (const runtime of manifest.node_runtimes) {
    if (
      !ARCHITECTURES.has(runtime?.architecture) ||
      nodeArchitectures.has(runtime.architecture) ||
      !atLeast(runtime.version, NODE_MINIMUM) ||
      !validDownload(runtime, manifest.release) ||
      runtime.archive !== "tar.gz"
    ) {
      return invalid("Node runtime declaration invalid");
    }
    nodeArchitectures.add(runtime.architecture);
  }
  const seen = new Set();
  for (const artifact of manifest.artifacts) {
    if (
      !artifact ||
      typeof artifact !== "object" ||
      !ARCHITECTURES.has(artifact.architecture) ||
      seen.has(artifact.architecture) ||
      typeof artifact.url !== "string" ||
      !artifact.url.startsWith("https://") ||
      !artifact.url.includes(artifact.sha256) ||
      !SHA256.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes <= 0 ||
      artifact.minimum_macos !== MINIMUM_MACOS ||
      typeof artifact.signing_requirement !== "string" ||
      !artifact.signing_requirement.includes("anchor apple generic") ||
      !/^[A-Z0-9]{10}$/.test(artifact.installer_team_id ?? "") ||
      artifact.package_identifier !==
        `ai.codename.aegis.${artifact.architecture}` ||
      !releaseBindingMatches(artifact, manifest) ||
      artifact.notarization?.status !== "accepted" ||
      !SHA256.test(artifact.notarization?.ticket_sha256 ?? "")
    ) {
      return invalid("artifact integrity, signing, or notarization invalid");
    }
    seen.add(artifact.architecture);
  }
  if ([...ARCHITECTURES].some((architecture) => !seen.has(architecture))) {
    return invalid("host architectures incomplete");
  }
  return Object.freeze({ ok: true });
}

function releaseBindingMatches(component, manifest) {
  return (
    component?.release === manifest.release &&
    component.protocol_version === manifest.protocol_version &&
    component.setup_schema_version === manifest.setup_schema_version
  );
}

function validReleaseComponent(component, manifest) {
  return (
    validDownload(component, manifest.release) &&
    releaseBindingMatches(component, manifest)
  );
}

function validDownload(download, expectedRelease = null) {
  return Boolean(
    download &&
      (!expectedRelease || download.release === expectedRelease) &&
      typeof download.url === "string" &&
      download.url.startsWith("https://") &&
      download.url.includes(download.sha256) &&
      SHA256.test(download.sha256 ?? "") &&
      Number.isSafeInteger(download.bytes) &&
      download.bytes > 0,
  );
}

export function selectHostArtifact(manifest, architecture = process.arch) {
  const validation = validateReleaseManifest(manifest);
  if (!validation.ok)
    throw new Error(`Aegis manifest incompatible: ${validation.error}`);
  const normalized = architecture === "x64" ? "x86_64" : architecture;
  const artifact = manifest.artifacts.find(
    (candidate) => candidate.architecture === normalized,
  );
  if (!artifact) throw new Error("Aegis host architecture incompatible");
  return Object.freeze({
    ...artifact,
    notarization: { ...artifact.notarization },
  });
}

export async function acquireHostArtifact({
  manifest,
  architecture = process.arch,
  fetchArtifact = fetchBytes,
  nodeVersion = process.versions.node,
  mode = "clean",
  inspectEnvironment = inspectFixedEnvironment,
} = {}) {
  const environment = inspectEnvironment();
  if (
    environment.repositoryBuildExists ||
    (mode === "clean" && environment.installedAppExists) ||
    (mode === "upgrade" && !environment.installedAppExists) ||
    !["clean", "upgrade"].includes(mode)
  ) {
    throw new Error("ambient artifact substitution refused");
  }
  if (!atLeast(nodeVersion, NODE_MINIMUM)) {
    throw new Error(`Node ${NODE_MINIMUM} or newer is required`);
  }
  const artifact = selectHostArtifact(manifest, architecture);
  const downloaded = await fetchArtifact(artifact.url);
  const bytes = Buffer.isBuffer(downloaded)
    ? downloaded
    : Buffer.from(downloaded ?? []);
  if (bytes.length !== artifact.bytes)
    throw new Error("artifact size mismatch");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== artifact.sha256) throw new Error("artifact hash mismatch");
  return Object.freeze({ artifact, bytes });
}

async function acquireReleaseComponent({ download, fetchDownload, label }) {
  const downloaded = await fetchDownload(download.url);
  const bytes = Buffer.isBuffer(downloaded)
    ? downloaded
    : Buffer.from(downloaded ?? []);
  if (bytes.length !== download.bytes) {
    throw new Error(`${label} size mismatch`);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== download.sha256) {
    throw new Error(`${label} hash mismatch`);
  }
  return Object.freeze({ download: Object.freeze({ ...download }), bytes });
}

async function installDownloadedPackage({ artifact, bytes }) {
  const staging = mkdtempSync(join(tmpdir(), "tldr-agent-aegis-update-"));
  const packagePath = join(staging, "TldrAgentAegis.pkg");
  try {
    writeFileSync(packagePath, bytes, { mode: 0o600 });
    await verifyPackageWithMacOS(packagePath, artifact);
    await openInstallerAndWait(packagePath);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function requireUpdateBoundary(name, value) {
  if (typeof value !== "function") {
    throw new TypeError(`Aegis paired update requires ${name}`);
  }
  return value;
}

const SAFE_SETUP_STATE_KEYS = Object.freeze([
  "destination_masked",
  "expires_at",
  "resend_available_at",
  "state",
  "verify_available_at",
]);
const SAFE_SETUP_STATES = new Set([
  "ready",
  "unconfigured",
  "pending_verification",
  "pending_initial_verification",
  "pending_owner_verification",
  "verification_expired_initial",
  "verification_expired_owner",
]);

// This boundary deliberately keeps the broker's protected state opaque. The
// five fields below are the complete setup_state_safe projection: enough to
// prove that an update did not replace a pending verifier or its cooldown,
// while never reading a recipient, API key, verifier, or session secret.
function safeSetupProjection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== SAFE_SETUP_STATE_KEYS.length ||
    keys.some((key, index) => key !== SAFE_SETUP_STATE_KEYS[index]) ||
    !SAFE_SETUP_STATES.has(value.state) ||
    !(
      value.destination_masked === null ||
      (typeof value.destination_masked === "string" &&
        Buffer.byteLength(value.destination_masked) <= 320)
    ) ||
    ![
      value.expires_at,
      value.verify_available_at,
      value.resend_available_at,
    ].every(
      (timestamp) =>
        timestamp === null ||
        (Number.isSafeInteger(timestamp) && timestamp >= 0),
    )
  ) {
    return null;
  }
  return Object.freeze({
    state: value.state,
    destination_masked: value.destination_masked,
    expires_at: value.expires_at,
    verify_available_at: value.verify_available_at,
    resend_available_at: value.resend_available_at,
  });
}

function sameSafeSetupProjection(left, right) {
  return SAFE_SETUP_STATE_KEYS.every((key) => left[key] === right[key]);
}

function statusFromSetupProjection(projection) {
  if (projection.state === "ready") return "ready";
  if (projection.state === "unconfigured") return "unconfigured";
  return "pending_verification";
}

/**
 * Apply one already-verified tldr; source/native release pair. The
 * caller owns the platform-specific daemon transaction; this boundary owns
 * artifact identity and ordering. Source changes are activated and checked
 * before the one irreversible native installer invocation, so a native failure
 * can restore the prior source/native pair without a second Installer prompt.
 */
export async function updateAegisRelease({
  manifest,
  architecture = process.arch,
  sourceRelease,
  fetchArtifact = fetchBytes,
  fetchSource = fetchBytes,
  nodeVersion = process.versions.node,
  inspectEnvironment = inspectFixedEnvironment,
  snapshotSetupStateSafe,
  quiesceSource,
  installNative = installDownloadedPackage,
  activateSource,
  readSetupStateSafe = requestAegisSetupStateSafe,
  restorePriorPair,
  finalizeSourceRelease = null,
} = {}) {
  const validation = validateReleaseManifest(manifest);
  if (!validation.ok) {
    throw new Error(`Aegis manifest incompatible: ${validation.error}`);
  }
  if (!releaseBindingMatches(sourceRelease, manifest)) {
    throw new Error("Aegis source release incompatible");
  }
  const snapshot = requireUpdateBoundary(
    "snapshotSetupStateSafe",
    snapshotSetupStateSafe,
  );
  const quiesce = requireUpdateBoundary("quiesceSource", quiesceSource);
  const install = requireUpdateBoundary("installNative", installNative);
  const activate = requireUpdateBoundary("activateSource", activateSource);
  const readState = requireUpdateBoundary(
    "readSetupStateSafe",
    readSetupStateSafe,
  );
  const restore = requireUpdateBoundary("restorePriorPair", restorePriorPair);
  if (
    finalizeSourceRelease !== null &&
    typeof finalizeSourceRelease !== "function"
  ) {
    throw new TypeError(
      "Aegis paired update requires a source finalizer function",
    );
  }

  const source = await acquireReleaseComponent({
    download: manifest.tldr_agent,
    fetchDownload: fetchSource,
    label: "tldr; source artifact",
  });
  const native = await acquireHostArtifact({
    manifest,
    architecture,
    fetchArtifact,
    nodeVersion,
    mode: "upgrade",
    inspectEnvironment,
  });
  const before = safeSetupProjection(await snapshot());
  if (!before) throw new Error("Aegis setup state unavailable before update");
  await quiesce();
  try {
    await activate({
      source: source.download,
      bytes: source.bytes,
      release: manifest.release,
    });
    const after = safeSetupProjection(await readState());
    if (!after || !sameSafeSetupProjection(before, after)) {
      throw new Error("Aegis setup state changed during update");
    }
    // Native installation is the commit point. There are deliberately no
    // fallible operations after it, which retains the old runnable native
    // component when source activation or continuity validation fails.
    await install({
      artifact: native.artifact,
      bytes: native.bytes,
      release: manifest.release,
    });
    try {
      await finalizeSourceRelease?.();
    } catch {
      // An unreferenced prior source directory is safe to clean up later. Do
      // not turn successful native installation into a half-pair rollback.
    }
    return Object.freeze({
      ok: true,
      release: manifest.release,
      architecture: native.artifact.architecture,
      status: statusFromSetupProjection(after),
    });
  } catch (error) {
    await restore(before);
    throw error;
  }
}

export async function installAegisForHost({
  manifest,
  architecture = process.arch,
  fetchArtifact = fetchBytes,
  nodeVersion = process.versions.node,
  verifyPackage = verifyPackageWithMacOS,
  installPackage = openInstallerAndWait,
  launchSetup = launchFixedSetup,
  requestStatusSafe = requestAegisStatusSafe,
  mode = "clean",
  inspectEnvironment = inspectFixedEnvironment,
} = {}) {
  const acquired = await acquireHostArtifact({
    manifest,
    architecture,
    fetchArtifact,
    nodeVersion,
    mode,
    inspectEnvironment,
  });
  const staging = mkdtempSync(join(tmpdir(), "tldr-agent-aegis-install-"));
  const packagePath = join(staging, "TldrAgentAegis.pkg");
  try {
    writeFileSync(packagePath, acquired.bytes, { mode: 0o600 });
    await verifyPackage(packagePath, acquired.artifact);
    await installPackage(packagePath, acquired.artifact);
    await launchSetup(FIXED_SETUP_APP);
    const observed = await requestStatusSafe();
    const status = ["ready", "pending_verification", "unconfigured"].includes(
      observed,
    )
      ? observed
      : "repair-required";
    return Object.freeze({
      ok: true,
      release: manifest.release,
      architecture: acquired.artifact.architecture,
      sha256: acquired.artifact.sha256,
      node_version: nodeVersion,
      status,
    });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function fetchBytes(url) {
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) throw new Error("Aegis package download failed");
  return Buffer.from(await response.arrayBuffer());
}

function checked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 300_000,
    ...options,
  });
  if (result.status !== 0) throw new Error("Aegis package verification failed");
  return `${result.stdout}\n${result.stderr}`;
}

export function verifyPackageWithMacOS(path, artifact) {
  const signature = checked("/usr/sbin/pkgutil", ["--check-signature", path]);
  if (
    !signature.includes("Developer ID Installer") ||
    !signature.includes(`(${artifact.installer_team_id})`)
  ) {
    throw new Error("Aegis package signature requirement failed");
  }
  checked("/usr/sbin/spctl", [
    "--assess",
    "--type",
    "install",
    "--verbose=4",
    path,
  ]);
  checked("/usr/bin/xcrun", ["stapler", "validate", path]);
  const expanded = join(mkdtempSync(join(tmpdir(), "tldr-agent-pkg-")), "x");
  try {
    checked("/usr/sbin/pkgutil", ["--expand", path, expanded]);
    const identifiers = findPackageIdentifiers(expanded);
    if (
      identifiers.length !== 1 ||
      identifiers[0] !== artifact.package_identifier
    ) {
      throw new Error("Aegis package identity failed");
    }
  } finally {
    rmSync(dirname(expanded), { recursive: true, force: true });
  }
  if (artifact.minimum_macos !== MINIMUM_MACOS) {
    throw new Error("Aegis package minimum macOS incompatible");
  }
}

function findPackageIdentifiers(root) {
  const identifiers = [];
  let visited = 0;
  function visit(directory, depth) {
    if (depth > 4) throw new Error("Aegis package expansion too deep");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      visited += 1;
      if (visited > 128 || entry.isSymbolicLink()) {
        throw new Error("Aegis package expansion invalid");
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path, depth + 1);
      else if (entry.isFile() && entry.name === "PackageInfo") {
        const contents = readFileSync(path, "utf8");
        const match = /<pkg-info\b[^>]*\bidentifier="([^"]+)"/.exec(contents);
        if (!match) throw new Error("Aegis package identity missing");
        identifiers.push(match[1]);
      }
    }
  }
  visit(root, 0);
  return identifiers;
}

const inspectFixedEnvironment = () =>
  Object.freeze({
    installedAppExists: existsSync(FIXED_SETUP_APP),
    repositoryBuildExists: existsSync(REPOSITORY_BUILD_URL),
  });

export function openInstallerAndWait(path) {
  const env = sanitizeInstallerEnvironment();
  checked("/usr/bin/open", ["-W", path], { env });
}

function launchFixedSetup(path) {
  if (path !== FIXED_SETUP_APP)
    throw new Error("Aegis setup path substitution refused");
  checked("/usr/bin/open", [path]);
}

export const _internals = Object.freeze({
  FIXED_SETUP_APP,
  NODE_MINIMUM,
  MINIMUM_MACOS,
  RELEASE_MANIFEST_SCHEMA,
  BROKER_PROTOCOL_VERSION,
  SETUP_STATE_SCHEMA_VERSION,
  findPackageIdentifiers,
});
