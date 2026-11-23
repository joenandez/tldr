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
  return version;
}
