function pragmaValue(db, sql) {
  const row = db.prepare(sql).get();
  return row ? row[Object.keys(row)[0]] : null;
}

export function runRuntimeStoreTransaction(
  db,
  fn,
  { busyTimeoutMs = null } = {},
) {
  const boundedBusyTimeout = Number.isFinite(busyTimeoutMs)
    ? Math.max(0, Math.floor(busyTimeoutMs))
    : null;
  const priorBusyTimeout =
    boundedBusyTimeout === null
      ? null
      : Number(pragmaValue(db, "PRAGMA busy_timeout"));
  try {
    if (boundedBusyTimeout !== null) {
      db.exec(`PRAGMA busy_timeout = ${boundedBusyTimeout}`);
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn(db);
      db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original transaction failure.
      }
      throw err;
    }
  } finally {
    if (priorBusyTimeout !== null) {
      db.exec(`PRAGMA busy_timeout = ${priorBusyTimeout}`);
    }
  }
}
