import { createRequire } from "node:module";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { applyOwnerOnlyPermissions } from "./runtime_store_permissions.mjs";

const require = createRequire(import.meta.url);
let DatabaseSyncClass = null;

function openDatabaseSync(path, options) {
  if (!DatabaseSyncClass) {
    ({ DatabaseSync: DatabaseSyncClass } = require("node:sqlite"));
  }
  return new DatabaseSyncClass(path, options);
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

export function copyRuntimeDatabaseSnapshot(sourcePath, targetPath) {
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

function tableExists(db, name) {
  return Boolean(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name),
  );
}

function schemaVersion(db) {
  if (tableExists(db, "runtime_schema")) {
    return db.prepare("SELECT version FROM runtime_schema WHERE id = 1").get()
      ?.version;
  }
  return Number(db.prepare("PRAGMA user_version").get().user_version || 0);
}

function backupVerificationError(message) {
  const error = new Error(message);
  error.code = "runtime_migration_backup_invalid";
  return error;
}

export function verifyRuntimeStoreBackup(path, expectedVersion) {
  const db = openDatabaseSync(path, { readOnly: true });
  try {
    if (schemaVersion(db) !== expectedVersion) {
      throw backupVerificationError(
        `runtime store backup schema version does not match v${expectedVersion}`,
      );
    }
    const quickCheck = Object.values(db.prepare("PRAGMA quick_check").get())[0];
    if (quickCheck !== "ok") {
      throw backupVerificationError(
        "runtime store backup integrity check failed",
      );
    }
  } finally {
    db.close();
  }
}

export function createRuntimeStoreBackup({
  home,
  sourcePath,
  fromVersion,
  toVersion,
  verifyBackup = verifyRuntimeStoreBackup,
}) {
  if (!existsSync(sourcePath)) return null;
  const root = join(home, "backups", "runtime-store");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(root, 0o700);

  const backupPath = join(
    root,
    `runtime.sqlite.v${fromVersion}-to-v${toVersion}.${timestampForFile()}.bak`,
  );
  const files = copyRuntimeDatabaseSnapshot(sourcePath, backupPath);
  if (files.length === 0) {
    throw backupVerificationError("runtime store backup was not created");
  }
  try {
    verifyBackup(backupPath, fromVersion);
  } catch (error) {
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${backupPath}${suffix}`, { force: true });
    }
    throw error;
  }
  return {
    path: backupPath,
    from_version: fromVersion,
    to_version: toVersion,
    files,
  };
}

export function backupRuntimeStoreUpgrade(
  home,
  sourcePath,
  sourceExists,
  fromVersion,
  toVersion,
  createBackup = createRuntimeStoreBackup,
) {
  if (!sourceExists || fromVersion >= toVersion) return null;
  return createBackup({
    home,
    sourcePath,
    fromVersion,
    toVersion,
  });
}
