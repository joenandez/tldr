// PRFAQ-0-4 Phase 4 — operator identity store.
//
// Single canonical identity file at <helm home>/identity.json with active
// operator/workspace fields:
//   - name              display name
//   - email             operator's email
//   - workspaces_root   parent directory for non-Subspace operators
//                       (default ~/Dev; null when Subspace-managed)
//
// Per PRFAQ-0-4 Appendix C Stage 2. Atomic write (temp + rename). Read-side
// returns null on torn JSON. Phase 3's workspaces.mjs already reads this
// best-effort via readIdentityWorkspacesRoot.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  assertHelmHomeCreatable,
  assertHelmHomeUsable,
  helmHomeFor,
} from "./store.mjs";

// An explicit HELM_HOME always wins, matching store.mjs helmHome(). These two
// resolvers used to disagree: store.mjs honored HELM_HOME while this one was
// pinned to ~/.helm, so a caller with an isolated home could still read the
// production operator identity. The default comes from store.mjs.
// Guarded like store.mjs helmHome() (state_root.mjs assertHelmHomeUsable).
export function getHelmHome() {
  return assertHelmHomeUsable(helmHomeFor({ envHome: process.env.HELM_HOME }));
}

export function getIdentityPath() {
  return join(getHelmHome(), "identity.json");
}

function ensureDir(path, mode = 0o700) {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode });
  }
}

export function readIdentity() {
  try {
    const p = getIdentityPath();
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function isIdentityConfigured() {
  const id = readIdentity();
  if (!id) return false;
  return typeof id.email === "string" && id.email.includes("@");
}

function validateIdentityShape(identity) {
  if (!identity || typeof identity !== "object") {
    throw new Error("identity must be an object");
  }
  if (
    typeof identity.name !== "string" ||
    identity.name.length === 0 ||
    identity.name.length > 200
  ) {
    throw new Error("identity.name must be a 1-200 char string");
  }
  if (typeof identity.email !== "string" || !identity.email.includes("@")) {
    throw new Error("identity.email must contain @");
  }
  if (
    identity.workspaces_root !== null &&
    identity.workspaces_root !== undefined &&
    typeof identity.workspaces_root !== "string"
  ) {
    throw new Error(
      "identity.workspaces_root must be string, null, or undefined",
    );
  }
  if (
    identity.default_workspace !== null &&
    identity.default_workspace !== undefined &&
    typeof identity.default_workspace !== "string"
  ) {
    throw new Error(
      "identity.default_workspace must be string, null, or undefined",
    );
  }
  if (
    identity.agent_defaults !== null &&
    identity.agent_defaults !== undefined
  ) {
    if (
      typeof identity.agent_defaults !== "object" ||
      Array.isArray(identity.agent_defaults)
    ) {
      throw new Error(
        "identity.agent_defaults must be object, null, or undefined",
      );
    }
    const {
      primary,
      secondary,
      fallback_policy: fallbackPolicy,
    } = identity.agent_defaults;
    if (
      primary !== null &&
      primary !== undefined &&
      !["claude", "codex"].includes(primary)
    ) {
      throw new Error(
        "identity.agent_defaults.primary must be claude or codex",
      );
    }
    if (
      secondary !== null &&
      secondary !== undefined &&
      !["claude", "codex"].includes(secondary)
    ) {
      throw new Error(
        "identity.agent_defaults.secondary must be claude or codex",
      );
    }
    if (primary && secondary && primary === secondary) {
      throw new Error(
        "identity.agent_defaults primary and secondary must differ",
      );
    }
    if (
      fallbackPolicy !== null &&
      fallbackPolicy !== undefined &&
      !["always", "never"].includes(fallbackPolicy)
    ) {
      throw new Error(
        "identity.agent_defaults.fallback_policy must be always or never",
      );
    }
  }
}

export function writeIdentity(identity) {
  validateIdentityShape(identity);
  assertHelmHomeCreatable(getHelmHome());
  ensureDir(getHelmHome(), 0o700);
  const target = getIdentityPath();
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  const payload = {
    name: identity.name,
    email: identity.email,
    workspaces_root: identity.workspaces_root ?? null,
    subspace_managed_workspaces: identity.subspace_managed_workspaces === true,
    default_workspace: identity.default_workspace ?? null,
    agent_defaults: identity.agent_defaults || {
      primary: "codex",
      secondary: "claude",
      fallback_policy: "always",
    },
    updated_at: new Date().toISOString(),
    schema_version: 1,
  };
  writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  renameSync(tmp, target);
  return { ok: true, path: target };
}

export function redactIdentity(identity) {
  if (!identity) return null;
  const activeIdentity = { ...identity };
  delete activeIdentity.agentmail_key_path;
  delete activeIdentity.agentmail_key_present;
  delete activeIdentity.agentmail_key_fingerprint;
  return activeIdentity;
}

export const _internals = {
  validateIdentityShape,
  ensureDir,
};
