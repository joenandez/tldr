import { randomUUID } from "node:crypto";

export function mintSessionId() {
  return randomUUID();
}

function resolveJsonPath(obj, path) {
  if (!path || typeof path !== "string") return undefined;
  const cleaned = path.startsWith("$.")
    ? path.slice(2)
    : path.startsWith("$")
      ? path.slice(1)
      : path;
  if (cleaned === "") return obj;
  const parts = cleaned.split(".").filter(Boolean);
  let cur = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

function matchesPredicate(record, match) {
  if (!match || typeof match !== "object") return true;
  return Object.entries(match).every(([k, v]) => record?.[k] === v);
}

export function parseCapturedSessionId(
  spec,
  { stdout = "", stderr = "" } = {},
) {
  const source = spec.from === "stderr" ? stderr : stdout;
  if (!source) return null;
  if (spec.parse === "json") {
    try {
      const obj = JSON.parse(source);
      const v = resolveJsonPath(obj, spec.path);
      return v !== undefined && v !== null ? String(v) : null;
    } catch {
      return null;
    }
  }
  if (spec.parse === "jsonl") {
    for (const line of source.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let record;
      try {
        record = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!matchesPredicate(record, spec.match)) continue;
      const v = resolveJsonPath(record, spec.path);
      if (v !== undefined && v !== null) return String(v);
    }
    return null;
  }
  if (spec.parse === "regex") {
    const re = new RegExp(spec.pattern);
    const m = source.match(re);
    return m && m[1] !== undefined ? m[1] : null;
  }
  return null;
}

export function resolveSidecarDiff({ before = [], after = [] } = {}) {
  const beforeSet = new Set(before);
  const newIds = after.filter((id) => !beforeSet.has(id));
  const count = newIds.length;
  if (count === 1) {
    return {
      session_id: newIds[0],
      resume_confidence: "high",
      resume_candidates: [newIds[0]],
    };
  }
  if (count === 2 || count === 3) {
    return {
      session_id: null,
      resume_confidence: "low",
      resume_candidates: newIds,
    };
  }
  return { session_id: null, resume_confidence: null, resume_candidates: [] };
}
