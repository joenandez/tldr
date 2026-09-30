// PRFAQ-0-4 Phase 3 — workspaces-root resolver.
//
// Two implementations, consulted in order:
//
//   1. Subspace-registered resolver hook. Subspace's installer calls
//      registerWorkspaceResolver(impl) at boot. The substrate calls the hook
//      first; on success uses its answer, on failure (throws or returns
//      { ok: false }) falls through to the plain-file resolver. Failure
//      isolation per PRFAQ-0-4 internal FAQ on extension hooks.
//
//   2. Plain-file resolver. Reads workspaces-root from (in order) explicit
//      param → HELM_WORKSPACES_ROOT env → <helm home>/identity.json:workspaces_root
//      (Phase 4 writes that file; Phase 3 reads it best-effort). Composes
//      <workspaces-root>/<workspace-name>. Refuses path-escape (no `..`, no
//      absolute paths, no path separators in the name).
//
// Consumed by workspace resolution callers (Phase 3 spawn-end
// resolver) and by `helm-tasks workspaces list --emit-aliases`.

import { existsSync, readFileSync, statSync } from "node:fs";
import {
  basename,
  dirname,
  join,
  resolve as resolvePath,
  sep as pathSep,
} from "node:path";
import { appendActivityEvent } from "../activity_stream.mjs";
import { listRegisteredScopes } from "../scopes.mjs";
import { helmHome } from "../store.mjs";

let registeredResolver = null;

// Subspace (or any future consumer) registers a workspaceResolver impl at
// boot. impl: (workspaceName) => { ok: true, cwd, ws } | { ok: false, error }
// | null. Throwing falls through to the plain-file resolver per the failure
// isolation contract.
export function registerWorkspaceResolver(impl) {
  registeredResolver =
    typeof impl === "function" || impl === null ? impl : registeredResolver;
  appendActivityEvent({
    type: "substrate_workspace_resolver_registered",
    level: "info",
    data: { registered: Boolean(impl) },
  });
  return registeredResolver;
}

function readIdentityWorkspacesRoot() {
  try {
    const idPath = join(helmHome(), "identity.json");
    if (!existsSync(idPath)) return null;
    const raw = readFileSync(idPath, "utf8");
    const parsed = JSON.parse(raw);
    const value = parsed?.workspaces_root || null;
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function readWorkspacesRoot(explicitRoot) {
  if (explicitRoot && typeof explicitRoot === "string") return explicitRoot;
  const envRoot = process.env.HELM_WORKSPACES_ROOT;
  if (envRoot && typeof envRoot === "string" && envRoot.length > 0)
    return envRoot;
  return readIdentityWorkspacesRoot();
}

// Workspace name validator. Lowercase alphanumeric + `._-`. No path
// separators. No leading `.`. 1-64 chars.
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function isValidWorkspaceName(name) {
  if (typeof name !== "string") return false;
  if (!NAME_RE.test(name)) return false;
  if (name.includes("..")) return false;
  return true;
}

function aliasSegment(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");
}

function aliasSuffixes(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) return null;
  const normalized = cwd.replace(/\/+$/, "");
  const segments = normalized
    .split(/[\\/]+/)
    .map(aliasSegment)
    .filter(Boolean);
  const out = [];
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const candidate = segments.slice(i).join("-");
    if (candidate && !out.includes(candidate)) out.push(candidate);
  }
  return out;
}

function qualifiedScopeAlias(cwd, peerCwds = null) {
  const suffixes = aliasSuffixes(cwd);
  if (!suffixes || suffixes.length < 2) return null;
  const qualified = suffixes.slice(1);
  if (!Array.isArray(peerCwds) || peerCwds.length === 0) return qualified[0];
  const peerSuffixes = peerCwds.map((peer) => aliasSuffixes(peer) || []);
  for (const candidate of qualified) {
    const count = peerSuffixes.filter((aliases) =>
      aliases.includes(candidate),
    ).length;
    if (count === 1) return candidate;
  }
  return qualified[qualified.length - 1] || null;
}

function claimedScopeAlias(cwd, peerCwds = null) {
  const suffixes = aliasSuffixes(cwd);
  const leaf = suffixes?.[0] || aliasSegment(basename(cwd || ""));
  if (!leaf) return null;
  let peers = Array.isArray(peerCwds) ? peerCwds : null;
  if (!peers) {
    try {
      peers = listRegisteredScopes()
        .map((scope) => scope?.cwd)
        .filter(
          (entryCwd) => typeof entryCwd === "string" && entryCwd.length > 0,
        );
    } catch {
      peers = [];
    }
  }
  const normalized = normalizeRegisteredAlias(cwd);
  const normalizedPeers = peers.map(normalizeRegisteredAlias);
  const currentIndex = normalizedPeers.indexOf(normalized);
  if (currentIndex <= 0) return leaf;
  const priorPeers = peers.slice(0, currentIndex);
  const priorSameLeaf = priorPeers.some((peer) => {
    const peerLeaf =
      aliasSuffixes(peer)?.[0] || aliasSegment(basename(peer || ""));
    return peerLeaf === leaf;
  });
  if (!priorSameLeaf) return leaf;
  return qualifiedScopeAlias(cwd, peers) || leaf;
}

function legacyQualifiedScopeAlias(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) return null;
  const normalized = cwd.replace(/\/+$/, "");
  const leaf = aliasSegment(basename(normalized));
  const parent = aliasSegment(basename(dirname(normalized)));
  if (!leaf || !parent || leaf === parent) return null;
  return `${parent}--${leaf}`;
}

function normalizeRegisteredAlias(value) {
  return typeof value === "string"
    ? value.replace(/\/+$/, "").toLowerCase()
    : "";
}

function registeredScopeMatches(workspaceName) {
  const matches = [];
  const needle = normalizeRegisteredAlias(workspaceName);
  let scopes = [];
  try {
    scopes = listRegisteredScopes();
  } catch {
    scopes = [];
  }
  const registeredCwds = scopes
    .map((scope) => scope?.cwd)
    .filter((cwd) => typeof cwd === "string" && cwd.length > 0);
  for (const scope of scopes) {
    const cwd = scope?.cwd;
    if (typeof cwd !== "string" || cwd.length === 0) continue;
    const normalizedCwd = cwd.replace(/\/+$/, "");
    const suffixes = aliasSuffixes(normalizedCwd) || [];
    const leaf = suffixes[0] || aliasSegment(basename(normalizedCwd));
    const claimed = claimedScopeAlias(cwd, registeredCwds);
    const qualified = qualifiedScopeAlias(cwd, registeredCwds);
    const legacyQualified = legacyQualifiedScopeAlias(cwd);
    const aliases = [claimed, qualified, legacyQualified].map(
      normalizeRegisteredAlias,
    );
    if (!aliases.includes(needle)) continue;
    try {
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) continue;
    } catch {
      continue;
    }
    matches.push({
      ws: leaf,
      cwd,
      scope_id: scope.scope_id || cwd,
      alias: claimed || leaf,
      short_alias: leaf,
      qualified_alias: qualified,
      legacy_qualified_alias: legacyQualified,
    });
  }
  return matches;
}

function resolveRegisteredWorkspaceAlias(workspaceName) {
  const matches = registeredScopeMatches(workspaceName);
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    return {
      ok: false,
      error: "ambiguous_workspace_alias",
      candidates: matches.map((m) => ({
        ws: m.ws,
        cwd: m.cwd,
        scope_id: m.scope_id,
        alias: m.alias,
        short_alias: m.short_alias,
        qualified_alias: m.qualified_alias,
        legacy_qualified_alias: m.legacy_qualified_alias,
      })),
      hint: `Workspace alias "${workspaceName}" matches multiple registered scopes; use a qualified alias or route through the switchboard.`,
    };
  }
  const match = matches[0];
  appendActivityEvent({
    type: "substrate_workspace_resolved",
    level: "info",
    data: {
      workspace_name: workspaceName,
      claimed_alias: match.alias,
      short_alias: match.short_alias,
      source: "registered-scope",
      cwd: match.cwd,
      scope_id: match.scope_id,
    },
  });
  return {
    ok: true,
    cwd: match.cwd,
    ws: match.ws,
    source: "registered-scope",
    scope_id: match.scope_id,
    alias: match.alias,
    short_alias: match.short_alias,
    qualified_alias: match.qualified_alias,
  };
}

export function resolveWorkspace(
  workspaceName,
  { workspacesRoot = null } = {},
) {
  // Hook first.
  if (typeof registeredResolver === "function") {
    let hookResult = null;
    try {
      hookResult = registeredResolver(workspaceName);
    } catch (err) {
      appendActivityEvent({
        type: "substrate_workspace_resolver_hook_threw",
        level: "warn",
        error: err?.message || String(err),
        data: { workspace_name: workspaceName },
      });
      hookResult = null;
    }
    if (hookResult && hookResult.ok && hookResult.cwd) {
      appendActivityEvent({
        type: "substrate_workspace_resolved",
        level: "info",
        data: {
          workspace_name: workspaceName,
          source: "subspace",
          cwd: hookResult.cwd,
        },
      });
      return {
        ok: true,
        cwd: hookResult.cwd,
        ws: hookResult.ws || workspaceName,
        source: "subspace",
      };
    }
  }

  // scopes.json registry — consulted AFTER the Subspace hook and BEFORE
  // the plain-file path-convention fallback. Matching is case-insensitive
  // and trailing-slash-tolerant on the scope cwd basename.
  const registered = resolveRegisteredWorkspaceAlias(workspaceName);
  if (registered) return registered;

  if (!isValidWorkspaceName(workspaceName)) {
    return {
      ok: false,
      error: "invalid_workspace_name",
      hint: "Workspace names must match [a-z0-9][a-z0-9._-]{0,63} with no path separators or `..`.",
    };
  }

  const root = readWorkspacesRoot(workspacesRoot);
  if (!root) {
    return {
      ok: false,
      error: "workspaces_root_unset",
      hint: "Run `helm onboard --reconfigure workspaces-root` (Phase 4) or export HELM_WORKSPACES_ROOT.",
    };
  }

  const absRoot = resolvePath(root);
  const composed = resolvePath(join(absRoot, workspaceName));
  const rootWithSep = absRoot.endsWith(pathSep) ? absRoot : absRoot + pathSep;
  if (!composed.startsWith(rootWithSep) && composed !== absRoot) {
    return {
      ok: false,
      error: "workspace_escapes_root",
      hint: `Resolved cwd (${composed}) escapes workspaces-root (${absRoot}).`,
    };
  }

  let stat;
  try {
    if (existsSync(composed)) {
      stat = statSync(composed);
      if (!stat.isDirectory()) {
        return {
          ok: false,
          error: "workspace_not_found",
          cwd: composed,
          hint: `${composed} exists but is not a directory.`,
        };
      }
      appendActivityEvent({
        type: "substrate_workspace_resolved",
        level: "info",
        data: {
          workspace_name: workspaceName,
          source: "plain-file",
          cwd: composed,
          workspaces_root: absRoot,
        },
      });
      return {
        ok: true,
        cwd: composed,
        ws: workspaceName,
        source: "plain-file",
        workspaces_root: absRoot,
      };
    }
  } catch (err) {
    return {
      ok: false,
      error: "workspace_not_found",
      cwd: composed,
      hint: err?.message || "stat failed",
    };
  }

  return {
    ok: false,
    error: "workspace_not_found",
    cwd: composed,
    hint: `Create directory ${composed} or pick a workspace under ${absRoot}.`,
  };
}

export const _internals = {
  readWorkspacesRoot,
  isValidWorkspaceName,
  qualifiedScopeAlias,
  claimedScopeAlias,
  legacyQualifiedScopeAlias,
  registeredScopeMatches,
  _resetForTests() {
    registeredResolver = null;
  },
  _getRegisteredResolver() {
    return registeredResolver;
  },
};
