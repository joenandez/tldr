export function tryOpenCurrentRuntimeStore({
  path,
  targetVersion,
  openDatabaseSync,
  configureRuntimeDatabase,
  readRuntimeSchemaVersionFromDb,
  applyRuntimeStorePermissions,
  RuntimeStoreError,
}) {
  let db = null;
  try {
    db = openDatabaseSync(path);
    const pragmas = configureRuntimeDatabase(db);
    const version = readRuntimeSchemaVersionFromDb(db);
    if (version === targetVersion) {
      applyRuntimeStorePermissions(path);
      let closed = false;
      return {
        path,
        db,
        version,
        pragmas,
        migrations: [],
        close() {
          if (closed) return;
          closed = true;
          db.close();
        },
      };
    }
    if (version > targetVersion) {
      throw new RuntimeStoreError(
        "runtime_schema_newer",
        `runtime store schema version ${version} is newer than supported version ${targetVersion}`,
        { version, supported_version: targetVersion },
      );
    }
  } catch (err) {
    db?.close();
    throw err;
  }
  db.close();
  return null;
}
