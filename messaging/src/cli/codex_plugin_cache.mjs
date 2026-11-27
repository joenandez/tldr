// Which cached Codex tldr plugin versions matter to doctor (ac-8vngz): the one
// Codex loads, and any a killed tldr install left immutable.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// SemVer precedence as Codex's compare_plugin_versions applies it; a name that
// is not SemVer compares as a plain string. Kept here because messaging/ does
// not import the installer's copy (scripts/lib/local_version.mjs).
const SEMVER =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;
const cmp = (left, right) => (left === right ? 0 : left < right ? -1 : 1);

function compareIdentifierLists(left, right) {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const [a, b] = [left[index], right[index]].map((id) =>
      /^\d+$/u.test(id) ? [0, BigInt(id)] : [1, id],
    );
    const delta = cmp(a[0], b[0]) || cmp(a[1], b[1]);
    if (delta !== 0) return delta;
  }
  return cmp(left.length, right.length);
}

export function compareCodexPluginVersions(left, right) {
  const a = SEMVER.exec(left);
  const b = SEMVER.exec(right);
  if (!a || !b) return cmp(left, right);
  const core = compareIdentifierLists(a.slice(1, 4), b.slice(1, 4));
  if (core !== 0 || !a[4] || !b[4]) return core || cmp(!a[4], !b[4]);
  return compareIdentifierLists(a[4].split("."), b[4].split("."));
}

// Codex loads only the highest version dir of each cached plugin ("local"
// wins); a tldr install keeps older versions for sessions still running them
// (ac-8vngz). Picks the active dir from the cache listing, so a broken higher
// version is not hidden by an older one with valid hooks. Keeps the hook files
// (<root>/<version>/<wrapper>/hooks/hooks.json) of active versions only.
function activeCodexVersion(base) {
  let names;
  try {
    names = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  if (names.includes("local")) return "local";
  return names.sort(compareCodexPluginVersions).at(-1) ?? null;
}

export function activeCodexPluginHookFiles(files) {
  const versionDir = (file) => path.dirname(path.dirname(path.dirname(file)));
  return files.filter(
    (file) =>
      path.basename(versionDir(file)) ===
      activeCodexVersion(path.dirname(versionDir(file))),
  );
}

// Codex plugin cache dirs a killed tldr install left immutable (chflags uchg,
// ac-8vngz): the versions in the tldr-local cache and in any backup Codex made
// of it. Codex still installs and updates, but `codex plugin remove` fails
// until they are cleared.
export function lockedCodexPluginDirs(
  configRoot,
  { run = spawnSync, platform = process.platform } = {},
) {
  const base = path.join(configRoot, "plugins", "cache", "tldr-local");
  const children = (dir) => {
    try {
      return fs.readdirSync(dir).map((name) => path.join(dir, name));
    } catch {
      return [];
    }
  };
  const backups = children(base).filter((dir) =>
    path.basename(dir).startsWith("plugin-backup-"),
  );
  const versions = [base, ...backups]
    .map((dir) => path.join(dir, "tldr"))
    .flatMap(children);
  // chflags -R flags children before their parent, so an interrupted run can
  // leave flagged files under an unflagged version dir: search every path.
  const listing =
    platform === "darwin" && versions.length
      ? run("/usr/bin/find", [base, "-flags", "+uchg", "-print"], {
          encoding: "utf8",
        }).stdout
      : "";
  const flagged = String(listing || "")
    .split("\n")
    .filter(Boolean);
  const dirs = versions.filter((dir) =>
    flagged.some((entry) => entry === dir || entry.startsWith(`${dir}/`)),
  );
  return { base, dirs };
}
