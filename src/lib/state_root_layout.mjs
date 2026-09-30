import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// The state-root layout and the checks that need only the layout: read-only
// inspection of one root, the one-root creation guard, and the canonical
// written root. Split from store.mjs (item 47); store.mjs re-exports every
// name exported here, so importers keep using store.mjs.

// One state root (Phase E, item 19): every component lives in a subdirectory
// of ~/.tldr-agents. Each keeps its own override variable; only the defaults
// live here. The legacy roots stay as compatibility symlinks until item 36.
export const STATE_ROOT_PARENT = ".tldr-agents";
export const STATE_ROOT_MIGRATION_PENDING = "STATE_ROOT_MIGRATION_PENDING";
export const STATE_ROOT_TEST_ISOLATION = "STATE_ROOT_TEST_ISOLATION";
export const STATE_ROOT_COMPONENTS = Object.freeze({
  agent: Object.freeze({
    variable: "TLDR_AGENT_HOME",
    subdirectory: "agent",
    legacy: ".tldr-agent",
  }),
  // Helm's own resolver (scheduling/src/lib/store.mjs) honors HELM_HOME. tldr
  // never does for Helm's root: in tldr processes HELM_HOME names tldr's own
  // store (the launchd plist and the Starport runtime set it to the agent root).
  helm: Object.freeze({
    variable: "HELM_HOME",
    subdirectory: "helm",
    legacy: ".helm",
  }),
  tightbeam: Object.freeze({
    variable: "TIGHTBEAM_STATE_ROOT",
    subdirectory: "tightbeam",
    legacy: ".tightbeam",
  }),
});

function componentLayout(component) {
  const layout = STATE_ROOT_COMPONENTS[component];
  if (!layout)
    throw new TypeError(`unknown state root component: ${component}`);
  return layout;
}

export function defaultStateRoot(component, userHome = homedir()) {
  return join(
    userHome,
    STATE_ROOT_PARENT,
    componentLayout(component).subdirectory,
  );
}

export function legacyStateRoot(component, userHome = homedir()) {
  return join(userHome, componentLayout(component).legacy);
}

function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function pathKind(path) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return "symlink";
    return stat.isDirectory() ? "directory" : "other";
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return "absent";
    return "unreadable";
  }
}

export function logStateRootEvent(level, event, fields = {}) {
  try {
    process.stderr.write(
      `${JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })}\n`,
    );
  } catch {
    // Logging never changes the outcome of a state-root decision.
  }
}

// Read-only: never creates, moves, or follows anything beyond realpath/lstat.
export function inspectStateRoot({
  component,
  root,
  userHome = homedir(),
} = {}) {
  const path = resolve(root);
  const defaultPath = resolve(defaultStateRoot(component, userHome));
  const legacyPath = resolve(legacyStateRoot(component, userHome));
  const kind = pathKind(path);
  const legacyKind = pathKind(legacyPath);
  const exists = existsSync(path);
  const isDefaultLocation = path === defaultPath;
  return Object.freeze({
    component,
    path,
    exists,
    kind,
    default_path: defaultPath,
    is_default_location: isDefaultLocation,
    legacy_path: legacyPath,
    legacy_kind: legacyKind,
    legacy_real_directory: legacyKind === "directory",
    // The guard applies to the new location only: an explicit override that
    // names another directory is the operator's choice, and a path that
    // already exists (including through the legacy symlink) splits nothing.
    migration_pending:
      !exists && isDefaultLocation && legacyKind === "directory",
  });
}

// Diagnostics and store writers can hit the guard repeatedly in one process;
// the refusal is logged once per operation and root.
const loggedPendingRefusals = new Set();

// Refuses to let a caller CREATE a component root while its legacy root is
// still a real directory: that would start a second, empty copy of the state.
// Cheap when the root exists (one stat), so creation paths call it directly.
export function assertStateRootCreatable({
  component,
  root,
  userHome = homedir(),
  operation = "unspecified",
} = {}) {
  if (existsSync(root)) return null;
  const inspected = inspectStateRoot({ component, root, userHome });
  if (!inspected.migration_pending) return inspected;
  const logKey = `${operation}\u0000${inspected.path}`;
  if (!loggedPendingRefusals.has(logKey)) {
    loggedPendingRefusals.add(logKey);
    logStateRootEvent("warn", "state_root_migration_pending", {
      status: "refused",
      params: {
        operation,
        component,
        root: inspected.path,
        legacy_root: inspected.legacy_path,
      },
    });
  }
  const error = new Error(
    `tldr; ${component} state is still at ${inspected.legacy_path}; ` +
      `refusing to create ${inspected.path} before the state root migration`,
  );
  error.code = STATE_ROOT_MIGRATION_PENDING;
  error.details = Object.freeze({
    operation,
    pending: Object.freeze([inspected]),
  });
  throw error;
}

// Written values (plists, daemon argv) name the new root even when the value
// arrived through a legacy compatibility symlink, e.g. a resumed session that
// still carries TIGHTBEAM_STATE_ROOT=~/.tightbeam.
export function canonicalStateRoot({
  component,
  root,
  userHome = homedir(),
} = {}) {
  const path = resolve(root);
  const defaultPath = resolve(defaultStateRoot(component, userHome));
  if (path === defaultPath || !existsSync(defaultPath)) return path;
  return canonicalPath(path) === canonicalPath(defaultPath)
    ? defaultPath
    : path;
}
