import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const readJson = (path) =>
  JSON.parse(readFileSync(resolve(root, path), "utf8"));
const digest = (path) =>
  createHash("sha256")
    .update(readFileSync(resolve(root, path)))
    .digest("hex");

const sourceManifest = readJson("PUBLIC-SOURCE-MANIFEST.json");
const packageJson = readJson("package.json");
const plugin = readJson(".claude-plugin/plugin.json");
const marketplace = readJson(".claude-plugin/marketplace.json");
const activation = readJson("release/activation-manifest.json");

assert.equal(sourceManifest.schema_version, 1);
assert.equal(sourceManifest.package.name, "@joenandez/tldr");
assert.equal(sourceManifest.package.version, packageJson.version);
assert.match(sourceManifest.source.commit, /^[0-9a-f]{40}$/u);
assert.equal(
  packageJson.repository.url,
  "git+https://github.com/joenandez/tldr.git",
);
assert.equal(packageJson.publishConfig.access, "public");
assert.equal(packageJson.publishConfig.provenance, true);
assert.deepEqual(packageJson.bin, { "tldr-agent": "./bin/tldr-agent" });
assert.equal(plugin.name, "tldr");
assert.equal(plugin.displayName, "tldr;");
assert.equal(plugin.version, packageJson.version);
assert.equal(marketplace.plugins[0].source.package, packageJson.name);
assert.equal(marketplace.plugins[0].source.version, packageJson.version);
assert.equal(activation.release, packageJson.version);
assert.deepEqual(Object.keys(activation.architectures).sort(), [
  "arm64",
  "x86_64",
]);

const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean)
  .sort();
const expectedTracked = [
  "PUBLIC-SOURCE-MANIFEST.json",
  ...sourceManifest.files.map(({ path }) => path),
].sort();
assert.deepEqual(
  tracked,
  expectedTracked,
  "public repository contains unmanaged files",
);

for (const file of sourceManifest.files) {
  const metadata = lstatSync(resolve(root, file.path));
  assert.equal(metadata.isFile(), true, `${file.path} must be a regular file`);
  assert.equal(
    metadata.isSymbolicLink(),
    false,
    `${file.path} must not be a symlink`,
  );
  assert.equal(metadata.size, file.bytes, `${file.path} byte count drifted`);
  assert.equal(digest(file.path), file.sha256, `${file.path} digest drifted`);
}

const activationRecords = [
  activation.plugin_manifest,
  activation.hook_manifest,
  activation.node_license,
  ...Object.values(activation.architectures).flatMap((architecture) => [
    architecture.runtime,
    architecture.tldr_agent,
    architecture.aegis,
  ]),
];
for (const record of activationRecords) {
  const metadata = lstatSync(resolve(root, record.path));
  assert.equal(
    metadata.size,
    record.bytes,
    `${record.path} byte count drifted`,
  );
  assert.equal(
    digest(record.path),
    record.sha256,
    `${record.path} digest drifted`,
  );
}

const forbiddenText = [
  new RegExp(["coffee", "run"].join("-"), "iu"),
  new RegExp(["/", "Users", "/", "[A-Za-z0-9._-]+", "/"].join(""), "u"),
  new RegExp(["/", "home", "/", "joe", "/"].join(""), "u"),
];
for (const file of sourceManifest.files) {
  const contents = readFileSync(resolve(root, file.path));
  if (contents.includes(0)) continue;
  const text = contents.toString("utf8");
  assert.equal(
    forbiddenText.some((pattern) => pattern.test(text)),
    false,
    `${file.path} contains a forbidden private or legacy identifier`,
  );
}

console.log(
  JSON.stringify({
    ok: true,
    package: `${packageJson.name}@${packageJson.version}`,
    source_commit: sourceManifest.source.commit,
    files: sourceManifest.files.length,
  }),
);
