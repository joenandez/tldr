import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { writeTextAtomic } from "./durable_file_io.mjs";

export function resolveAssignmentUpdateInput(flags) {
  const providerPatch =
    flags.provider === undefined
      ? undefined
      : flags.provider === "null"
        ? null
        : flags.provider;
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
