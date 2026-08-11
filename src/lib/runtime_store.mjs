import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { helmHome } from "./store.mjs";
import { isProcessAlive } from "./process_liveness.mjs";
import { emitSafetyEvent } from "./safety_events.mjs";
import { tryOpenCurrentRuntimeStore } from "./runtime_store_fast_path.mjs";
import {
  applyOwnerOnlyPermissions,
  applyRuntimeStorePermissions,
} from "./runtime_store_permissions.mjs";
import {
  MIGRATION_RESERVED_8,
  MIGRATION_RESERVED_9,
  MIGRATION_TLDR_AGENT_MESSAGE_PAYLOADS,
  MIGRATION_DISPATCH_DUE_INDEX,
  MIGRATION_CANONICAL_TABLES,
} from "./runtime_store_halcyon_migrations.mjs";
import { MIGRATION_TLDR_AGENT_BEACON } from "./runtime_store_beacon_migration.mjs";
import { backupRuntimeStoreUpgrade } from "./runtime_store_backup.mjs";
import { emitRuntimeStoreReadinessFailure } from "./runtime_store_readiness_events.mjs";
import { runRuntimeStoreTransaction } from "./runtime_store_transaction.mjs";
const require = createRequire(import.meta.url);
let DatabaseSyncClass = null;
function openDatabaseSync(path) {
  if (!DatabaseSyncClass) {
    ({ DatabaseSync: DatabaseSyncClass } = require("node:sqlite"));
  }
  return new DatabaseSyncClass(path);
}
export const CURRENT_RUNTIME_SCHEMA_VERSION = 11;
export const RUNTIME_STORE_BUSY_TIMEOUT_MS = 5000;
export const DESIRED_STATE_MODES = Object.freeze([
  "disabled",
  "monitor_only",
  "dry_run",
  "allowlist",
  "live",
]);
export const OUTBOUND_MODES = Object.freeze([
  "disabled",
  "dry_run",
  "allowlist",
  "live",
]);
export function pinTldrAgentSqliteMode(env = process.env) {
  env.HELM_CANONICAL_SQLITE = "1";
  delete env.HELM_CANONICAL_SQLITE_KILL_SWITCH;
  return { enabled: true };
}
export function runtimeStoreCompatibilityContract() {
  return {
    current_schema_version: CURRENT_RUNTIME_SCHEMA_VERSION,
    minimum_startup_schema_version: CURRENT_RUNTIME_SCHEMA_VERSION,
    n_minus_1_read_supported: false,
    schema_pin_enforced: true,
    compatibility_policy:
      "scheduler startup requires the current runtime schema; status output exposes this schema pin so Subspace can refuse incompatible runtimes explicitly",
  };
}
export class RuntimeStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RuntimeStoreError";
    this.code = code;
    this.details = details;
  }
}
function nowIso() {
  return new Date().toISOString();
}
function lockId() {
  return `lock_${randomBytes(16).toString("hex")}`;
}

export function runtimeStorePath(home = helmHome()) {
  return join(home, "runtime.sqlite");
}

export function runtimeStoreLockPath(home = helmHome()) {
  return join(home, "runtime-store.lock");
}

export function runtimeStoreBackupRoot(home = helmHome()) {
  return join(home, "backups", "runtime-store");
}

export function canonicalHelmHome(home = helmHome()) {
  const resolved = resolve(home);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function helmHomeSafetyRelaxed() {
  return (
    process.env.HELM_SERVICE_MODE === "fake" ||
    process.env.HELM_RELAX_HELM_HOME_SAFETY === "1" ||
    process.env.HELM_ALLOW_UNSAFE_HELM_HOME === "1"
  );
}

function syncOrNetworkPathReason(path) {
  const normalized = String(path || "")
    .replaceAll("\\", "/")
    .toLowerCase();
  if (
    normalized.startsWith("/volumes/") ||
    normalized.startsWith("/network/") ||
    normalized.startsWith("/net/")
  ) {
    return "network_mount";
  }
  const markers = [
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
  ];
  return markers.some((marker) => normalized.includes(marker))
    ? "sync_folder"
    : null;
}

export function checkHelmHomeSafety({
  home = helmHome(),
  relaxed = helmHomeSafetyRelaxed(),
} = {}) {
  const canonical = canonicalHelmHome(home);
  const checks = [];
  let unsafeReason = null;
  let unsafeCode = null;

  try {
    const mode = statSync(canonical).mode & 0o777;
    const unsafeBits = mode & 0o022;
    checks.push({
      name: "owner_only_permissions",
      ok: unsafeBits === 0,
      mode: `0${mode.toString(8)}`,
    });
    if (unsafeBits !== 0) {
      unsafeReason = "unsafe_permissions";
      unsafeCode = "helm_home_unsafe_permissions";
    }
  } catch (err) {
    checks.push({
      name: "owner_only_permissions",
      ok: false,
      error: err?.code || "stat_failed",
    });
    unsafeReason = "home_unreadable";
    unsafeCode = "helm_home_unreadable";
  }

  const locationReason = syncOrNetworkPathReason(canonical);
  checks.push({
    name: "local_filesystem_location",
    ok: !locationReason,
    reason: locationReason,
  });
  if (locationReason && !unsafeReason) {
    unsafeReason = "sync_or_network_path";
    unsafeCode = "helm_home_sync_or_network_path";
  }

  const wouldBlockProduction = Boolean(unsafeReason);
  const ok = !wouldBlockProduction || relaxed;
  return {
    ok,
    relaxed: Boolean(relaxed),
    would_block_production: wouldBlockProduction,
    code: ok ? null : unsafeCode || "helm_home_unsafe",
    reason: ok
      ? relaxed && wouldBlockProduction
        ? "relaxed"
        : "ok"
      : unsafeReason || "unsafe",
    home,
    canonical_home: canonical,
    checks,
  };
}

export function assertHelmHomeSafe(opts = {}) {
  const safety = checkHelmHomeSafety(opts);
  if (!safety.ok) {
    throw new RuntimeStoreError(
      "helm_home_unsafe",
      `HELM_HOME is unsafe for production runtime use: ${safety.reason}`,
      { helm_home_safety: safety },
    );
  }
  return safety;
}

export function ensureRuntimeStoreHome(home = helmHome()) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    chmodSync(home, 0o700);
  }
}

export function acquireRuntimeStoreLock(home = helmHome(), opts = {}) {
  ensureRuntimeStoreHome(home);
  const path = runtimeStoreLockPath(home);
  const owner = opts.owner || `pid:${process.pid}`;
  const pidAlive = opts.pidAlive || isProcessAlive;
  let id = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    id = lockId();
    const payload = {
      lock_id: id,
      owner,
      holder_pid: process.pid,
      acquired_at: nowIso(),
    };

    try {
      writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      applyOwnerOnlyPermissions(path);
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;

      let existing = null;
      try {
        existing = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        // Malformed lock evidence is fail-closed: do not guess ownership.
      }
      const holderPid = Number(existing?.holder_pid || 0);
      if (
        attempt === 0 &&
        Number.isFinite(holderPid) &&
        holderPid > 0 &&
        !pidAlive(holderPid)
      ) {
        rmSync(path, { force: true });
        continue;
      }
      throw new RuntimeStoreError(
        "runtime_store_locked",
        "runtime store lock is already held",
        {
          lock_path: path,
          holder_pid:
            Number.isFinite(holderPid) && holderPid > 0 ? holderPid : null,
          owner: existing?.owner || null,
        },
      );
    }
  }

  let released = false;
  return () => {
    if (released) return false;
    released = true;
    let current;
    try {
      current = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return false;
    }
    if (current?.lock_id !== id) return false;
    rmSync(path, { force: true });
    return true;
  };
}

function pragmaValue(db, sql) {
  const row = db.prepare(sql).get();
  return row ? row[Object.keys(row)[0]] : null;
}

export function configureRuntimeDatabase(db) {
  db.exec(`PRAGMA busy_timeout = ${RUNTIME_STORE_BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA foreign_keys = ON");
  const journalMode = pragmaValue(db, "PRAGMA journal_mode = WAL");
  return {
    journal_mode: String(journalMode || "").toLowerCase(),
    foreign_keys: Number(pragmaValue(db, "PRAGMA foreign_keys")),
    busy_timeout: Number(pragmaValue(db, "PRAGMA busy_timeout")),
  };
}

function tableExists(db, name) {
  return Boolean(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name),
  );
}

function columnExists(db, table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column);
}

function addColumnIfMissing(db, table, column, definition) {
  if (columnExists(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function readRuntimeSchemaVersionFromDb(db) {
  if (tableExists(db, "runtime_schema")) {
    const row = db
      .prepare("SELECT version FROM runtime_schema WHERE id = 1")
      .get();
    if (!row || !Number.isInteger(row.version) || row.version < 0) {
      throw new RuntimeStoreError(
        "runtime_schema_invalid",
        "runtime store schema version row is missing or invalid",
      );
    }
    return row.version;
  }
  const userVersion = Number(pragmaValue(db, "PRAGMA user_version"));
  return Number.isInteger(userVersion) && userVersion > 0 ? userVersion : 0;
}

export function setRuntimeSchemaVersion(db, version, timestamp = nowIso()) {
  if (!Number.isInteger(version) || version < 0) {
    throw new RuntimeStoreError(
      "runtime_schema_invalid",
      `invalid runtime schema version: ${version}`,
    );
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_schema (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.prepare(
    `
      INSERT INTO runtime_schema (id, version, updated_at)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        version = excluded.version,
        updated_at = excluded.updated_at
    `,
  ).run(version, timestamp);
  db.exec(`PRAGMA user_version = ${version}`);
}

export const DEFAULT_RUNTIME_MIGRATIONS = [
  {
    toVersion: 1,
    name: "bootstrap runtime store",
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS runtime_schema (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          version INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    toVersion: 2,
    name: "desired state and outbound guard state",
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS desired_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          mode TEXT NOT NULL,
          lockout TEXT,
          reason TEXT,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS outbound_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          mode TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    toVersion: 3,
    name: "runtime ledger logical runs attempts and outbound effects",
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS logical_runs (
          logical_run_key TEXT PRIMARY KEY,
          scope_id TEXT NOT NULL,
          job_id TEXT NOT NULL,
          slot_key TEXT NOT NULL,
          scheduled_at TEXT NOT NULL,
          status TEXT NOT NULL CHECK (
            status IN (
              'pending',
              'claimed',
              'running',
              'succeeded',
              'failed',
              'skipped',
              'interrupted',
              'timed_out',
              'quarantined'
            )
          ),
          lease_token TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          finished_at TEXT,
          status_reason TEXT,
          metadata_json TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_logical_runs_scope_status
          ON logical_runs (scope_id, status, scheduled_at);

        CREATE INDEX IF NOT EXISTS idx_logical_runs_job_slot
          ON logical_runs (scope_id, job_id, slot_key);

        CREATE TABLE IF NOT EXISTS run_attempts (
          attempt_id TEXT PRIMARY KEY,
          logical_run_key TEXT NOT NULL,
          daemon_instance_id TEXT NOT NULL,
          wrapper_pid INTEGER,
          job_pid INTEGER,
          process_group_id INTEGER,
          wrapper_state TEXT CHECK (
            wrapper_state IS NULL OR wrapper_state IN (
              'spawned',
              'pg_ready',
              'pre_exec',
              'post_exec',
              'exited',
              'finalized'
            )
          ),
          lease_token TEXT NOT NULL,
          started_at TEXT NOT NULL,
          deadline_at TEXT,
          finished_at TEXT,
          status TEXT NOT NULL CHECK (
            status IN (
              'claimed',
              'running',
              'succeeded',
              'failed',
              'interrupted',
              'timed_out',
              'finalized'
            )
          ),
          cleanup_json TEXT,
          FOREIGN KEY (logical_run_key)
            REFERENCES logical_runs (logical_run_key)
            ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_run_attempts_logical_status
          ON run_attempts (logical_run_key, status, started_at);

        CREATE TABLE IF NOT EXISTS outbound_effects (
          side_effect_key TEXT PRIMARY KEY,
          namespace TEXT NOT NULL,
          logical_run_key TEXT,
          logical_event_key TEXT NOT NULL,
          channel TEXT NOT NULL,
          recipient TEXT NOT NULL,
          status TEXT NOT NULL CHECK (
            status IN (
              'blocked',
              'dry_run',
              'attempting',
              'accepted',
              'failed_definite',
              'ambiguous',
              'suppressed_duplicate'
            )
          ),
          payload_hash TEXT NOT NULL,
          render_inputs_hash TEXT NOT NULL,
          template_version TEXT,
          first_rendered_payload_ref TEXT,
          attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
          last_provider_message_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (logical_run_key)
            REFERENCES logical_runs (logical_run_key)
            ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_outbound_effects_status
          ON outbound_effects (status, updated_at);

        CREATE INDEX IF NOT EXISTS idx_outbound_effects_logical_run
          ON outbound_effects (logical_run_key, namespace);
      `);
    },
  },
  {
    toVersion: 4,
    name: "scope registry v2",
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS scope_registry_metadata (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          schema_version INTEGER NOT NULL,
          generation INTEGER NOT NULL CHECK (generation >= 0),
          updated_at TEXT NOT NULL,
          migrated_from_scopes_json_at TEXT,
          last_backup_path TEXT
        );

        INSERT INTO scope_registry_metadata (
          id,
          schema_version,
          generation,
          updated_at
        )
        VALUES (1, 2, 0, datetime('now'))
        ON CONFLICT(id) DO NOTHING;

        CREATE TABLE IF NOT EXISTS scope_registry (
          scope_id TEXT PRIMARY KEY,
          cwd TEXT NOT NULL,
          storage_root TEXT NOT NULL,
          generation INTEGER NOT NULL CHECK (generation >= 0),
          dispatch_state TEXT NOT NULL CHECK (
            dispatch_state IN ('disabled', 'enabled')
          ),
          quarantine_state TEXT NOT NULL CHECK (
            quarantine_state IN ('clear', 'quarantined')
          ),
          quarantine_reason TEXT,
          registered_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          enabled_at TEXT,
          disabled_at TEXT,
          actor TEXT,
          reason TEXT,
          source_json TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_scope_registry_dispatch_state
          ON scope_registry (dispatch_state, generation);

        CREATE INDEX IF NOT EXISTS idx_scope_registry_quarantine_state
          ON scope_registry (quarantine_state, generation);
      `);
    },
  },
  {
    toVersion: 5,
    name: "skyhook runtime ledger fields",
    apply(db) {
      addColumnIfMissing(db, "logical_runs", "identity_key", "TEXT");
      addColumnIfMissing(db, "logical_runs", "job_kind", "TEXT");
      addColumnIfMissing(db, "logical_runs", "state", "TEXT");
      addColumnIfMissing(db, "logical_runs", "claimed_at", "TEXT");
      addColumnIfMissing(db, "logical_runs", "started_at", "TEXT");
      addColumnIfMissing(db, "logical_runs", "last_heartbeat_at", "TEXT");
      addColumnIfMissing(db, "logical_runs", "deadline_at", "TEXT");
      addColumnIfMissing(db, "logical_runs", "exited_at", "TEXT");
      addColumnIfMissing(db, "logical_runs", "exit_code", "INTEGER");
      addColumnIfMissing(db, "logical_runs", "terminal_reason", "TEXT");
      addColumnIfMissing(db, "logical_runs", "terminal_source", "TEXT");
      addColumnIfMissing(db, "logical_runs", "supervisor_version", "TEXT");

      addColumnIfMissing(db, "run_attempts", "identity_key", "TEXT");
      addColumnIfMissing(db, "run_attempts", "job_kind", "TEXT");
      addColumnIfMissing(db, "run_attempts", "pid", "INTEGER");
      addColumnIfMissing(db, "run_attempts", "pgid", "INTEGER");
      addColumnIfMissing(db, "run_attempts", "state", "TEXT");
      addColumnIfMissing(db, "run_attempts", "claimed_at", "TEXT");
      addColumnIfMissing(db, "run_attempts", "last_heartbeat_at", "TEXT");
      addColumnIfMissing(db, "run_attempts", "exited_at", "TEXT");
      addColumnIfMissing(db, "run_attempts", "exit_code", "INTEGER");
      addColumnIfMissing(db, "run_attempts", "terminal_reason", "TEXT");
      addColumnIfMissing(db, "run_attempts", "terminal_source", "TEXT");
      addColumnIfMissing(db, "run_attempts", "supervisor_version", "TEXT");
      addColumnIfMissing(db, "run_attempts", "signal_source", "TEXT");
      addColumnIfMissing(db, "run_attempts", "startup_window_ms", "INTEGER");

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_logical_runs_identity_state
          ON logical_runs (identity_key, state, deadline_at);

        CREATE INDEX IF NOT EXISTS idx_run_attempts_identity_state
          ON run_attempts (identity_key, state, deadline_at);

        UPDATE logical_runs
        SET state = status,
            claimed_at = COALESCE(claimed_at, created_at),
            started_at = COALESCE(started_at, created_at),
            terminal_reason = COALESCE(terminal_reason, status_reason)
        WHERE state IS NULL;

        UPDATE run_attempts
        SET state = status,
            claimed_at = COALESCE(claimed_at, started_at),
            pid = COALESCE(pid, job_pid),
            pgid = COALESCE(pgid, process_group_id),
            exited_at = COALESCE(exited_at, finished_at)
        WHERE state IS NULL;
      `);
    },
  },
  MIGRATION_DISPATCH_DUE_INDEX,
  MIGRATION_CANONICAL_TABLES,
  MIGRATION_RESERVED_8,
  MIGRATION_RESERVED_9,
  MIGRATION_TLDR_AGENT_MESSAGE_PAYLOADS,
  MIGRATION_TLDR_AGENT_BEACON,
];
export function pendingRuntimeMigrations(
  fromVersion,
  {
    targetVersion = CURRENT_RUNTIME_SCHEMA_VERSION,
    migrations = DEFAULT_RUNTIME_MIGRATIONS,
  } = {},
) {
  if (fromVersion > targetVersion) {
    throw new RuntimeStoreError(
      "runtime_schema_newer",
      `runtime store schema version ${fromVersion} is newer than supported version ${targetVersion}`,
      { version: fromVersion, supported_version: targetVersion },
    );
  }

  const byVersion = new Map(
    migrations.map((migration) => [migration.toVersion, migration]),
  );
  const pending = [];
  for (let version = fromVersion + 1; version <= targetVersion; version += 1) {
    const migration = byVersion.get(version);
    if (!migration) {
      throw new RuntimeStoreError(
        "runtime_migration_missing",
        `missing runtime store migration for schema version ${version}`,
        { from_version: fromVersion, target_version: targetVersion },
      );
    }
    pending.push(migration);
  }
  return pending;
}

export function applyRuntimeMigrationsToOpenDatabase(
  db,
  {
    targetVersion = CURRENT_RUNTIME_SCHEMA_VERSION,
    migrations = DEFAULT_RUNTIME_MIGRATIONS,
    now = nowIso,
  } = {},
) {
  let currentVersion = readRuntimeSchemaVersionFromDb(db);
  const applied = [];

  for (const migration of pendingRuntimeMigrations(currentVersion, {
    targetVersion,
    migrations,
  })) {
    const fromVersion = currentVersion;
    db.exec("BEGIN IMMEDIATE");
    try {
      const observedVersion = readRuntimeSchemaVersionFromDb(db);
      if (observedVersion !== fromVersion) {
        throw new RuntimeStoreError(
          "runtime_schema_changed",
          "runtime store schema version changed during migration",
          {
            expected_version: fromVersion,
            observed_version: observedVersion,
          },
        );
      }
      migration.apply(db, { fromVersion, toVersion: migration.toVersion });
      setRuntimeSchemaVersion(db, migration.toVersion, now());
      const afterVersion = readRuntimeSchemaVersionFromDb(db);
      if (afterVersion !== migration.toVersion) {
        throw new RuntimeStoreError(
          "runtime_migration_incomplete",
          "runtime migration did not advance to the expected schema version",
          {
            expected_version: migration.toVersion,
            observed_version: afterVersion,
          },
        );
      }
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Ignore rollback failures so the original migration error is preserved.
      }
      throw err;
    }

    applied.push({
      from_version: fromVersion,
      to_version: migration.toVersion,
      name: migration.name,
    });
    currentVersion = migration.toVersion;
  }

  return applied;
}

export function initializeRuntimeStore({
  home = helmHome(),
  path = runtimeStorePath(home),
  targetVersion = CURRENT_RUNTIME_SCHEMA_VERSION,
  migrations = DEFAULT_RUNTIME_MIGRATIONS,
  createBackup,
} = {}) {
  ensureRuntimeStoreHome(home);
  const sourceExists = existsSync(path);
  if (sourceExists) {
    const current = tryOpenCurrentRuntimeStore({
      path,
      targetVersion,
      openDatabaseSync,
      configureRuntimeDatabase,
      readRuntimeSchemaVersionFromDb,
      applyRuntimeStorePermissions,
      RuntimeStoreError,
    });
    if (current) return current;
  }
  const release = acquireRuntimeStoreLock(home, {
    owner: `runtime-store-init:${process.pid}`,
  });
  let db = null;
  let closed = false;

  try {
    db = openDatabaseSync(path);
    const pragmas = configureRuntimeDatabase(db);
    const version = readRuntimeSchemaVersionFromDb(db);
    if (version > targetVersion) {
      throw new RuntimeStoreError(
        "runtime_schema_newer",
        `runtime store schema version ${version} is newer than supported version ${targetVersion}`,
        { version, supported_version: targetVersion },
      );
    }

    backupRuntimeStoreUpgrade(
      home,
      path,
      sourceExists,
      version,
      targetVersion,
      createBackup,
    );
    const applied = applyRuntimeMigrationsToOpenDatabase(db, {
      targetVersion,
      migrations,
    });
    applyRuntimeStorePermissions(path);
    release();

    return {
      path,
      db,
      version: readRuntimeSchemaVersionFromDb(db),
      pragmas,
      migrations: applied,
      close() {
        if (closed) return;
        closed = true;
        db.close();
        release();
      },
    };
  } catch (err) {
    if (db) db.close();
    release();
    throw err;
  }
}

const pooledStores = new Map();

function pooledRuntimeStore({ home, path }) {
  if (process.env.HELM_RUNTIME_STORE_POOL === "0") {
    return { store: initializeRuntimeStore({ home, path }), pooled: false };
  }
  const cached = pooledStores.get(path);
  if (cached) {
    if (existsSync(path)) return { store: cached, pooled: true };
    try {
      cached.close();
    } catch {
      // already closed
    }
    pooledStores.delete(path);
  }
  const store = initializeRuntimeStore({ home, path });
  pooledStores.set(path, store);
  return { store, pooled: true };
}

export function closePooledRuntimeStores() {
  for (const store of pooledStores.values()) {
    try {
      store.close();
    } catch {
      // best-effort shutdown
    }
  }
  pooledStores.clear();
}

// Non-transactional pooled access for single-statement ledger reads/writes.
export function withRuntimeStore(
  { home = helmHome(), path = runtimeStorePath(home) } = {},
  fn,
) {
  const { store, pooled } = pooledRuntimeStore({ home, path });
  try {
    return fn(store.db);
  } finally {
    if (!pooled) store.close();
  }
}

export function withRuntimeStoreTransaction(args = {}, fn) {
  const {
    home = helmHome(),
    path = runtimeStorePath(home),
    busyTimeoutMs = null,
  } = args;
  if (typeof fn !== "function") {
    throw new TypeError("transaction callback is required");
  }
  const { store, pooled } = pooledRuntimeStore({ home, path });
  try {
    return runRuntimeStoreTransaction(store.db, fn, { busyTimeoutMs });
  } finally {
    if (!pooled) store.close();
  }
}

export function readRuntimeSchemaVersion({
  home = helmHome(),
  path = runtimeStorePath(home),
} = {}) {
  if (!existsSync(path)) return 0;
  const db = openDatabaseSync(path);
  try {
    return readRuntimeSchemaVersionFromDb(db);
  } finally {
    db.close();
  }
}

export function checkRuntimeStoreReadiness({
  home = helmHome(),
  path = runtimeStorePath(home),
  initialize = true,
  openDatabase = openDatabaseSync,
} = {}) {
  try {
    if (!existsSync(path)) {
      if (!initialize) {
        return {
          ok: false,
          code: "runtime_store_missing",
          message: "runtime store is missing",
          path,
        };
      }
      const store = initializeRuntimeStore({ home, path });
      const version = store.version;
      store.close();
      return {
        ok: true,
        path,
        version,
        supported_version: CURRENT_RUNTIME_SCHEMA_VERSION,
      };
    }

    const db = openDatabase(path);
    try {
      configureRuntimeDatabase(db);
      const version = readRuntimeSchemaVersionFromDb(db);
      if (version > CURRENT_RUNTIME_SCHEMA_VERSION) {
        const refusal = {
          ok: false,
          code: "runtime_schema_newer",
          message: `runtime store schema version ${version} is newer than supported version ${CURRENT_RUNTIME_SCHEMA_VERSION}`,
          path,
          version,
          supported_version: CURRENT_RUNTIME_SCHEMA_VERSION,
        };
        emitRuntimeStoreReadinessFailure(
          Object.assign(new Error(refusal.message), { code: refusal.code }),
          {
            supportedVersion: CURRENT_RUNTIME_SCHEMA_VERSION,
            metadata: { version },
          },
        );
        return refusal;
      }
      if (version < CURRENT_RUNTIME_SCHEMA_VERSION) {
        if (!initialize) {
          return {
            ok: false,
            code: "runtime_schema_migration_required",
            message: "runtime store schema migration is required",
            path,
            version,
            supported_version: CURRENT_RUNTIME_SCHEMA_VERSION,
          };
        }
        db.close();
        const store = initializeRuntimeStore({ home, path });
        const migratedVersion = store.version;
        store.close();
        return {
          ok: true,
          path,
          version: migratedVersion,
          supported_version: CURRENT_RUNTIME_SCHEMA_VERSION,
        };
      }
      applyRuntimeStorePermissions(path);
      return {
        ok: true,
        path,
        version,
        supported_version: CURRENT_RUNTIME_SCHEMA_VERSION,
      };
    } finally {
      try {
        db.close();
      } catch {
        // The migration branch closes before returning to avoid reopening loops.
      }
    }
  } catch (err) {
    const code = err?.code || "runtime_store_unready";
    emitRuntimeStoreReadinessFailure(err, {
      supportedVersion: CURRENT_RUNTIME_SCHEMA_VERSION,
    });
    return {
      ok: false,
      code,
      message: err?.message || "runtime store is not ready",
      path,
      ...(err?.details || {}),
    };
  }
}

export function assertRuntimeStoreReady(opts = {}) {
  const readiness = checkRuntimeStoreReadiness(opts);
  if (!readiness.ok) {
    throw new RuntimeStoreError(
      readiness.code,
      readiness.message || "runtime store is not ready",
      readiness,
    );
  }
  return readiness;
}

function normalizeDesiredMode(mode) {
  const value = String(mode || "").trim();
  if (!DESIRED_STATE_MODES.includes(value)) {
    throw new RuntimeStoreError(
      "desired_state_invalid_mode",
      `invalid desired-state mode: ${mode}`,
      { mode, supported_modes: DESIRED_STATE_MODES },
    );
  }
  return value;
}

function normalizeOutboundMode(mode) {
  const value = String(mode || "").trim();
  if (!OUTBOUND_MODES.includes(value)) {
    throw new RuntimeStoreError(
      "outbound_state_invalid_mode",
      `invalid outbound mode: ${mode}`,
      { mode, supported_modes: OUTBOUND_MODES },
    );
  }
  return value;
}

function normalizeLockout(lockout) {
  if (lockout === undefined) return undefined;
  const value = String(lockout || "").trim();
  if (!value || value === "none" || value === "clear") return null;
  return value;
}

function missingDesiredState(path, details = {}) {
  return {
    configured: false,
    ready: details.ready ?? false,
    mode: "disabled",
    lockout: null,
    lockout_active: false,
    allowed_to_start: false,
    reason: details.reason || "desired_state_missing",
    path,
    updated_at: null,
    ...(details.extra || {}),
  };
}

function desiredStateFromRow(row, path) {
  const lockout = row.lockout || null;
  const lockoutActive = Boolean(lockout);
  const mode = row.mode;
  const reason = lockoutActive
    ? "desired_state_lockout_active"
    : mode === "disabled"
      ? "desired_state_disabled"
      : "desired_state_allowed";
  return {
    configured: true,
    ready: true,
    mode,
    lockout,
    lockout_active: lockoutActive,
    allowed_to_start: mode !== "disabled" && !lockoutActive,
    reason,
    path,
    updated_at: row.updated_at,
  };
}

function missingOutboundState(path, details = {}) {
  return {
    configured: false,
    ready: details.ready ?? false,
    mode: "disabled",
    reason: details.reason || "outbound_state_missing",
    path,
    updated_at: null,
    ...(details.extra || {}),
  };
}

function outboundStateFromRow(row, path) {
  return {
    configured: true,
    ready: true,
    mode: row.mode,
    reason: "outbound_state_configured",
    path,
    updated_at: row.updated_at,
  };
}

export function readDesiredState({
  home = helmHome(),
  path = runtimeStorePath(home),
  initialize = false,
} = {}) {
  if (!existsSync(path)) {
    return missingDesiredState(path);
  }
  const readiness = checkRuntimeStoreReadiness({ home, path, initialize });
  if (!readiness.ok) {
    return missingDesiredState(path, {
      reason: readiness.code || "runtime_store_unready",
      extra: { readiness },
    });
  }

  const db = openDatabaseSync(path);
  try {
    configureRuntimeDatabase(db);
    if (!tableExists(db, "desired_state")) {
      return missingDesiredState(path, { reason: "desired_state_missing" });
    }
    const row = db.prepare("SELECT * FROM desired_state WHERE id = 1").get();
    return row
      ? desiredStateFromRow(row, path)
      : missingDesiredState(path, { ready: true });
  } finally {
    db.close();
  }
}

export function setDesiredState({
  home = helmHome(),
  path = runtimeStorePath(home),
  mode,
  lockout,
  reason = null,
  now = nowIso,
} = {}) {
  const normalizedMode = normalizeDesiredMode(mode);
  const normalizedLockout = normalizeLockout(lockout);
  const store = initializeRuntimeStore({ home, path });
  try {
    store.db
      .prepare(
        `
          INSERT INTO desired_state (id, mode, lockout, reason, updated_at)
          VALUES (1, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            mode = excluded.mode,
            lockout = excluded.lockout,
            reason = excluded.reason,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        normalizedMode,
        normalizedLockout === undefined ? null : normalizedLockout,
        reason,
        now(),
      );
  } finally {
    store.close();
  }
  const state = readDesiredState({ home, path, initialize: false });
  emitSafetyEvent({
    type: state.allowed_to_start
      ? "desired_state_updated"
      : "desired_state_lockout",
    subsystem: "desired_state",
    status: state.allowed_to_start ? "allowed" : "blocked",
    errorClass: state.allowed_to_start ? null : state.reason,
    metadata: {
      mode: state.mode,
      lockout: state.lockout,
      reason: state.reason,
      configured: state.configured,
    },
    eventHome: home,
  });
  return state;
}
export function assertDesiredStateAllowsStart(opts = {}) {
  const desiredState = readDesiredState(opts);
  if (!desiredState.allowed_to_start) {
    throw new RuntimeStoreError(
      "desired_state_blocked",
      "desired state blocks scheduler start or dispatch",
      { desired_state: desiredState },
    );
  }
  return desiredState;
}

export function readOutboundState({
  home = helmHome(),
  path = runtimeStorePath(home),
  initialize = false,
} = {}) {
  if (!existsSync(path)) {
    return missingOutboundState(path);
  }
  const readiness = checkRuntimeStoreReadiness({ home, path, initialize });
  if (!readiness.ok) {
    return missingOutboundState(path, {
      reason: readiness.code || "runtime_store_unready",
      extra: { readiness },
    });
  }

  const db = openDatabaseSync(path);
  try {
    configureRuntimeDatabase(db);
    if (!tableExists(db, "outbound_state")) {
      return missingOutboundState(path, { reason: "outbound_state_missing" });
    }
    const row = db.prepare("SELECT * FROM outbound_state WHERE id = 1").get();
    return row
      ? outboundStateFromRow(row, path)
      : missingOutboundState(path, { ready: true });
  } finally {
    db.close();
  }
}

export function setOutboundMode({
  home = helmHome(),
  path = runtimeStorePath(home),
  mode,
  now = nowIso,
} = {}) {
  const normalizedMode = normalizeOutboundMode(mode);
  const store = initializeRuntimeStore({ home, path });
  try {
    store.db
      .prepare(
        `
          INSERT INTO outbound_state (id, mode, updated_at)
          VALUES (1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            mode = excluded.mode,
            updated_at = excluded.updated_at
        `,
      )
      .run(normalizedMode, now());
  } finally {
    store.close();
  }
  return readOutboundState({ home, path, initialize: false });
}
