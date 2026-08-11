// PRFAQ-0 Phase 1 — substrate identity (Tasks 1.7).
// Encapsulates URI parsing, thread-id allocation, and workspace-id validation
// in one place so transport drivers stay dumb.

import { randomBytes } from "node:crypto";

const V1_SCHEMES = new Set(["email"]);

export function allocateThreadId(targetClass) {
  const prefix = TARGET_CLASS_PREFIX[targetClass] || "thr";
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

const TARGET_CLASS_PREFIX = {
  email: "thr_email",
};

export function validateWorkspaceId(workspaceId) {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    return { ok: false, reason: "workspace_id_required" };
  }
  return { ok: true };
}

// Parse the tldr; product's single retained private owner-email target.
export function parseTargetUri(uri) {
  if (typeof uri !== "string" || uri.length === 0) {
    return { ok: false, scheme: null, reason: "target_required" };
  }
  const idx = uri.indexOf("://");
  if (idx <= 0) {
    return { ok: false, scheme: null, reason: "target_invalid" };
  }
  const scheme = uri.slice(0, idx);
  const remainder = uri.slice(idx + 3);
  if (!V1_SCHEMES.has(scheme)) {
    return { ok: false, scheme, reason: "unknown_transport" };
  }
  if (remainder.length === 0) {
    return { ok: false, scheme, reason: "target_invalid" };
  }
  if (scheme === "email") {
    return { ok: true, scheme, address: remainder };
  }
  return { ok: false, scheme, reason: "target_invalid" };
}

export function extractThreadIdFromTarget(uri) {
  const parsed = parseTargetUri(uri);
  if (!parsed.ok) return null;
  return parsed.threadId || null;
}

export function targetClassFromScheme(scheme) {
  if (V1_SCHEMES.has(scheme)) return scheme;
  return null;
}

export function isV1Scheme(scheme) {
  return V1_SCHEMES.has(scheme);
}

export function listV1Schemes() {
  return Array.from(V1_SCHEMES);
}
