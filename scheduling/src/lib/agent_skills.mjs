import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VENDORED_SKILLS_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "skills",
);
const VENDORED_SKILLS = ["helm-tasks"];
const RETIRED_HELM_SKILLS = ["helm-assignments", "helm-messaging"];

function copyDirRecursive(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source)) {
    const from = join(source, entry);
    const to = join(destination, entry);
    const stat = statSync(from);
    if (stat.isDirectory()) copyDirRecursive(from, to);
    else if (stat.isFile()) {
      copyFileSync(from, to);
      try {
        chmodSync(to, stat.mode & 0o777);
      } catch {
        // Preserve copy behavior when mode changes are unavailable.
      }
    }
  }
}

export function installAgentSkills({
  skillsRoot = VENDORED_SKILLS_ROOT,
  skillsDir = null,
  claudeSkillsDir,
  codexSkillsDir,
} = {}) {
  const destination = skillsDir || join(homedir(), ".agents", "skills");
  const mirrors = [
    claudeSkillsDir === undefined && !skillsDir
      ? join(homedir(), ".claude", "skills")
      : claudeSkillsDir,
    codexSkillsDir === undefined && !skillsDir
      ? join(homedir(), ".codex", "skills")
      : codexSkillsDir,
  ].filter(Boolean);
  for (const root of [destination, ...mirrors]) {
    for (const name of RETIRED_HELM_SKILLS) {
      rmSync(join(root, name), { recursive: true, force: true });
    }
  }
  const results = VENDORED_SKILLS.map((name) => {
    const source = join(skillsRoot, name);
    const target = join(destination, name);
    if (!existsSync(source)) {
      return {
        name,
        ok: false,
        error: "vendored_skill_missing",
        hint: `Expected ${source}`,
      };
    }
    try {
      rmSync(target, { recursive: true, force: true });
      copyDirRecursive(source, target);
      const mirrorResults = mirrors.map((root) => {
        const mirror = join(root, name);
        try {
          mkdirSync(root, { recursive: true });
          rmSync(mirror, { recursive: true, force: true });
          symlinkSync(target, mirror, "dir");
          return { path: mirror, ok: true };
        } catch (error) {
          return {
            path: mirror,
            ok: false,
            hint: error?.message || String(error),
          };
        }
      });
      return {
        name,
        ok: true,
        src: source,
        dest: target,
        mirrors: mirrorResults,
      };
    } catch (error) {
      return {
        name,
        ok: false,
        error: "skill_install_failed",
        hint: error?.message || String(error),
      };
    }
  });
  return { ok: results.every((entry) => entry.ok), results };
}
