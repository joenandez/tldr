import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const STARPORT_ACCEPTANCE_STEPS = Object.freeze([
  "marketplace-add",
  "plugin-install",
  "plugin-reload",
  "setup",
  "confirmation-resume",
  "welcome-accepted",
  "reply-resumed-origin-session",
  "configure",
  "repair",
  "protected-uninstall",
  "residue-audit",
  "plugin-uninstall",
]);

function refuse(message) {
  throw new Error(`Starport release contract invalid: ${message}`);
}

function sameVersion(packageJson, plugin, marketplace, release) {
  return (
    SEMVER.test(packageJson.version ?? "") &&
    packageJson.version === plugin.version &&
    packageJson.version === marketplace.plugins?.[0]?.source?.version &&
    packageJson.version === release.release &&
    packageJson.version === release.npm?.version
  );
}

function sourceContractComplete({ packageJson, plugin, marketplace, release }) {
  const source = marketplace.plugins?.[0]?.source;
  return Boolean(
    packageJson.name === "@joenandez/tldr" &&
      packageJson.private === undefined &&
      packageJson.publishConfig?.access === "public" &&
      packageJson.publishConfig?.provenance === true &&
      packageJson.bin?.["tldr-agent"] === "./bin/tldr-agent" &&
      plugin.name === "tldr" &&
      marketplace.name === release.marketplace?.name &&
      marketplace.plugins?.length === 1 &&
      source?.source === "npm" &&
      source.package === packageJson.name &&
      release.npm?.package === packageJson.name &&
      sameVersion(packageJson, plugin, marketplace, release) &&
      release.schema_version === 1 &&
      release.phase === "source" &&
      release.claude_code?.development_baseline === "2.1.226" &&
      release.node?.minimum === "22.13.0" &&
      SEMVER.test(release.node?.version ?? "") &&
      SHA256.test(release.node?.license_sha256 ?? "") &&
      SHA256.test(release.node?.runtimes?.arm64?.sha256 ?? "") &&
      Number.isSafeInteger(release.node?.runtimes?.arm64?.bytes) &&
      release.node.runtimes.arm64.bytes > 0 &&
      SHA256.test(release.node?.runtimes?.x86_64?.sha256 ?? "") &&
      Number.isSafeInteger(release.node?.runtimes?.x86_64?.bytes) &&
      release.node.runtimes.x86_64.bytes > 0 &&
      release.aegis?.protocol_version === 2 &&
      release.aegis?.setup_schema_version === 2 &&
      release.aegis?.minimum_macos === "13.0" &&
      release.dependencies?.yaml === "2.8.3" &&
      release.dependencies?.agentmail === "0.4.20" &&
      release.dependencies?.c8 === "10.1.3",
  );
}

function publicationComplete(release) {
  const publication = release.npm?.publication;
  return Boolean(
    release.phase === "published" &&
      /^[a-f0-9]{40}$/.test(release.source_commit ?? "") &&
      /^[a-f0-9]{40}$/.test(release.aegis?.source_commit ?? "") &&
      SEMVER.test(release.claude_code?.minimum_supported ?? "") &&
      publication?.status === "published" &&
      /^sha512-[A-Za-z0-9+/=]+$/.test(publication.dist_integrity ?? "") &&
      typeof publication.registry_signature === "string" &&
      publication.registry_signature.length > 0 &&
      typeof publication.provenance_attestation === "string" &&
      publication.provenance_attestation.length > 0,
  );
}

export function validateStarportReleaseContract(input = {}) {
  if (!sourceContractComplete(input)) refuse("source coordinates unresolved");
  if (input.requirePublished === true && !publicationComplete(input.release)) {
    refuse("publication evidence unresolved");
  }
  return Object.freeze({ ok: true, phase: input.release.phase });
}

export function validatePublishedStarportArtifact({
  expectedTarball,
  registryTarball,
  publication,
  acceptance,
} = {}) {
  if (
    !Buffer.isBuffer(expectedTarball) ||
    expectedTarball.length === 0 ||
    !Buffer.isBuffer(registryTarball) ||
    registryTarball.length === 0
  ) {
    refuse("publication tarballs missing");
  }
  if (!expectedTarball.equals(registryTarball)) {
    refuse("reviewed and registry tarball mismatch");
  }
  const observedIntegrity = `sha512-${createHash("sha512")
    .update(registryTarball)
    .digest("base64")}`;
  if (
    publication?.dist_integrity !== observedIntegrity ||
    !/^[a-f0-9]{40}$/.test(publication?.source_commit ?? "") ||
    typeof publication?.registry_signature !== "string" ||
    publication.registry_signature.length === 0 ||
    typeof publication?.provenance_attestation !== "string" ||
    publication.provenance_attestation.length === 0
  ) {
    refuse("registry integrity, signature, or provenance evidence invalid");
  }
  if (
    acceptance?.host !== "clean-macos" ||
    !["arm64", "x86_64"].includes(acceptance?.architecture) ||
    acceptance?.ambient_node !== false ||
    !SEMVER.test(acceptance?.claude_code_version ?? "") ||
    JSON.stringify(acceptance?.steps) !==
      JSON.stringify(STARPORT_ACCEPTANCE_STEPS) ||
    !Array.isArray(acceptance?.residue) ||
    acceptance.residue.length !== 0
  ) {
    refuse("clean macOS acceptance evidence incomplete");
  }
  return Object.freeze({
    ok: true,
    architecture: acceptance.architecture,
  });
}
