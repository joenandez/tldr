import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { helmHome } from "./store.mjs";
import {
  CURRENT_RUNTIME_SCHEMA_VERSION,
  DEFAULT_RUNTIME_MIGRATIONS,
  RuntimeStoreError,
  acquireRuntimeStoreLock,
  applyRuntimeMigrationsToOpenDatabase,
  configureRuntimeDatabase,
  ensureRuntimeStoreHome,
  pendingRuntimeMigrations,
  readRuntimeSchemaVersionFromDb,
  runtimeStoreBackupRoot,
  runtimeStoreLockPath,
  runtimeStorePath,
} from "./runtime_store.mjs";
import {
  applyOwnerOnlyPermissions,
  applyRuntimeStorePermissions,
} from "./runtime_store_permissions.mjs";
import { emitSafetyEvent } from "./safety_events.mjs";

export { runtimeStoreBackupRoot, runtimeStoreLockPath };

function posixModesSupported() {
  return process.platform !== "win32";
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function timestampForFile() {
  return new Date().toISOString().replace(/[^0-9]/g, "");
}

function copyIfExists(from, to) {
  if (!existsSync(from)) return null;
  copyFileSync(from, to);
  applyOwnerOnlyPermissions(to);
  return to;
}

function copyRuntimeDatabaseSnapshot(sourcePath, targetPath) {
  mkdirSync(dirname(targetPath), { recursive: true });
  const copied = [];
  const main = copyIfExists(sourcePath, targetPath);
  if (main) copied.push(main);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = copyIfExists(
      `${sourcePath}${suffix}`,
      `${targetPath}${suffix}`,
    );
    if (sidecar) copied.push(sidecar);
  }
  return copied;
}

function createRuntimeStoreBackup({
  home,
  sourcePath,
  fromVersion,
  toVersion,
}) {
  if (!existsSync(sourcePath)) return null;
  const root = runtimeStoreBackupRoot(home);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (posixModesSupported()) chmodSync(root, 0o700);

  const backupPath = join(
    root,
    `runtime.sqlite.v${fromVersion}-to-v${toVersion}.${timestampForFile()}.bak`,
  );
  const files = copyRuntimeDatabaseSnapshot(sourcePath, backupPath);
  if (files.length === 0) return null;
  return {
    path: backupPath,
    from_version: fromVersion,
    to_version: toVersion,
    files,
  };
}

function normalizeMigrationError(err) {
  if (err instanceof RuntimeStoreError) return err;
  return new RuntimeStoreError(
    err?.code || "runtime_migration_failed",
    err?.message || "runtime migration failed",
  );
}

export function runRuntimeMigrations({
  home = helmHome(),
  path = runtimeStorePath(home),
  dryRun = false,
  targetVersion = CURRENT_RUNTIME_SCHEMA_VERSION,
  migrations = DEFAULT_RUNTIME_MIGRATIONS,
} = {}) {
  let release = null;
  let tempRoot = null;
  let db = null;

  try {
    ensureRuntimeStoreHome(home);
    release = acquireRuntimeStoreLock(home, {
      owner: `runtime-migrate:${process.pid}`,
    });
    const sourceExists = existsSync(path);
    const beforeHash = sourceExists ? sha256(path) : null;
    tempRoot = dryRun
      ? mkdtempSync(join(tmpdir(), "helm-runtime-migrate-"))
      : null;
    const workPath = dryRun ? join(tempRoot, "runtime.sqlite") : path;

    if (dryRun && sourceExists) {
      copyRuntimeDatabaseSnapshot(path, workPath);
    }
    if (dryRun && !sourceExists) {
      mkdirSync(dirname(workPath), { recursive: true });
    }

    db = new DatabaseSync(workPath);
    configureRuntimeDatabase(db);
    const fromVersion = readRuntimeSchemaVersionFromDb(db);
    const backups = [];
    let applied = [];

    if (fromVersion > targetVersion) {
      throw new RuntimeStoreError(
        "runtime_schema_newer",
        `runtime store schema version ${fromVersion} is newer than supported version ${targetVersion}`,
        { version: fromVersion, supported_version: targetVersion },
      );
    }

    if (dryRun) {
      applied = applyRuntimeMigrationsToOpenDatabase(db, {
        targetVersion,
        migrations,
      });
    } else {
      let currentVersion = fromVersion;
      for (const migration of pendingRuntimeMigrations(currentVersion, {
        targetVersion,
        migrations,
      })) {
        const backup = createRuntimeStoreBackup({
          home,
          sourcePath: path,
          fromVersion: currentVersion,
          toVersion: migration.toVersion,
        });
        if (backup) backups.push(backup);
        const [step] = applyRuntimeMigrationsToOpenDatabase(db, {
          targetVersion: migration.toVersion,
          migrations: [migration],
        });
        if (step) applied.push(step);
        currentVersion = migration.toVersion;
      }
    }

    const toVersion = readRuntimeSchemaVersionFromDb(db);
    applyRuntimeStorePermissions(workPath);
    db.close();
    db = null;

    const sourceUnchanged =
      !dryRun || !sourceExists ? true : beforeHash === sha256(path);

    const result = {
      dry_run: Boolean(dryRun),
      path,
      from_version: fromVersion,
      to_version: toVersion,
      target_version: targetVersion,
      migrations: applied,
      backups,
      source_unchanged: sourceUnchanged,
    };
    emitSafetyEvent({
      type: "runtime_migration_completed",
      subsystem: "runtime_migration",
      status: "success",
      metadata: {
        dry_run: result.dry_run,
        from_version: result.from_version,
        to_version: result.to_version,
        target_version: result.target_version,
        migrations: result.migrations.map((migration) => ({
          from_version: migration.from_version,
          to_version: migration.to_version,
          name: migration.name,
        })),
        backup_count: result.backups.length,
        source_unchanged: result.source_unchanged,
      },
    });
    return result;
  } catch (err) {
    const normalized = normalizeMigrationError(err);
    emitSafetyEvent({
      type: "runtime_migration_failed",
      subsystem: "runtime_migration",
      status: "failure",
      errorClass: normalized.code,
      metadata: {
        dry_run: Boolean(dryRun),
        target_version: targetVersion,
        code: normalized.code,
      },
    });
    throw normalized;
  } finally {
    if (db) db.close();
    release?.();
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  }
}
