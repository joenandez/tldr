import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { writeTextAtomic } from "./durable_file_io.mjs";

export function resolveAssignmentUpdateInput(flags) {
  const providerPatch =
    flags.provider === undefined
      ? undefined
      : flags.provider === "null"
        ? null
        : flags.provider;
  if (flags["skill-path"] !== undefined) {
    const skillPath = resolveSkillPathFlag(flags);
    return skillPath.error
      ? skillPath
      : { providerPatch, skill: null, skillPath };
  }
  if (typeof flags.skill !== "string") return { providerPatch, skill: null };

  const source = resolve(flags.skill);
  if (!existsSync(source)) {
    return {
      error: {
        code: "skill_not_found",
        message: `backing skill not found at ${source}`,
        exitCode: 1,
      },
    };
  }
  if (!statSync(source).isFile()) {
    return {
      error: {
        code: "skill_not_file",
        message: `backing skill must be a file: ${source}`,
        exitCode: 2,
      },
    };
  }
  return {
    providerPatch,
    skill: {
      content: readFileSync(source, "utf8"),
    },
  };
}

// --skill-path re-points the record at another SKILL.md; it never writes the
// file. --skill (content replace) and --name (moves the assignment home) would
// each fight it over the same field, so they are refused together. Checks run
// in order; the first failing one names the error.
function resolveSkillPathFlag(flags) {
  const raw = flags["skill-path"];
  const target =
    typeof raw === "string" && isAbsolute(raw) ? resolve(raw) : null;
  const checks = [
    [
      () => typeof flags.skill === "string" || flags.name !== undefined,
      "skill_path_conflict",
      "--skill-path cannot be combined with --skill or --name",
    ],
    [
      () => !target || basename(target) !== "SKILL.md",
      "skill_path_invalid",
      "--skill-path requires an absolute path to a file named SKILL.md",
    ],
    [
      () => !existsSync(target),
      "skill_not_found",
      `backing skill not found at ${target}`,
      1,
    ],
    [
      () => !statSync(target).isFile(),
      "skill_not_file",
      `backing skill must be a file: ${target}`,
    ],
  ];
  const failed = checks.find(([fails]) => fails());
  if (!failed) return target;
  const [, code, message, exitCode = 2] = failed;
  return { error: { code, message, exitCode } };
}

export function repointSkill(job, skillPath) {
  if (!skillPath) return;
  job.metadata = { ...(job.metadata || {}) };
  job.metadata.assignment = {
    ...(job.metadata.assignment || {}),
    skill_path: skillPath,
  };
  job.prompt = {
    type: "inline",
    value: `Run the skill at ${skillPath} and follow it.`,
  };
}

export function applyProviderPatch(job, providerPatch) {
  if (providerPatch === undefined) return;
  job.execution_hints = {
    ...(job.execution_hints || {}),
    provider: providerPatch,
  };
}

export function writeSkillUpdate(skill, target) {
  if (!skill) return null;
  if (!target || !existsSync(target)) {
    throw Object.assign(new Error("assignment backing skill is unavailable"), {
      code: "skill_target_missing",
      exitCode: 1,
    });
  }
  const original = readFileSync(target, "utf8");
  if (process.env.HELM_ASSIGNMENTS_FAIL_SKILL_REPLACE === "1") {
    throw new Error(
      "injected skill replacement failure (HELM_ASSIGNMENTS_FAIL_SKILL_REPLACE)",
    );
  }
  writeTextAtomic(target, skill.content, { durable: true });
  return { target, original };
}

export function restoreSkillUpdate(snapshot) {
  if (snapshot)
    writeTextAtomic(snapshot.target, snapshot.original, { durable: true });
}

// --skill rewrites file content in place, so it only touches a skill this
// assignment owns. An external path or symlink is someone else's file.
export function refuseExternalSkillWrite(skill, externalSkill) {
  if (!skill || !externalSkill) return;
  throw Object.assign(
    new Error(
      `--skill will not overwrite ${externalSkill}: it is outside this assignment's home or a symlink; edit it there or --skill-path to a new file`,
    ),
    { code: "skill_path_external", exitCode: 2 },
  );
}
