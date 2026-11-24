// never-wait busy-line sweep (busy_line.mjs): range reads past its low-water mark and joins
// deliveries by message, so no full scans. Performance only, so deliberately not a schema
// version: a rolled-back schema-30 daemon must still open this database.
// Returns `version` so openSchema can return the migrated schema version through it.
export function ensurePerformanceIndexes(db, version) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS messages_routed_inbound_created ON messages(created_at, id) WHERE origin = 'inbound' AND origin_channel_route_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS messages_agent_created ON messages(created_at) WHERE origin = 'agent';
    CREATE INDEX IF NOT EXISTS messages_conversation_origin ON messages(conversation_id, origin, created_at);
    CREATE INDEX IF NOT EXISTS deliveries_message ON deliveries(message_id);
    CREATE INDEX IF NOT EXISTS resume_requests_message ON resume_requests(message_id)`);
  ensureHostBindings(db);
  return version;
}

// Append-only history of every host an endpoint was ever bound to; host.message.lookup
// authorizes through it because a headless resume clears endpoints.host_name (wake routing
// needs that). Deliberately not a schema version, for the same rollback reason as above.
// Triggers record every write of a non-NULL host_name, and the backfill re-seeds from the
// current binding on every start (idempotent), so no registration site can miss one.
function ensureHostBindings(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS endpoint_host_bindings (
      endpoint_id TEXT NOT NULL REFERENCES endpoints(id),
      host_name TEXT NOT NULL,
      first_bound_at TEXT NOT NULL,
      PRIMARY KEY (endpoint_id, host_name)
    );
    CREATE INDEX IF NOT EXISTS endpoint_host_bindings_host ON endpoint_host_bindings(host_name);
    CREATE TRIGGER IF NOT EXISTS endpoint_host_bindings_insert AFTER INSERT ON endpoints WHEN NEW.host_name IS NOT NULL
    BEGIN
      INSERT OR IGNORE INTO endpoint_host_bindings (endpoint_id, host_name, first_bound_at)
        VALUES (NEW.id, NEW.host_name, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    END;
    CREATE TRIGGER IF NOT EXISTS endpoint_host_bindings_update AFTER UPDATE OF host_name ON endpoints WHEN NEW.host_name IS NOT NULL
    BEGIN
      INSERT OR IGNORE INTO endpoint_host_bindings (endpoint_id, host_name, first_bound_at)
        VALUES (NEW.id, NEW.host_name, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    END;
    INSERT OR IGNORE INTO endpoint_host_bindings (endpoint_id, host_name, first_bound_at)
      SELECT id, host_name, updated_at FROM endpoints WHERE host_name IS NOT NULL`);
}
