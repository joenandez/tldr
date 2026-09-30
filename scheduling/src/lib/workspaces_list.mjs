// PRFAQ-0-4 Phase 3 — workspaces list view for `helm-tasks workspaces list`.
//
// Read-only projection over the resolved workspaces-root (HELM_WORKSPACES_ROOT
// env, or ~/.helm/identity.json:workspaces_root once Phase 4 writes it).
// Returns immediate child directories with derived +<name> aliases.
//
// Subspace's compose UI consumes the JSON output; the welcome email (Phase 4)
// substitutes the first N aliases inline.

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { _internals as wsInternals } from "./substrate/workspaces.mjs";
import { listRegisteredScopes } from "./scopes.mjs";

function registeredScopeEntries() {
  let scopes = [];
  try {
    scopes = listRegisteredScopes();
  } catch {
    scopes = [];
  }
  const registeredCwds = scopes
    .map((scope) => scope?.cwd)
    .filter((cwd) => typeof cwd === "string" && cwd.length > 0);
  const entries = [];
  for (const scope of scopes) {
    const cwd = scope?.cwd;
    if (typeof cwd !== "string" || cwd.length === 0) continue;
    const wsName = basename(cwd);
    if (!wsInternals.isValidWorkspaceName(wsName)) continue;
    try {
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) continue;
    } catch {
      continue;
    }
    const claimedAlias = wsInternals.claimedScopeAlias(cwd, registeredCwds);
    entries.push({
      ws: wsName,
      cwd,
      source: "registered-scope",
      ws_alias: claimedAlias || wsName,
      qualified_ws_alias: wsInternals.qualifiedScopeAlias(cwd, registeredCwds),
      parent_ws: basename(dirname(cwd)) || null,
      last_active_at: null,
      scope_id: scope.scope_id || cwd,
    });
  }
  return entries;
}

export function listWorkspacesForCli({
  scope: _scope,
  emitAliases: _emitAliases = false,
  limit = null,
} = {}) {
  const root = wsInternals.readWorkspacesRoot(null);
  if (!root) {
    return {
      workspaces: [],
      workspaces_root: null,
      total: 0,
      hint: "workspaces-root unset; export HELM_WORKSPACES_ROOT or run `helm onboard --reconfigure workspaces-root` (Phase 4).",
    };
  }
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (err) {
    return {
      workspaces: [],
      workspaces_root: root,
      total: 0,
      hint: `Could not read workspaces-root (${root}): ${err?.message || err}.`,
    };
  }
  const workspaces = [];
  const seenCwds = new Set();
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith(".")) continue;
    if (!wsInternals.isValidWorkspaceName(ent.name)) continue;
    const wsName = ent.name;
    const entry = {
      ws: wsName,
      cwd: `${root}/${wsName}`,
      source: "plain-file",
      ws_alias: wsName,
      last_active_at: null,
    };
    seenCwds.add(entry.cwd);
    workspaces.push(entry);
  }

  for (const entry of registeredScopeEntries()) {
    if (seenCwds.has(entry.cwd)) continue;
    workspaces.push(entry);
  }

  if (_emitAliases) {
    const plainAliases = new Set(
      workspaces
        .filter((entry) => entry.source === "plain-file")
        .map((entry) => entry.ws_alias),
    );
    const registeredAliasCounts = new Map();
    for (const entry of workspaces) {
      if (!entry.ws_alias) continue;
      if (entry.source !== "registered-scope") continue;
      if (plainAliases.has(entry.ws_alias)) continue;
      registeredAliasCounts.set(
        entry.ws_alias,
        (registeredAliasCounts.get(entry.ws_alias) || 0) + 1,
      );
    }
    for (const entry of workspaces) {
      if (entry.source !== "registered-scope") continue;
      if (plainAliases.has(entry.ws_alias)) {
        entry.ws_alias_shadowed_by_root = true;
      } else if (registeredAliasCounts.get(entry.ws_alias) > 1) {
        entry.ws_alias_ambiguous = true;
      }
    }
  }

  workspaces.sort((a, b) => {
    const aActive = a.last_active_at || "";
    const bActive = b.last_active_at || "";
    if (aActive !== bActive) return bActive.localeCompare(aActive);
    return a.ws.localeCompare(b.ws);
  });
  const truncated = limit ? workspaces.slice(0, Number(limit)) : workspaces;
  return {
    workspaces: truncated,
    workspaces_root: root,
    total: workspaces.length,
  };
}
