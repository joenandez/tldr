#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { reconcileBeaconStopIndex } from "../../src/lib/tldr_agent_beacon_stop_index.mjs";

const BEACON_SCHEMA_VERSION = 11;
const SQLITE_CANTOPEN = 14;

export const BEACON_PENDING_SQL = `
  SELECT 1
  FROM tldr_agent_beacon_obligations
    INDEXED BY idx_beacon_session_unresolved
  WHERE owner_session_id = ? AND status = ?
  LIMIT 1
`;

function schemaObjectExists(db, type, name) {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM sqlite_schema
         WHERE type = ? AND name = ?
         LIMIT 1`,
      )
      .get(type, name),
  );
}

export function inspectBeaconStopPreflight({
  path,
  sessionId,
  openDatabase = (databasePath, options) =>
    new DatabaseSync(databasePath, options),
}) {
  let db;
  try {
    try {
      db = openDatabase(path, { readOnly: true });
    } catch (error) {
      if (error?.errcode !== SQLITE_CANTOPEN) throw error;
      db = openDatabase(path, { readOnly: false });
    }
    const schemaVersion = Number(
      db.prepare("PRAGMA user_version").get().user_version,
    );
    const tableExists = schemaObjectExists(
      db,
      "table",
      "tldr_agent_beacon_obligations",
    );
    if (!tableExists) {
      return schemaVersion < BEACON_SCHEMA_VERSION
        ? { state: "absent", reason: "pre_beacon_schema" }
        : { state: "error", reason: "current_schema_table_missing" };
    }
    if (!schemaObjectExists(db, "index", "idx_beacon_session_unresolved")) {
      return { state: "error", reason: "current_schema_index_missing" };
    }
    const pending = db.prepare(BEACON_PENDING_SQL).get(sessionId, "pending");
    return pending
      ? { state: "pending" }
      : { state: "absent", reason: "no_pending_marker" };
  } catch {
    return { state: "error", reason: "runtime_store_unreadable" };
  } finally {
    db?.close();
  }
}

function main() {
  const [path, sessionId, sessionsRoot] = process.argv.slice(2);
  if (!path || !sessionId) return 11;
  const result = inspectBeaconStopPreflight({ path, sessionId });
  if (result.state === "error") return 11;
  try {
    const reconciled = reconcileBeaconStopIndex({
      path,
      sessionsRoot,
      pendingRows: result.reason === "pre_beacon_schema" ? [] : undefined,
    });
    return reconciled.pendingSessionIds.includes(sessionId) ? 10 : 0;
  } catch {
    return 11;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = main();
}
