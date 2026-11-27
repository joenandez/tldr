import { withTransaction } from "./db.mjs";

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
    CREATE INDEX IF NOT EXISTS deliveries_unread_created ON deliveries(created_at, message_id) WHERE read_at IS NULL AND state != 'failed' AND created_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS resume_requests_message ON resume_requests(message_id);
    CREATE INDEX IF NOT EXISTS obligations_parent ON obligations(parent_id);
    CREATE INDEX IF NOT EXISTS obligations_custodian ON obligations(custodian_endpoint_id);
    CREATE INDEX IF NOT EXISTS resume_requests_conversation ON resume_requests(conversation_id);
    CREATE INDEX IF NOT EXISTS resume_requests_replacement ON resume_requests(replacement_endpoint_id);
    CREATE INDEX IF NOT EXISTS reply_bindings_conversation ON reply_bindings(conversation_id);
    CREATE INDEX IF NOT EXISTS message_effects_handoff_offer ON message_effects(effect) WHERE effect = 'handoff.offer';
    -- A delivery's latest claim (delivery.claim's offer order) is a seek, not a scan of claim history.
    CREATE INDEX IF NOT EXISTS claims_resource_latest ON claims(resource_type, resource_id, id);
    -- The channel-copy sweep and route retire (channel_copy_sweep.mjs) read only unfinished channel copies (ac-uc6tr).
    CREATE INDEX IF NOT EXISTS deliveries_channel_open ON deliveries(created_at) WHERE channel_route_id IS NOT NULL AND state IN ('pending', 'claimed') AND read_at IS NULL;
    -- Owner-process reconciliation, every listener pass: each WHERE repeats its query's own terms
    -- (WATCHED_ENDPOINTS, BUSY_OVER_EXITED_OWNER, REVIVED_IDLE_ENDPOINTS) so the pass reads a few
    -- rows instead of every endpoint (ac-srg29.3).
    CREATE INDEX IF NOT EXISTS endpoints_owner_unexited ON endpoints(state) WHERE owner_process_pid IS NOT NULL AND owner_process_exited_at IS NULL;
    CREATE INDEX IF NOT EXISTS endpoints_owner_exited_busy ON endpoints(state) WHERE state = 'busy' AND owner_process_pid IS NOT NULL AND owner_process_exited_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS endpoints_owner_exited_revivable ON endpoints(state) WHERE state = 'idle' AND launch_mode IS NOT 'non_interactive' AND owner_process_pid IS NOT NULL AND owner_process_exited_at IS NOT NULL`);
  ensureSenderEndpointIndex(db);
  ensureHostBindings(db);
  return version;
}

// thread.list, lifecycle.view and routing read obligation chains by parent, resume requests
// by conversation and lineage, reply bindings by conversation, and effects by their declared
// sender, once per listed thread; without these each read full-scanned its table (ac-dsts3).
// json_extract raises on malformed JSON, so an index on it would refuse every later write of
// such a row and fail startup on one already stored. The one writer stores JSON.stringify
// output, so it is built only when every stored payload parses; a database holding a bad row
// keeps the scan it has today rather than failing to open.
function ensureSenderEndpointIndex(db) {
  if (
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'message_effects_sender_endpoint'",
      )
      .get()
  )
    return;
  if (
    db
      .prepare(
        "SELECT 1 FROM message_effects WHERE NOT json_valid(effect_payload) LIMIT 1",
      )
      .get()
  )
    return;
  db.exec(
    "CREATE INDEX message_effects_sender_endpoint ON message_effects(json_extract(effect_payload, '$.declaration.sender_endpoint_id'))",
  );
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

// claims.limit_refused_at: when a usage limit refused this claim's launch
// (ac-jfv.165). NULL: never refused by one. Additive and nullable, so like the
// indexes above it is deliberately not a schema version: a rolled-back
// schema-30 daemon still opens the database and ignores the column. It lives
// on claims, which a state export leaves behind (NON_EXPORTED_TABLES), so the
// export format does not change; an imported wake starts a fresh window.
export function ensureLimitRefusedColumn(db, version) {
  if (
    !db
      .prepare("PRAGMA table_info(claims)")
      .all()
      .some((c) => c.name === "limit_refused_at")
  )
    db.exec("ALTER TABLE claims ADD COLUMN limit_refused_at TEXT");
  // Only limit-refused claims: the first-refusal lookup never scans claims.
  db.exec(
    "CREATE INDEX IF NOT EXISTS claims_limit_refused ON claims(resource_id, limit_refused_at) WHERE limit_refused_at IS NOT NULL",
  );
  return version;
}

// ac-4p2j0 catch-all (holder_stall.mjs): its sweeps seek open work by age and
// attempts by root, never scanning obligation history. The watermark row is
// written once, by the first daemon that opens this database with the
// catch-all: work that went quiet before it is install backlog and is never
// noticed one by one. Additive, so not a schema version either. The parent index has its own
// name: ensurePerformanceIndexes' obligations_parent(parent_id) (ac-dsts3) is a different index.
export function ensureHolderStallIndexes(db, version) {
  // Pre-#91 branch builds named our index obligations_parent; give the name back to #91's.
  // Check and repair hold one write lock, so a second opener cannot run between them.
  withTransaction(db, () => {
    const legacy =
      db
        .prepare(
          "SELECT count(*) AS n FROM pragma_index_info('obligations_parent')",
        )
        .get().n > 1;
    if (legacy)
      db.exec(
        "DROP INDEX obligations_parent; CREATE INDEX obligations_parent ON obligations(parent_id)",
      );
  });
  db.exec(`
    CREATE INDEX IF NOT EXISTS obligations_parent_role_generation ON obligations(parent_id, role, generation);
    CREATE INDEX IF NOT EXISTS obligations_open_leaf_updated ON obligations(updated_at, id) WHERE status = 'open' AND role IN ('attempt', 'delegation');
    CREATE INDEX IF NOT EXISTS obligations_open_root_updated ON obligations(updated_at, id) WHERE status = 'open' AND role = 'root';
    CREATE TABLE IF NOT EXISTS holder_stall_watermark (id INTEGER PRIMARY KEY CHECK (id = 1), installed_at TEXT NOT NULL)`);
  db.prepare(
    "INSERT OR IGNORE INTO holder_stall_watermark (id, installed_at) VALUES (1, ?)",
  ).run(new Date().toISOString());
  return version;
}

// conversations.starter_owner_endpoint_id / target_owner_endpoint_id: the session that owns each
// side of a thread (ac-32qki), written only at thread start and when the thread is passed
// (ops/thread_owners.mjs). NULL for a user side and on every thread that predates them. Additive and
// nullable, so like the indexes above it is deliberately not a schema version: a rolled-back
// schema-30 daemon still opens the database and ignores the columns (its state.export drift check
// would refuse until it is upgraded again).
// Every change to a thread's obligations marks the conversation in thread_owner_dirty (only when it
// has an owner, so an unowned thread never touches it); withTransaction settles the marked
// conversations once, before COMMIT, so a cascade of closes is read as its final state.
export function ensureThreadOwners(db, version) {
  const have = new Set(
    db
      .prepare("PRAGMA table_info(conversations)")
      .all()
      .map((c) => c.name),
  );
  for (const column of [
    "starter_owner_endpoint_id",
    "target_owner_endpoint_id",
  ])
    if (!have.has(column))
      db.exec(`ALTER TABLE conversations ADD COLUMN ${column} TEXT`);
  const mark = (event) => `
    CREATE TRIGGER IF NOT EXISTS obligations_owner_dirty_${event.split(" ")[0].toLowerCase()}
    AFTER ${event} ON obligations
    WHEN (SELECT starter_owner_endpoint_id IS NOT NULL OR target_owner_endpoint_id IS NOT NULL FROM conversations WHERE id = NEW.conversation_id)
    BEGIN INSERT OR IGNORE INTO thread_owner_dirty (conversation_id) VALUES (NEW.conversation_id); END;`;
  db.exec(`
    DROP TRIGGER IF EXISTS obligations_delegation_end_returns_owner;
    CREATE TABLE IF NOT EXISTS thread_owner_dirty (conversation_id TEXT PRIMARY KEY);
    ${mark("INSERT")}${mark("UPDATE OF status, custodian_endpoint_id")}`);
  db.threadOwnersReady = true;
  return version;
}
