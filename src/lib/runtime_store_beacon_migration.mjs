const BEACON_TABLE = "tldr_agent_beacon_obligations";
const BEACON_INDEX = "idx_beacon_session_unresolved";

const BEACON_TABLE_SQL = `
  CREATE TABLE tldr_agent_beacon_obligations (
    obligation_id             TEXT PRIMARY KEY,
    scope_id                  TEXT NOT NULL,
    owner_session_id          TEXT NOT NULL,
    registration_key          TEXT NOT NULL,
    origin_thread_id          TEXT,
    bound_thread_id           TEXT NOT NULL,
    confirmation_message_id   TEXT NOT NULL UNIQUE,
    terminal_message_id       TEXT UNIQUE,
    terminal_outcome          TEXT
      CHECK (terminal_outcome IS NULL OR terminal_outcome IN
        ('success', 'failure', 'blocked')),
    status                    TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'fulfilled', 'cancelled')),
    cancellation_reason       TEXT,
    cancellation_source_ref   TEXT,
    stop_block_count          INTEGER NOT NULL DEFAULT 0
      CHECK (stop_block_count BETWEEN 0 AND 3),
    created_at                TEXT NOT NULL,
    resolved_at               TEXT,

    UNIQUE (scope_id, owner_session_id, registration_key),
    CHECK (origin_thread_id IS NULL OR origin_thread_id = bound_thread_id),
    CHECK ((status = 'pending' AND resolved_at IS NULL)
        OR (status IN ('fulfilled', 'cancelled') AND resolved_at IS NOT NULL)),
    CHECK ((status = 'fulfilled' AND terminal_message_id IS NOT NULL
            AND terminal_outcome IS NOT NULL)
        OR status <> 'fulfilled'),
    CHECK ((status = 'cancelled' AND cancellation_reason IS NOT NULL
            AND cancellation_source_ref IS NOT NULL)
        OR status <> 'cancelled')
  )
`;

const BEACON_INDEX_SQL = `
  CREATE INDEX idx_beacon_session_unresolved
    ON tldr_agent_beacon_obligations
      (owner_session_id, status, created_at)
`;

function schemaObject(db, type, name) {
  return db
    .prepare(
      `SELECT sql FROM sqlite_schema
       WHERE type = ? AND name = ?
       LIMIT 1`,
    )
    .get(type, name);
}

function columnExists(db, table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column);
}

function normalizeSchemaSql(sql) {
  return String(sql || "")
    .trim()
    .replace(/;$/, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function incompatibleLegacySchema(reason) {
  const error = new Error(
    `legacy Beacon v10 schema is incompatible with v11: ${reason}`,
  );
  error.code = "runtime_legacy_schema_incompatible";
  return error;
}

function assertCanonicalBeaconSchema(db) {
  const table = schemaObject(db, "table", BEACON_TABLE);
  const index = schemaObject(db, "index", BEACON_INDEX);
  if (!table || !index) {
    throw incompatibleLegacySchema("marker table or unresolved index missing");
  }
  if (
    normalizeSchemaSql(table.sql) !== normalizeSchemaSql(BEACON_TABLE_SQL) ||
    normalizeSchemaSql(index.sql) !== normalizeSchemaSql(BEACON_INDEX_SQL)
  ) {
    throw incompatibleLegacySchema("marker table or index definition differs");
  }
}

function createBeaconSchema(db) {
  db.exec(`${BEACON_TABLE_SQL};\n${BEACON_INDEX_SQL};`);
}

export const MIGRATION_TLDR_AGENT_BEACON = {
  toVersion: 11,
  name: "tldr; Beacon obligations",
  apply(db) {
    const table = schemaObject(db, "table", BEACON_TABLE);
    const index = schemaObject(db, "index", BEACON_INDEX);
    const payloadExists = columnExists(
      db,
      "canonical_message_index",
      "payload",
    );

    if (table || index) {
      assertCanonicalBeaconSchema(db);
      if (!payloadExists) {
        db.exec("ALTER TABLE canonical_message_index ADD COLUMN payload TEXT;");
      }
      return;
    }

    if (!payloadExists) {
      throw incompatibleLegacySchema(
        "canonical payload column and legacy Beacon schema are both absent",
      );
    }
    createBeaconSchema(db);
  },
};

export const _internals = {
  BEACON_TABLE_SQL,
  BEACON_INDEX_SQL,
  assertCanonicalBeaconSchema,
  createBeaconSchema,
  normalizeSchemaSql,
};
