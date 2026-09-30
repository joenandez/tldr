// One hard-runtime policy shared by the reaper and assignment completion.
// An explicit non-positive limit opts out; otherwise every run inherits the
// configured default or Helm's six-hour ceiling.

export const DEFAULT_HARD_TIMEOUT_SEC = 21_600;

export function effectiveHardTimeoutSec(job, entry = null, env = process.env) {
  const fromEntry = entry?.limits?.hard_timeout_sec;
  if (typeof fromEntry === "number") return fromEntry > 0 ? fromEntry : null;
  const fromJob = job?.limits?.hard_timeout_sec;
  if (typeof fromJob === "number") return fromJob > 0 ? fromJob : null;
  const fromEnv = Number(env.HELM_DEFAULT_HARD_TIMEOUT_SEC);
  if (Number.isFinite(fromEnv)) return fromEnv > 0 ? fromEnv : null;
  return DEFAULT_HARD_TIMEOUT_SEC;
}

export function completionDeadlineAt({
  startedAt,
  job = null,
  entry = null,
  env = process.env,
}) {
  const startedMs = Date.parse(startedAt || "");
  const timeoutSec = effectiveHardTimeoutSec(job, entry, env);
  if (Number.isNaN(startedMs) || timeoutSec === null) return null;
  return new Date(startedMs + timeoutSec * 1000).toISOString();
}
