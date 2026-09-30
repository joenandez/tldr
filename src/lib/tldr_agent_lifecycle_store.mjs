import {
  existsSync,
  linkSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { assertStateRootCreatable, helmHome } from "./store.mjs";
import {
  configureLifecycleWritableDatabase,
  createLifecycleStoreFile,
  LifecycleStoreError,
  lifecycleStoreReadiness,
  LIFECYCLE_DESIRED_STATE_MODES,
  LIFECYCLE_STORE_SCHEMA_VERSION,
  normalizeLifecycleLockout,
  normalizeLifecycleMode,
  readLegacyLifecycleState,
  secureLifecycleStore,
} from "./tldr_agent_lifecycle_store_sqlite.mjs";

export {
  LifecycleStoreError,
  LIFECYCLE_DESIRED_STATE_MODES,
  LIFECYCLE_STORE_SCHEMA_VERSION,
};
export { LIFECYCLE_STORE_BUSY_TIMEOUT_MS } from "./tldr_agent_lifecycle_store_sqlite.mjs";

const LIFECYCLE_ORIGIN_FILE = "tldr-agent-lifecycle-origin.json";

function nowIso() {
  return new Date().toISOString();
}

export function lifecycleStorePath(home = helmHome()) {
  return join(home, "tldr-agent-lifecycle.sqlite");
}

export function lifecycleOriginPath(home = helmHome()) {
  return join(home, LIFECYCLE_ORIGIN_FILE);
}

export function lifecycleOriginIsRecorded({
  home = helmHome(),
  path = lifecycleOriginPath(home),
} = {}) {
  try {
    const origin = JSON.parse(readFileSync(path, "utf8"));
    return (
      origin?.schema_version === 1 &&
      origin.lifecycle_store_schema_version ===
        LIFECYCLE_STORE_SCHEMA_VERSION &&
      origin.state === "dedicated_lifecycle_store"
    );
  } catch {
    return false;
  }
}

export function recordLifecycleOrigin({
  home = helmHome(),
  path = lifecycleOriginPath(home),
} = {}) {
  if (existsSync(path)) {
    if (lifecycleOriginIsRecorded({ home, path })) return;
    throw new LifecycleStoreError(
      "lifecycle_origin_invalid",
      "lifecycle origin marker is invalid",
      { path },
    );
  }
  assertStateRootCreatable({
    component: "agent",
    root: home,
    operation: "lifecycle_origin",
  });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(
      temporary,
      `${JSON.stringify({
        schema_version: 1,
        lifecycle_store_schema_version: LIFECYCLE_STORE_SCHEMA_VERSION,
        state: "dedicated_lifecycle_store",
      })}\n`,
      { mode: 0o600 },
    );
    linkSync(temporary, path);
  } catch (error) {
    if (error?.code === "EEXIST" && lifecycleOriginIsRecorded({ home, path }))
      return;
    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
}

function lifecycleHomeSafetyRelaxed() {
  return (
    process.env.HELM_SERVICE_MODE === "fake" ||
    process.env.HELM_RELAX_HELM_HOME_SAFETY === "1" ||
    process.env.HELM_ALLOW_UNSAFE_HELM_HOME === "1"
  );
}

function lifecycleHomeSafetyReason(path) {
  const normalized = String(path || "")
    .replaceAll("\\", "/")
    .toLowerCase();
  if (
    normalized.startsWith("/volumes/") ||
    normalized.startsWith("/network/") ||
    normalized.startsWith("/net/")
  ) {
    return "sync_or_network_path";
  }
  return [
    "/dropbox/",
    "/onedrive/",
    "/google drive/",
    "/googledrive/",
    "/box sync/",
    "/box/",
    "/syncthing/",
    "/mobile documents/",
    "/icloud drive/",
    "/com~apple~clouddocs/",
  ].some((marker) => normalized.includes(marker))
    ? "sync_or_network_path"
    : null;
}

export function assertLifecycleHomeSafe({
  home = helmHome(),
  relaxed = lifecycleHomeSafetyRelaxed(),
} = {}) {
  const canonicalHome = (() => {
    try {
      return realpathSync(resolve(home));
    } catch {
      return resolve(home);
    }
  })();
  let reason = lifecycleHomeSafetyReason(canonicalHome);
  try {
    if ((statSync(canonicalHome).mode & 0o022) !== 0)
      reason ||= "unsafe_permissions";
  } catch {
    reason ||= "home_unreadable";
  }
  if (reason && !relaxed) {
    throw new LifecycleStoreError(
      "helm_home_unsafe",
      `HELM_HOME is unsafe for production runtime use: ${reason}`,
      { home, canonical_home: canonicalHome, reason },
    );
  }
  return {
    ok: true,
    home,
    canonical_home: canonicalHome,
    reason: reason || "ok",
  };
}

function missingState(path, reason) {
  return {
    configured: false,
    ready: false,
    mode: "disabled",
    lockout: null,
    lockout_active: false,
    allowed_to_start: false,
    reason,
    path,
    updated_at: null,
  };
}

function stateFromRow(row, path) {
  const lockout = row.lockout || null;
  const lockoutActive = Boolean(lockout);
  const reason = lockoutActive
    ? "desired_state_lockout_active"
    : row.mode === "disabled"
      ? "desired_state_disabled"
      : "desired_state_allowed";
  return {
    configured: true,
    ready: true,
    mode: row.mode,
    lockout,
    lockout_active: lockoutActive,
    allowed_to_start: row.mode !== "disabled" && !lockoutActive,
    reason,
    path,
    updated_at: row.updated_at,
  };
}

function requireReady(path) {
  const readiness = lifecycleStoreReadiness(path);
  if (!readiness.ok) {
    throw new LifecycleStoreError(
      readiness.code,
      readiness.message || `lifecycle store is not ready: ${readiness.code}`,
      { path },
    );
  }
  return readiness;
}

export function initializeLifecycleStore({
  home = helmHome(),
  path = lifecycleStorePath(home),
  now = nowIso,
} = {}) {
  if (!existsSync(path) && lifecycleOriginIsRecorded({ home })) {
    throw new LifecycleStoreError(
      "lifecycle_store_missing",
      "lifecycle store is missing after dedicated lifecycle activation",
      { path },
    );
  }
  if (!existsSync(path)) {
    createLifecycleStoreFile(path, {
      source: "clean_install",
      state: { mode: "disabled", lockout: null, reason: null },
      now,
    });
  }
  requireReady(path);
  secureLifecycleStore(path);
  recordLifecycleOrigin({ home });
  return readLifecycleDesiredState({ home, path });
}

export function readLifecycleDesiredState({
  home = helmHome(),
  path = lifecycleStorePath(home),
} = {}) {
  const readiness = lifecycleStoreReadiness(path);
  return readiness.ok
    ? stateFromRow(readiness.row, path)
    : missingState(path, readiness.code);
}

export function readLifecycleStoreSchemaVersion({
  home = helmHome(),
  path = lifecycleStorePath(home),
} = {}) {
  return lifecycleStoreReadiness(path).ok
    ? LIFECYCLE_STORE_SCHEMA_VERSION
    : null;
}

export function lifecycleStoreIsHealthy({
  home = helmHome(),
  path = lifecycleStorePath(home),
} = {}) {
  return lifecycleStoreReadiness(path).ok;
}

export function setLifecycleDesiredState({
  home = helmHome(),
  path = lifecycleStorePath(home),
  mode,
  lockout,
  reason = null,
  now = nowIso,
} = {}) {
  const normalizedMode = normalizeLifecycleMode(mode);
  const normalizedLockout = normalizeLifecycleLockout(lockout);
  requireReady(path);
  const db = new DatabaseSync(path);
  try {
    configureLifecycleWritableDatabase(db, path);
    db.exec("BEGIN IMMEDIATE");
    const existing = db
      .prepare("SELECT lockout FROM desired_state WHERE id = 1")
      .get();
    if (!existing) {
      throw new LifecycleStoreError(
        "lifecycle_desired_state_invalid",
        "lifecycle desired state is missing",
        { path },
      );
    }
    db.prepare(
      "UPDATE desired_state SET mode = ?, lockout = ?, reason = ?, updated_at = ? WHERE id = 1",
    ).run(
      normalizedMode,
      normalizedLockout === undefined ? existing.lockout : normalizedLockout,
      reason,
      now(),
    );
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    db.close();
    secureLifecycleStore(path);
  }
  return readLifecycleDesiredState({ home, path });
}

export function assertLifecycleDesiredStateAllowsStart(opts = {}) {
  const state = readLifecycleDesiredState(opts);
  if (!state.allowed_to_start) {
    throw new LifecycleStoreError(
      state.ready ? "desired_state_blocked" : state.reason,
      "desired state blocks scheduler start or dispatch",
      { desired_state: state },
    );
  }
  return state;
}

export function migrateLegacyDesiredState({
  home = helmHome(),
  path = lifecycleStorePath(home),
  legacyPath = join(home, "runtime.sqlite"),
  quiesced = false,
  verifiedInstalledSource = false,
  sourcePredatesLifecycleSplit = false,
  now = nowIso,
} = {}) {
  if (!quiesced) {
    throw new LifecycleStoreError(
      "lifecycle_migration_not_quiesced",
      "lifecycle migration requires daemon quiescence",
    );
  }
  if (!verifiedInstalledSource || !sourcePredatesLifecycleSplit) {
    throw new LifecycleStoreError(
      "lifecycle_migration_source_unverified",
      "lifecycle migration requires a verified installed pre-split source",
    );
  }
  if (existsSync(path)) {
    throw new LifecycleStoreError(
      "lifecycle_store_already_initialized",
      "lifecycle store already exists and cannot import legacy state",
      { path },
    );
  }
  if (lifecycleOriginIsRecorded({ home })) {
    throw new LifecycleStoreError(
      "lifecycle_store_missing",
      "lifecycle store is missing after dedicated lifecycle activation",
      { path },
    );
  }
  const state = readLegacyLifecycleState(legacyPath);
  createLifecycleStoreFile(path, {
    source: "verified_presplit_runtime_store",
    state,
    now,
  });
  recordLifecycleOrigin({ home });
  return readLifecycleDesiredState({ home, path });
}
