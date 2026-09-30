import "./node_sqlite_warning.mjs";
import { chmodSync, existsSync, linkSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { assertStateRootCreatable } from "./store.mjs";

export const LIFECYCLE_STORE_SCHEMA_VERSION = 1;
export const LIFECYCLE_STORE_BUSY_TIMEOUT_MS = 5000;
export const LIFECYCLE_DESIRED_STATE_MODES = Object.freeze([
  "disabled",
  "monitor_only",
  "dry_run",
  "allowlist",
  "live",
]);

export class LifecycleStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "LifecycleStoreError";
    this.code = code;
    this.details = details;
  }
}

function nowIso() {
  return new Date().toISOString();
}

export function normalizeLifecycleMode(mode) {
  const value = String(mode || "").trim();
  if (!LIFECYCLE_DESIRED_STATE_MODES.includes(value)) {
    throw new LifecycleStoreError(
      "desired_state_invalid_mode",
      `invalid desired-state mode: ${mode}`,
      { mode, supported_modes: LIFECYCLE_DESIRED_STATE_MODES },
    );
  }
  return value;
}

export function normalizeLifecycleLockout(lockout) {
  if (lockout === undefined) return undefined;
  const value = String(lockout || "").trim();
  return !value || value === "none" || value === "clear" ? null : value;
}

export function secureLifecycleStore(path) {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(candidate) && process.platform !== "win32") {
      chmodSync(candidate, 0o600);
    }
  }
}

export function configureLifecycleWritableDatabase(db, path) {
  db.exec(
    `PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${LIFECYCLE_STORE_BUSY_TIMEOUT_MS};`,
  );
  secureLifecycleStore(path);
}

function configureLifecycleReadableDatabase(db) {
  db.exec(`PRAGMA busy_timeout = ${LIFECYCLE_STORE_BUSY_TIMEOUT_MS};`);
}

export function createLifecycleStoreFile(
  path,
  { source, state, now = nowIso } = {},
) {
  assertStateRootCreatable({
    component: "agent",
    root: dirname(path),
    operation: "lifecycle_store",
  });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  let db = null;
  try {
    db = new DatabaseSync(tempPath);
    db.exec(
      "PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;",
    );
    db.exec(`
      CREATE TABLE lifecycle_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE desired_state (id INTEGER PRIMARY KEY CHECK (id = 1), mode TEXT NOT NULL, lockout TEXT, reason TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE lifecycle_import (id INTEGER PRIMARY KEY CHECK (id = 1), source TEXT NOT NULL, completed_at TEXT NOT NULL);
    `);
    const timestamp = now();
    db.prepare(
      "INSERT INTO lifecycle_schema (id, version, updated_at) VALUES (1, ?, ?)",
    ).run(LIFECYCLE_STORE_SCHEMA_VERSION, timestamp);
    db.prepare(
      "INSERT INTO desired_state (id, mode, lockout, reason, updated_at) VALUES (1, ?, ?, ?, ?)",
    ).run(
      state.mode,
      state.lockout,
      state.reason || null,
      state.updated_at || timestamp,
    );
    db.prepare(
      "INSERT INTO lifecycle_import (id, source, completed_at) VALUES (1, ?, ?)",
    ).run(source, timestamp);
    db.exec("COMMIT");
    db.close();
    db = null;
    chmodSync(tempPath, 0o600);
    try {
      linkSync(tempPath, path);
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new LifecycleStoreError(
          "lifecycle_store_already_initialized",
          "lifecycle store already exists",
          { path },
        );
      }
      throw error;
    }
  } catch (error) {
    try {
      db?.exec("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    db?.close();
    rmSync(tempPath, { force: true });
  }
  secureLifecycleStore(path);
}

function tableColumns(db, table) {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map(({ name }) => name),
  );
}

export function lifecycleStoreReadiness(path) {
  if (!existsSync(path)) return { ok: false, code: "lifecycle_store_missing" };
  let db = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    configureLifecycleReadableDatabase(db);
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map(({ name }) => name),
    );
    for (const table of [
      "lifecycle_schema",
      "desired_state",
      "lifecycle_import",
    ]) {
      if (!tables.has(table))
        return {
          ok: false,
          code:
            table === "lifecycle_import"
              ? "lifecycle_import_marker_missing"
              : "lifecycle_store_schema_missing",
        };
    }
    const schema = db
      .prepare("SELECT version FROM lifecycle_schema WHERE id = 1")
      .get();
    if (!schema || schema.version !== LIFECYCLE_STORE_SCHEMA_VERSION)
      return { ok: false, code: "lifecycle_store_schema_incompatible" };
    const marker = db
      .prepare("SELECT source FROM lifecycle_import WHERE id = 1")
      .get();
    if (!marker) return { ok: false, code: "lifecycle_import_marker_missing" };
    const row = db.prepare("SELECT * FROM desired_state WHERE id = 1").get();
    if (
      !row ||
      !LIFECYCLE_DESIRED_STATE_MODES.includes(row.mode) ||
      (row.lockout !== null && typeof row.lockout !== "string")
    )
      return { ok: false, code: "lifecycle_desired_state_invalid" };
    return { ok: true, row };
  } catch (error) {
    return {
      ok: false,
      code: "lifecycle_store_unreadable",
      message: error?.message || "lifecycle store cannot be read",
    };
  } finally {
    db?.close();
  }
}

export function readLegacyLifecycleState(legacyPath) {
  if (!existsSync(legacyPath))
    return { mode: "disabled", lockout: null, reason: null, updated_at: null };
  let db = null;
  try {
    db = new DatabaseSync(legacyPath, { readOnly: true });
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map(({ name }) => name),
    );
    if (!tables.has("desired_state"))
      return {
        mode: "disabled",
        lockout: null,
        reason: null,
        updated_at: null,
      };
    const columns = tableColumns(db, "desired_state");
    for (const column of ["id", "mode", "lockout", "reason", "updated_at"]) {
      if (!columns.has(column))
        throw new Error(`legacy desired_state is missing ${column}`);
    }
    const row = db.prepare("SELECT * FROM desired_state WHERE id = 1").get();
    if (!row)
      return {
        mode: "disabled",
        lockout: null,
        reason: null,
        updated_at: null,
      };
    if (
      !LIFECYCLE_DESIRED_STATE_MODES.includes(row.mode) ||
      (row.lockout !== null && typeof row.lockout !== "string") ||
      (row.reason !== null && typeof row.reason !== "string") ||
      typeof row.updated_at !== "string"
    )
      throw new Error("legacy desired_state row is invalid");
    return row;
  } catch (error) {
    throw new LifecycleStoreError(
      "legacy_desired_state_unreadable",
      `cannot safely import legacy desired state from ${legacyPath}: ${error?.message || error}`,
      { path: legacyPath },
    );
  } finally {
    db?.close();
  }
}
