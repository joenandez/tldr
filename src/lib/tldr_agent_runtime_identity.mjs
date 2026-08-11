import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const FULL_REVISION = /^[0-9a-f]{40}$/i;

function runGit(commandRunner, packageRoot, args) {
  const result = commandRunner("git", ["-C", packageRoot, ...args], {
    encoding: "utf8",
  });
  return Number(result?.status ?? 1) === 0
    ? String(result?.stdout || "").trim()
    : null;
}

function exactCheckoutIdentity({ commandRunner, packageRoot, realpath }) {
  try {
    const topLevel = runGit(commandRunner, packageRoot, [
      "rev-parse",
      "--show-toplevel",
    ]);
    if (!topLevel || realpath(topLevel) !== realpath(packageRoot)) return null;
    const revision = runGit(commandRunner, packageRoot, ["rev-parse", "HEAD"]);
    if (!FULL_REVISION.test(revision || "")) return null;
    const status = runGit(commandRunner, packageRoot, [
      "status",
      "--porcelain",
      "--untracked-files=no",
    ]);
    if (status === null) return null;
    return { revision, dirty: status.length > 0 };
  } catch {
    return null;
  }
}

export function readTldrAgentRuntimeIdentity({
  packageRoot = PACKAGE_ROOT,
  packageJson = null,
  commandRunner = spawnSync,
  realpath = realpathSync,
  schemaVersion = null,
} = {}) {
  const metadata =
    packageJson ||
    JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const checkout = exactCheckoutIdentity({
    commandRunner,
    packageRoot,
    realpath,
  });
  const packagedRevision = FULL_REVISION.test(metadata.gitHead || "")
    ? metadata.gitHead
    : null;
  return {
    package_version: String(metadata.version || "unknown"),
    source_revision: checkout?.revision || packagedRevision,
    source_dirty: checkout ? checkout.dirty : null,
    schema_version:
      Number.isInteger(Number(schemaVersion)) && schemaVersion !== null
        ? Number(schemaVersion)
        : null,
  };
}

let cachedSourceIdentity = null;

export function tldrAgentSourceIdentity() {
  if (!cachedSourceIdentity) {
    const identity = readTldrAgentRuntimeIdentity();
    cachedSourceIdentity = Object.freeze({
      package_version: identity.package_version,
      source_revision: identity.source_revision,
      source_dirty: identity.source_dirty,
    });
  }
  return cachedSourceIdentity;
}

export function readTldrAgentRuntimeSchemaVersion(home) {
  const path = join(home, "runtime.sqlite");
  if (!existsSync(path)) return null;
  let db = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const runtimeSchema = db
      .prepare(
        `SELECT 1 FROM sqlite_schema
         WHERE type = 'table' AND name = 'runtime_schema'`,
      )
      .get();
    return runtimeSchema
      ? Number(
          db.prepare("SELECT version FROM runtime_schema WHERE id = 1").get()
            ?.version,
        )
      : Number(db.prepare("PRAGMA user_version").get().user_version);
  } catch {
    return null;
  } finally {
    db?.close?.();
  }
}

export function runtimeStoreIsHealthy(home) {
  const path = join(home, "runtime.sqlite");
  if (!existsSync(path)) return false;
  let db = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const result = Object.values(db.prepare("PRAGMA quick_check").get())[0];
    return result === "ok";
  } catch {
    return false;
  } finally {
    db?.close?.();
  }
}
