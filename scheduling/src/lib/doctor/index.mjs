import { BANDS, BAND_FLAGS, CHECKS } from "./bands.mjs";
import * as checkFns from "./checks.mjs";

export { BANDS, BAND_FLAGS, CHECKS };

function resolveBands(requested) {
  if (!Array.isArray(requested) || requested.length === 0) return BANDS.slice();
  const valid = new Set(BANDS);
  return requested.filter((band) => valid.has(band));
}

export async function runDeepDoctor({
  bands = null,
  scope = null,
  exec = {},
  now = Date.now(),
} = {}) {
  if (typeof checkFns._resetCheckMemos === "function")
    checkFns._resetCheckMemos();
  const selectedBands = new Set(resolveBands(bands));
  const dispatched = CHECKS.filter((check) => selectedBands.has(check.band));

  const results = await Promise.all(
    dispatched.map(async (spec) => {
      const fn = checkFns[`check_${spec.name}`];
      const started = process.hrtime.bigint();
      let result;
      try {
        result =
          typeof fn === "function"
            ? await fn({ exec, scope, now })
            : { ok: false, error: "check_not_implemented" };
      } catch (err) {
        result = { ok: false, error: err?.message || String(err) };
      }
      const duration_ms = Number(
        (process.hrtime.bigint() - started) / 1_000_000n,
      );
      return {
        name: spec.name,
        band: spec.band,
        result: {
          ...result,
          band: spec.band,
          gates_in_mode: Boolean(spec.gates_in_mode()),
          duration_ms,
        },
      };
    }),
  );

  const behavior = { deep: true, bands_selected: [...selectedBands] };
  for (const band of BANDS) {
    if (!selectedBands.has(band)) {
      behavior[band] = { skipped: true, reason: "band_not_selected" };
      continue;
    }
    behavior[band] = Object.fromEntries(
      results
        .filter((entry) => entry.band === band)
        .map((entry) => [entry.name, entry.result]),
    );
  }

  const failing_checks = results
    .filter(({ result }) => result.ok === false && result.gates_in_mode)
    .map(({ name }) => name);
  return { ok: failing_checks.length === 0, behavior, failing_checks };
}

export async function runSingleCheck(
  name,
  { scope = null, exec = {}, now = Date.now() } = {},
) {
  const spec = CHECKS.find((check) => check.name === name);
  if (!spec) return { ok: false, error: "unknown_check", name };
  if (typeof checkFns._resetCheckMemos === "function")
    checkFns._resetCheckMemos();
  const fn = checkFns[`check_${name}`];
  const started = process.hrtime.bigint();
  let result;
  try {
    result =
      typeof fn === "function"
        ? await fn({ exec, scope, now })
        : { ok: false, error: "check_not_implemented" };
  } catch (err) {
    result = { ok: false, error: err?.message || String(err) };
  }
  return {
    ok: result.ok !== false,
    name,
    result: {
      ...result,
      band: spec.band,
      gates_in_mode: Boolean(spec.gates_in_mode()),
      duration_ms: Number((process.hrtime.bigint() - started) / 1_000_000n),
    },
  };
}
