// The daemon's schema, expressed as an ordered migration list.
//
// v1: the full table set from the state ownership contract, created up front so
// later workstreams add operations without schema churn. Structural
// invariants (unique / partial-unique indexes, immutability groundwork)
// are created there even though most operations against those tables land
// in later workstreams.
//
// v2: session ownership — the endpoints state enum and runtime axis, the
// Beacon promise columns on obligations, and the resume_requests reason
// rename. See the V2 block below.
//
// v3: obligation trees — managed attempts and delegations are promise
// children of the implicit reply root, without adding a second lifecycle
// state machine. See the V3 block below.
//
// v7: message author-origin axis. `messages.origin` ('agent' | 'inbound')
// records which grant authorized the write — scoped send_as_principal
// (agent) vs bare publish_inbound_messages (a channel bridge injecting a
// verified external reply). Additive with a NOT NULL DEFAULT 'agent', so
// every pre-v7 row reads agent deterministically; the in-column CHECK
// fails closed on any other value at every write site, state.import
// included.
//
// v8: the guarded lifecycle cutover (Project Relay parent 1.1). While any
// legacy obligation row is open, activation refuses outright; once none
// is open, `obligations` is rebuilt EMPTY as the forward
// role/generation/resolution graph (no historical row conversion),
// `message_effects` and `handoff_watches` land as new foreign-keyed
// tables, and endpoints gain `process_generation`, deliveries typed
// route fields.
//
// v9: the lifecycle command ledger (Project Relay parent 2.3). Recovery
// commands are administrative transitions that write NO message row, so —
// unlike message.commit — their idempotency identity cannot ride the
// messages table. `lifecycle_commands` binds each (app, operation,
// idempotency_key) to a canonical payload hash and the exact result it
// produced: identical replay reconstructs the original admission, any
// changed field collides, and the UNIQUE index arbitrates concurrent
// competing commands inside the admitting transaction.
//
// v10: session.stop joins the ledger, and root attention evidence lands
// (Project Relay parent 3.2). The Stop command is administrative like
// recovery — no message row — so its replay identity rides the same
// ledger: v10 rebuilds it to admit the 'session.stop' operation and relax
// root_obligation_id to nullable, because a Stop is fenced by endpoint
// identity, not rooted at one obligation. The bounded Stop-block escape
// (STOP-BLOCK-UNOWNED, INV-18) needs durable evidence that survives
// restarts and replays: one `root_attention` row per blocked root carries
// both facts the contract names — work left open AND made visible — plus
// the anti-wedge counter the replay rule pins ("never increments
// stop_block_count twice"; wave 4's clearRootAttention clears exactly this
// row).
//
// v11: the launch-collision discriminator on endpoints (Project Relay
// parent 4.1 repair). Process generation alone cannot separate two
// supervised launches of one endpoint made before either registered: both
// launches legitimately capture the SAME predicted next generation
// (COALESCE(recorded, 0) + 1), so a zombie sibling's late exit passes the
// generation-equality fence against whichever sibling stamped it and
// destroys live custody mid-turn. `endpoints.owner_epoch` counts
// ownership regimes instead: it advances inside every stamping seam where
// process_generation advances (first stamp, placeholder adoption,
// revive-from-dead), a replay against a live row moves neither, and a
// NULL-generation row still has one. Launch-time captures record the
// CURRENT epoch, so death evidence naming a pre-registration epoch is
// provably not the registered custodian's and fences inert beside the
// generation rule.
//
// v12: the per-launch ownership token (Project Relay parent 4.1, the
// launch-collision repair completed). The v10 epoch fences a zombie
// sibling, but it fences the WINNING launch's own later exit too: both
// siblings captured the pre-registration epoch, so the launch that went
// on to register cannot name the epoch its own registration produced, and
// its real death would strand the custody it owned open forever.
// `endpoints.owner_launch_token` records WHICH launch owns the current
// regime: the resumer mints one token per launch and hands it to the
// child, the child's registration stamps that exact token on the row it
// takes ownership of, and supervised evidence must name the stamped
// token. A losing sibling's token never matches; the winner's always
// does.
//
// v13: durable, non-secret channel route descriptors. A route binds an
// existing application's principal and endpoint to a stable selector;
// availability stays derived from those existing records. Messages and
// deliveries retain nullable route attribution rather than creating a
// second delivery or health lifecycle.

import { applyMigrations, listAppliedMigrations } from './migrations.mjs';
import { reconcileTachyonArmingFromAudit } from './tachyon_arming.mjs';

export const SCHEMA_VERSION = 25;

// The schema version at which the guarded lifecycle cutover landed. A
// state document stamped below this version was written by a pre-cutover
// daemon whose obligations carry the legacy lifecycle columns; it is an
// archive/whole-root rollback artifact only and is never an importer
// input for the forward graph (plan «Migration Plan — Forward state
// portability»).
export const LIFECYCLE_CUTOVER_SCHEMA_VERSION = 8;

const CREATE_STATEMENTS = [
  // 1. Application (the state ownership contract §1)
  `CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    secret_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    disabled_at TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_name ON applications(name)`,
  `CREATE TABLE IF NOT EXISTS application_permissions (
    app_id TEXT NOT NULL REFERENCES applications(id),
    permission TEXT NOT NULL,
    allowed_authorities TEXT,
    allowed_runtime_types TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_application_permissions_app_permission
    ON application_permissions(app_id, permission)`,

  // Authorities (referenced by principals.authority_name / endpoints.authority_name;
  // created by the admin-only authority.register operation)
  `CREATE TABLE IF NOT EXISTS authorities (
    name TEXT PRIMARY KEY,
    description TEXT,
    created_at TEXT NOT NULL
  )`,

  // 2. Principal (the state ownership contract §2)
  `CREATE TABLE IF NOT EXISTS principals (
    id TEXT PRIMARY KEY,
    authority_name TEXT NOT NULL,
    external_principal_ref TEXT,
    display_name TEXT,
    created_by_app_id TEXT NOT NULL REFERENCES applications(id),
    created_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_principals_authority_external_ref
    ON principals(authority_name, external_principal_ref)
    WHERE external_principal_ref IS NOT NULL`,

  // 3. Endpoint (the state ownership contract §3)
  `CREATE TABLE IF NOT EXISTS endpoints (
    id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL REFERENCES principals(id),
    authority_name TEXT NOT NULL,
    provider_session_id TEXT,
    state TEXT NOT NULL,
    authority_reference TEXT,
    created_by_app_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_endpoints_authority_provider_session
    ON endpoints(authority_name, provider_session_id)
    WHERE provider_session_id IS NOT NULL`,

  // 4. Conversation (the state ownership contract §4)
  `CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    created_by_app_id TEXT NOT NULL,
    binding_kind TEXT NOT NULL,
    owner_principal_id TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL,
    closed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS conversation_participants (
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    principal_id TEXT NOT NULL REFERENCES principals(id),
    role TEXT,
    added_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_participants_pair
    ON conversation_participants(conversation_id, principal_id)`,

  // 5. Message (the state ownership contract §5)
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    app_id TEXT NOT NULL REFERENCES applications(id),
    sender_principal_id TEXT NOT NULL REFERENCES principals(id),
    kind TEXT NOT NULL,
    body TEXT,
    metadata TEXT,
    idempotency_key TEXT NOT NULL,
    payload_hash TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_app_idempotency
    ON messages(app_id, idempotency_key)`,

  // 6. Delivery (the state ownership contract §6). `state` stays exactly the
  // five-value claim-lifecycle enum documented there
  // (pending/claimed/delivered/failed/expired), owned by the
  // delivery.claim/delivery.complete workstream. `read_at` and
  // `acknowledged_at` are this workstream's addition (ws-7 — see this
  // file's own header note and the completion report for why): durable
  // storage for message.read / message.acknowledge, which
  // the state ownership contract's Delivery section does not otherwise have a
  // column for, even though docs/protocol.md requires a durable
  // `delivery_state: "acknowledged"` fact that survives a daemon restart.
  // The `delivery_state` string returned by inbox.list/message.acknowledge
  // is computed from these two columns layered on top of `state`, never
  // stored as a `state` value itself.
  `CREATE TABLE IF NOT EXISTS deliveries (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id),
    endpoint_id TEXT NOT NULL REFERENCES endpoints(id),
    state TEXT NOT NULL,
    read_at TEXT,
    acknowledged_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_active_per_message_endpoint
    ON deliveries(message_id, endpoint_id)
    WHERE state IN ('pending', 'claimed')`,

  // 7. Claim (the state ownership contract §7) - no prefixed id, keyed by
  // (resource_type, resource_id) + bearer token.
  `CREATE TABLE IF NOT EXISTS claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    state TEXT NOT NULL,
    token TEXT NOT NULL,
    claimed_at TEXT NOT NULL,
    lease_expires_at TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 1,
    released_at TEXT,
    outcome TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_claims_active_per_resource
    ON claims(resource_type, resource_id)
    WHERE state = 'claimed'`,

  // 8. Obligation (the state ownership contract §8)
  `CREATE TABLE IF NOT EXISTS obligations (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    message_id TEXT NOT NULL REFERENCES messages(id),
    principal_id TEXT NOT NULL REFERENCES principals(id),
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    ack_state TEXT,
    durable_satisfaction_state TEXT,
    satisfied_by_message_id TEXT REFERENCES messages(id),
    durable_satisfied_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  // 9. Resume request (the state ownership contract §9)
  `CREATE TABLE IF NOT EXISTS resume_requests (
    id TEXT PRIMARY KEY,
    endpoint_id TEXT NOT NULL REFERENCES endpoints(id),
    principal_id TEXT NOT NULL REFERENCES principals(id),
    session_id TEXT,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    message_id TEXT NOT NULL REFERENCES messages(id),
    reason TEXT,
    authority_reference TEXT,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  // 10. Migration record (the state ownership contract §10) - split into two
  // tables: applied schema history, and import history.
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    schema_version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS import_manifests (
    import_id TEXT PRIMARY KEY,
    source_product TEXT NOT NULL,
    source_revision TEXT,
    schema_version_at_import INTEGER NOT NULL,
    record_counts TEXT,
    content_hash TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    status TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_import_manifests_content_hash
    ON import_manifests(content_hash)`,
];

// ---------------------------------------------------------------------
// Schema v2 (session ownership). Three deltas, one migration:
//
//   endpoints       state enum `live|idle|offline|closed` becomes
//                   `busy|idle|dead|closed`, plus `runtime` (the resume
//                   axis, distinct from `authority_name`'s trust axis)
//                   and `launch_mode` (interactive | non_interactive).
//   obligations     `message_id` relaxes to nullable and the Beacon
//                   promise columns land; `kind` gains `promise`.
//   resume_requests the `endpoint_offline` reason value is renamed to
//                   `endpoint_dead` alongside the state it names.
//
// The obligations table is rebuilt rather than altered because SQLite
// cannot relax NOT NULL in place. `src/daemon/migrations.mjs` runs this
// whole function inside one BEGIN IMMEDIATE transaction, and the
// create/copy/drop/rename recipe is safe there: `PRAGMA foreign_keys` is
// a no-op inside an open transaction (it stays ON, as src/daemon/db.mjs
// set it), the copied rows all reference live parents, and no other
// table declares a foreign key onto obligations — which
// assertNoObligationReferrer proves before the drop rather than trusting
// SQLite's opaque "FOREIGN KEY constraint failed" to explain it.

// Beacon promise constraints ported from the root package
// src/lib/runtime_store_beacon_migration.mjs:5-42 (revision 60ba7d53).
// Every ported terminal-state constraint is scoped to `kind = 'promise'`:
// those columns exist only for promises, whereas Tightbeam's
// read/reply/acknowledge obligations record satisfaction in
// `durable_satisfaction_state`/`durable_satisfied_at` and predate the
// promise columns. Scoping keeps the rebuild a pure copy — no
// pre-existing row can violate a v2 CHECK, so none needs invented
// backfill (see test/unit/migration_v2.test.mjs's parity assertions).
const V2_OBLIGATIONS_COLUMNS_CARRIED_OVER = [
  'id',
  'conversation_id',
  'message_id',
  'principal_id',
  'kind',
  'state',
  'ack_state',
  'durable_satisfaction_state',
  'satisfied_by_message_id',
  'durable_satisfied_at',
  'created_at',
  'updated_at',
];

const V2_OBLIGATIONS_TABLE = `CREATE TABLE obligations_v2 (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    message_id TEXT REFERENCES messages(id),
    principal_id TEXT NOT NULL REFERENCES principals(id),
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    ack_state TEXT,
    durable_satisfaction_state TEXT,
    satisfied_by_message_id TEXT REFERENCES messages(id),
    durable_satisfied_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    endpoint_id TEXT REFERENCES endpoints(id),
    registration_key TEXT,
    terminal_outcome TEXT,
    cancellation_reason TEXT,
    cancellation_source_ref TEXT,
    stop_block_count INTEGER NOT NULL DEFAULT 0,
    confirmation_message_id TEXT REFERENCES messages(id),
    resolved_at TEXT,

    CHECK (terminal_outcome IS NULL
        OR terminal_outcome IN ('success', 'failure', 'blocked')),
    CHECK (stop_block_count BETWEEN 0 AND 3),
    CHECK (kind <> 'promise'
        OR state <> 'satisfied'
        OR (satisfied_by_message_id IS NOT NULL AND terminal_outcome IS NOT NULL)),
    CHECK (kind <> 'promise'
        OR state <> 'cancelled'
        OR (cancellation_reason IS NOT NULL AND cancellation_source_ref IS NOT NULL)),
    CHECK (kind <> 'promise'
        OR (state = 'open' AND resolved_at IS NULL)
        OR (state IN ('satisfied', 'cancelled') AND resolved_at IS NOT NULL)),
    CHECK (kind <> 'promise'
        OR (endpoint_id IS NOT NULL
            AND registration_key IS NOT NULL
            AND conversation_id IS NOT NULL))
  )`;

const V2_OBLIGATIONS_INDEXES = [
  // Beacon criterion: one live registration per (session, key). NULL keys
  // are outside the index, so pre-promise obligations are unconstrained.
  `CREATE UNIQUE INDEX idx_obligations_registration
    ON obligations(endpoint_id, registration_key)
    WHERE registration_key IS NOT NULL`,
  // Beacon criteria 9 and 10: one message resolves at most one promise.
  `CREATE UNIQUE INDEX idx_obligations_terminal_message
    ON obligations(satisfied_by_message_id)
    WHERE kind = 'promise'`,
];

// ---------------------------------------------------------------------
// Schema v3 (acknowledgement, custody handoff, and terminal truth).
//
// SQLite must rebuild obligations because v2's promise CHECK required an
// endpoint for every promise. An offered delegation intentionally has no
// exact recipient endpoint until its recipient accepts custody. The
// self-reference names the temporary rebuild table: SQLite rewrites it to
// `obligations` when the table is renamed after the old table is dropped.
const V3_OBLIGATIONS_COLUMNS_CARRIED_OVER = [
  ...V2_OBLIGATIONS_COLUMNS_CARRIED_OVER,
  'endpoint_id',
  'registration_key',
  'terminal_outcome',
  'cancellation_reason',
  'cancellation_source_ref',
  'stop_block_count',
  'confirmation_message_id',
  'resolved_at',
];

const V3_OBLIGATIONS_TABLE = `CREATE TABLE obligations_v3 (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    message_id TEXT REFERENCES messages(id),
    principal_id TEXT NOT NULL REFERENCES principals(id),
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    ack_state TEXT,
    durable_satisfaction_state TEXT,
    satisfied_by_message_id TEXT REFERENCES messages(id),
    durable_satisfied_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    endpoint_id TEXT REFERENCES endpoints(id),
    registration_key TEXT,
    terminal_outcome TEXT,
    cancellation_reason TEXT,
    cancellation_source_ref TEXT,
    stop_block_count INTEGER NOT NULL DEFAULT 0,
    confirmation_message_id TEXT REFERENCES messages(id),
    resolved_at TEXT,
    parent_obligation_id TEXT REFERENCES obligations_v3(id),
    relationship TEXT,
    proposed_final_message_id TEXT REFERENCES messages(id),
    attention_required_at TEXT,
    failure_code TEXT,
    reply_completion_mode TEXT DEFAULT 'message_committed',

    CHECK (terminal_outcome IS NULL
        OR terminal_outcome IN ('success', 'failure', 'blocked')),
    CHECK (stop_block_count BETWEEN 0 AND 3),
    CHECK (kind <> 'promise'
        OR state <> 'satisfied'
        OR (satisfied_by_message_id IS NOT NULL AND terminal_outcome IS NOT NULL)),
    CHECK (kind <> 'promise'
        OR state <> 'cancelled'
        OR (cancellation_reason IS NOT NULL AND cancellation_source_ref IS NOT NULL)),
    CHECK (kind <> 'promise'
        OR (state = 'open' AND resolved_at IS NULL)
        OR (state IN ('satisfied', 'cancelled') AND resolved_at IS NOT NULL)),
    CHECK (relationship IS NULL OR relationship IN ('attempt', 'delegation')),
    CHECK (relationship IS NULL
        OR (kind = 'promise' AND parent_obligation_id IS NOT NULL)),
    CHECK (kind <> 'promise'
        OR (registration_key IS NOT NULL
            AND conversation_id IS NOT NULL
            AND (endpoint_id IS NOT NULL
                OR (state = 'open' AND relationship IS 'delegation')))),
    CHECK (reply_completion_mode IN ('message_committed', 'delivery_confirmed'))
  )`;

const V3_OBLIGATIONS_INDEXES = [
  ...V2_OBLIGATIONS_INDEXES,
  // One root can have a single current response owner. Historical
  // attempts remain terminal rows, so retries retain their audit trail.
  `CREATE UNIQUE INDEX idx_obligations_open_attempt_per_root
    ON obligations(parent_obligation_id)
    WHERE relationship = 'attempt' AND state = 'open'`,
  // The offer key is scoped to the sender's parent, and stays distinct
  // from the endpoint registration key enforced by the v2 index above.
  `CREATE UNIQUE INDEX idx_obligations_delegation_offer
    ON obligations(parent_obligation_id, registration_key)
    WHERE relationship = 'delegation' AND registration_key IS NOT NULL`,
];

// Schema 4 preserves the schema-3 tree but lets an unaccepted delegation
// offer be cancelled with its parent. A NULL endpoint remains impossible
// for every legacy promise and for any delegation with acceptance/final
// evidence; only an offer that has neither fact can remain endpointless.
const V4_OBLIGATIONS_TABLE = V3_OBLIGATIONS_TABLE
  .replaceAll('obligations_v3', 'obligations_v4')
  .replace(
    "AND (endpoint_id IS NOT NULL\n                OR (state = 'open' AND relationship IS 'delegation'))",
    "AND (endpoint_id IS NOT NULL\n                OR (relationship IS 'delegation'\n                    AND confirmation_message_id IS NULL\n                    AND satisfied_by_message_id IS NULL))",
  );

const V4_OBLIGATIONS_COLUMNS_CARRIED_OVER = [
  ...V3_OBLIGATIONS_COLUMNS_CARRIED_OVER,
  'parent_obligation_id',
  'relationship',
  'proposed_final_message_id',
  'attention_required_at',
  'failure_code',
  'reply_completion_mode',
];

/**
 * Fails closed if any other table declares a foreign key onto
 * `obligations`. The drop-and-rename rebuild recipe is only correct while
 * nothing references the table; SQLite would otherwise abort the DROP
 * with a bare "FOREIGN KEY constraint failed" that names neither the
 * table nor the reason.
 */
function assertNoObligationReferrer(db, schemaLabel) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => row.name)
    .filter((name) => name !== 'obligations');

  const referrers = tables.filter((name) =>
    db
      .prepare(`PRAGMA foreign_key_list(${JSON.stringify(name)})`)
      .all()
      .some((fk) => fk.table === 'obligations'),
  );

  if (referrers.length === 0) return;

  const err = new Error(
    `cannot rebuild obligations for ${schemaLabel}: ${referrers.join(', ')} declare a foreign key referencing obligations, which the drop-and-rename rebuild would break`,
  );
  err.code = 'migration_incompatible';
  throw err;
}

function rebuildObligations(db) {
  assertNoObligationReferrer(db, 'schema 2');

  const before = db.prepare('SELECT COUNT(*) AS n FROM obligations').get().n;

  db.exec(V2_OBLIGATIONS_TABLE);
  const carried = V2_OBLIGATIONS_COLUMNS_CARRIED_OVER.join(', ');
  db.exec(`INSERT INTO obligations_v2 (${carried}) SELECT ${carried} FROM obligations`);

  const copied = db.prepare('SELECT COUNT(*) AS n FROM obligations_v2').get().n;
  if (copied !== before) {
    // Unreachable short of SQLite misbehaving, but the rebuild is the
    // highest-data-risk step in this migration: a silent row loss would
    // destroy durable satisfaction facts, so prove parity before the
    // DROP makes the original unrecoverable.
    const err = new Error(
      `obligations rebuild copied ${copied} of ${before} rows; refusing to drop the original`,
    );
    err.code = 'migration_incompatible';
    throw err;
  }

  db.exec('DROP TABLE obligations');
  db.exec('ALTER TABLE obligations_v2 RENAME TO obligations');
  for (const statement of V2_OBLIGATIONS_INDEXES) db.exec(statement);
}

function rebuildObligationsV3(db) {
  assertNoObligationReferrer(db, 'schema 3');

  const before = db.prepare('SELECT COUNT(*) AS n FROM obligations').get().n;
  db.exec(V3_OBLIGATIONS_TABLE);
  const carried = V3_OBLIGATIONS_COLUMNS_CARRIED_OVER.join(', ');
  db.exec(`INSERT INTO obligations_v3 (${carried}) SELECT ${carried} FROM obligations`);

  const copied = db.prepare('SELECT COUNT(*) AS n FROM obligations_v3').get().n;
  if (copied !== before) {
    const err = new Error(
      `obligations schema-3 rebuild copied ${copied} of ${before} rows; refusing to drop the original`,
    );
    err.code = 'migration_incompatible';
    throw err;
  }

  db.exec('DROP TABLE obligations');
  db.exec('ALTER TABLE obligations_v3 RENAME TO obligations');
  for (const statement of V3_OBLIGATIONS_INDEXES) db.exec(statement);

  const foreignKeyIssues = db.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyIssues.length > 0) {
    const err = new Error('obligations schema-3 rebuild left foreign-key violations');
    err.code = 'migration_incompatible';
    throw err;
  }
}

function rebuildObligationsV4(db) {
  assertNoObligationReferrer(db, 'schema 4');

  const before = db.prepare('SELECT COUNT(*) AS n FROM obligations').get().n;
  db.exec(V4_OBLIGATIONS_TABLE);
  const carried = V4_OBLIGATIONS_COLUMNS_CARRIED_OVER.join(', ');
  db.exec(`INSERT INTO obligations_v4 (${carried}) SELECT ${carried} FROM obligations`);

  const copied = db.prepare('SELECT COUNT(*) AS n FROM obligations_v4').get().n;
  if (copied !== before) {
    const err = new Error(`obligations schema-4 rebuild copied ${copied} of ${before} rows; refusing to drop the original`);
    err.code = 'migration_incompatible';
    throw err;
  }

  db.exec('DROP TABLE obligations');
  db.exec('ALTER TABLE obligations_v4 RENAME TO obligations');
  for (const statement of V3_OBLIGATIONS_INDEXES) db.exec(statement);

  const foreignKeyIssues = db.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyIssues.length > 0) {
    const err = new Error('obligations schema-4 rebuild left foreign-key violations');
    err.code = 'migration_incompatible';
    throw err;
  }
}

// ---------------------------------------------------------------------
// Schema v7 (the guarded lifecycle cutover, Project Relay parent 1.1).
//
// `obligations` becomes the forward canonical work truth: role
// (root|attempt|delegation), status (open|closed), a monotonic
// non-null generation for exact generation fencing, accountable
// principal plus optional exact custodian endpoint, first-progress
// evidence, and ONE immutable resolution discriminator with its variant
// fields. Legacy columns (kind/state/ack_state/durable satisfaction/
// registration keys) cease to exist; closed legacy history is discarded,
// never converted — activation is refused outright while any legacy row
// is still open, so discarding can never erase active accountability.
//
// The self-reference names the temporary rebuild table: SQLite rewrites
// it to `obligations` when the table is renamed after the old table is
// dropped. Unlike v2-v4 there is deliberately NO INSERT..SELECT row
// copy: the forward graph starts empty.
const V7_OBLIGATIONS_TABLE = `CREATE TABLE obligations_v7 (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    parent_id TEXT REFERENCES obligations_v7(id),
    role TEXT NOT NULL,
    status TEXT NOT NULL,
    generation INTEGER NOT NULL,
    accountable_principal_id TEXT NOT NULL REFERENCES principals(id),
    custodian_endpoint_id TEXT REFERENCES endpoints(id),
    first_progress_message_id TEXT REFERENCES messages(id),
    first_progress_at TEXT,
    resolution TEXT,
    resolution_message_id TEXT REFERENCES messages(id),
    resolution_outcome TEXT,
    resolution_reason TEXT,
    resolution_source TEXT,
    resolution_replacement_id TEXT REFERENCES obligations_v7(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,

    CHECK (role IN ('root', 'attempt', 'delegation')),
    CHECK (status IN ('open', 'closed')),
    CHECK (generation >= 1),
    CHECK (resolution IS NULL
        OR resolution IN ('fulfilled', 'cancelled', 'failed', 'superseded')),
    -- Roots carry accountability without executing custody; attempts are
    -- always owned by an exact endpoint; delegations bind custody only at
    -- acceptance, so their custodian may be NULL while offered.
    CHECK ((role = 'root' AND custodian_endpoint_id IS NULL)
        OR (role = 'attempt' AND custodian_endpoint_id IS NOT NULL)
        OR role = 'delegation'),
    -- A root has no parent; every attempt and delegation hangs from one.
    CHECK ((role = 'root' AND parent_id IS NULL)
        OR (role <> 'root' AND parent_id IS NOT NULL)),
    -- First-progress evidence lands as one fact: the message that first
    -- moved the work and when it did.
    CHECK ((first_progress_message_id IS NULL) = (first_progress_at IS NULL)),
    -- Open rows carry no resolution facts at all; closed rows always name
    -- exactly one resolution discriminator.
    CHECK ((status = 'open'
                AND resolution IS NULL
                AND resolution_message_id IS NULL
                AND resolution_outcome IS NULL
                AND resolution_reason IS NULL
                AND resolution_source IS NULL
                AND resolution_replacement_id IS NULL)
        OR (status = 'closed' AND resolution IS NOT NULL)),
    -- Variant fields are exclusive to their discriminator and complete
    -- within it: fulfilled(message_id, outcome), cancelled(reason, source),
    -- failed(failure_code -> resolution_reason, source), superseded(
    -- replacement_id, source). A closed row matching none of these shapes
    -- is unwritable. Every branch tests IS NOT NULL before its value
    -- comparison so a missing field can never sneak through as SQL NULL
    -- (a CHECK passes whenever it evaluates to NULL, not just TRUE).
    CHECK (resolution IS NULL OR (
           (resolution = 'fulfilled'
               AND resolution_message_id IS NOT NULL
               AND resolution_outcome IS NOT NULL
               AND resolution_outcome IN ('success', 'failure', 'blocked')
               AND resolution_reason IS NULL
               AND resolution_source IS NULL
               AND resolution_replacement_id IS NULL)
        OR (resolution = 'cancelled'
               AND resolution_reason IS NOT NULL
               AND resolution_source IS NOT NULL
               AND resolution_message_id IS NULL
               AND resolution_outcome IS NULL
               AND resolution_replacement_id IS NULL)
        OR (resolution = 'failed'
               AND resolution_reason IS NOT NULL
               AND resolution_source IS NOT NULL
               AND resolution_message_id IS NULL
               AND resolution_outcome IS NULL
               AND resolution_replacement_id IS NULL)
        OR (resolution = 'superseded'
               AND resolution_replacement_id IS NOT NULL
               AND resolution_source IS NOT NULL
               AND resolution_message_id IS NULL
               AND resolution_outcome IS NULL
               AND resolution_reason IS NULL)))
  )`;

const V7_OBLIGATIONS_INDEXES = [
  // One root can have a single open attempt; terminal attempts keep their
  // audit trail across retries.
  `CREATE UNIQUE INDEX idx_obligations_open_attempt_per_root
    ON obligations(parent_id)
    WHERE role = 'attempt' AND status = 'open'`,
  // Stop safety and death reconciliation read owned open work by endpoint.
  `CREATE INDEX idx_obligations_open_by_custodian
    ON obligations(custodian_endpoint_id)
    WHERE status = 'open'`,
  // message.none admission and conversation projections scan open work
  // per conversation.
  `CREATE INDEX idx_obligations_conversation_status
    ON obligations(conversation_id, status)`,
];

// Closed resolutions are immutable: no UPDATE may touch a closed row.
// Transitions close a row exactly once by writing status and its variant
// fields together; everything after that is read-only history.
const V7_OBLIGATIONS_CLOSED_IMMUTABLE_TRIGGER = `CREATE TRIGGER trg_obligations_closed_immutable
  BEFORE UPDATE ON obligations
  WHEN OLD.status = 'closed'
BEGIN
  SELECT RAISE(ABORT, 'obligations row is closed; its resolution is immutable');
END`;

// One-to-one immutable effect audit: every post-cutover
// application-authored message declares exactly one effect, stored as the
// canonical dotted effect name plus the full canonical effect JSON. The
// obligation reference pairs with the exact generation it named, so a
// stale-generation replay can never be mistaken for the original effect.
const V7_MESSAGE_EFFECTS_TABLE = `CREATE TABLE message_effects (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
    effect TEXT NOT NULL CHECK (effect IN (
      'open', 'update',
      'handoff.offer', 'handoff.accept', 'handoff.decline',
      'close.fulfilled', 'close.cancelled',
      'none')),
    effect_payload TEXT NOT NULL,
    obligation_id TEXT REFERENCES obligations(id),
    obligation_generation INTEGER,
    created_at TEXT NOT NULL,

    CHECK ((obligation_id IS NULL) = (obligation_generation IS NULL))
  )`;

const V7_MESSAGE_EFFECTS_IMMUTABLE_TRIGGERS = [
  `CREATE TRIGGER trg_message_effects_immutable_update
    BEFORE UPDATE ON message_effects
  BEGIN
    SELECT RAISE(ABORT, 'message_effects rows are immutable');
  END`,
  `CREATE TRIGGER trg_message_effects_immutable_delete
    BEFORE DELETE ON message_effects
  BEGIN
    SELECT RAISE(ABORT, 'message_effects rows are immutable');
  END`,
];

// One durable watch per delegation covers the pre-acceptance gap: the
// offer requires an explicit absolute acceptance deadline, the watch
// advances to awaiting_result on acceptance or closes once with exactly
// one terminal outcome, and at most one immediate-parent delivery route
// is ever referenced.
const V7_HANDOFF_WATCHES_TABLE = `CREATE TABLE handoff_watches (
    id TEXT PRIMARY KEY,
    delegation_id TEXT NOT NULL UNIQUE REFERENCES obligations(id),
    state TEXT NOT NULL CHECK (state IN ('awaiting_acceptance', 'awaiting_result', 'closed')),
    acceptance_deadline_at TEXT NOT NULL,
    outcome TEXT CHECK (outcome IN ('result', 'declined', 'acceptance_expired', 'child_failed')),
    parent_delivery_id TEXT UNIQUE REFERENCES deliveries(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT,

    CHECK ((state = 'closed' AND outcome IS NOT NULL AND closed_at IS NOT NULL)
        OR (state <> 'closed' AND outcome IS NULL AND closed_at IS NULL))
  )`;

/**
 * Fails closed unless every legacy obligation row is already terminal.
 * Runs before any schema mutation so a refused activation leaves the
 * store byte-identical; the diagnostic names each open family and count
 * so the operator knows exactly what stands between them and the cutover.
 */
function assertNoOpenLegacyObligations(db, targetVersion) {
  const families = db
    .prepare(
      `SELECT CASE WHEN relationship IS NOT NULL THEN relationship ELSE kind END AS family,
              COUNT(*) AS n
         FROM obligations
        WHERE state = 'open'
        GROUP BY family
        ORDER BY family`,
    )
    .all();

  if (families.length === 0) return;

  const total = families.reduce((sum, family) => sum + family.n, 0);
  const counts = families.map((family) => `${family.family}=${family.n}`).join(', ');
  const err = new Error(
    `cannot activate lifecycle schema ${targetVersion}: ${total} open legacy obligation row(s) remain (${counts}); drain them with the previous binary (finish or cancel the open work there), then upgrade this state root`,
  );
  err.code = 'migration_incompatible';
  throw err;
}

function rebuildObligationsV7Forward(db) {
  assertNoOpenLegacyObligations(db, 8);
  assertNoObligationReferrer(db, 'the guarded lifecycle cutover');

  // No INSERT..SELECT here on purpose: legacy rows are terminal history
  // to discard, not state to convert. The guard above proved nothing
  // live is lost by dropping them.
  db.exec(V7_OBLIGATIONS_TABLE);
  db.exec('DROP TABLE obligations');
  db.exec('ALTER TABLE obligations_v7 RENAME TO obligations');
  for (const statement of V7_OBLIGATIONS_INDEXES) db.exec(statement);
  db.exec(V7_OBLIGATIONS_CLOSED_IMMUTABLE_TRIGGER);

  const foreignKeyIssues = db.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyIssues.length > 0) {
    const err = new Error('obligations lifecycle-cutover rebuild left foreign-key violations');
    err.code = 'migration_incompatible';
    throw err;
  }
}

function createForwardLifecycleTables(db) {
  // New foreign-keyed tables come after the obligations rebuild so they
  // reference the final table name and the referrer guard stays valid.
  db.exec(V7_MESSAGE_EFFECTS_TABLE);
  for (const statement of V7_MESSAGE_EFFECTS_IMMUTABLE_TRIGGERS) db.exec(statement);
  db.exec(V7_HANDOFF_WATCHES_TABLE);

  // Pre-cutover endpoints have no observed process yet; the column fills
  // in when a runtime next adopts each endpoint (task 4.x fencing).
  db.exec('ALTER TABLE endpoints ADD COLUMN process_generation INTEGER CHECK (process_generation IS NULL OR process_generation >= 1)');

  // Typed lifecycle routes (recovery commands, child results) carry both
  // fields together; ordinary participant fan-out leaves both NULL.
  db.exec('ALTER TABLE deliveries ADD COLUMN route_reason TEXT');
  db.exec(`ALTER TABLE deliveries ADD COLUMN source_obligation_id TEXT REFERENCES obligations(id)
    CHECK ((route_reason IS NULL AND source_obligation_id IS NULL)
        OR (route_reason IS NOT NULL AND source_obligation_id IS NOT NULL))`);
}

/**
 * Guarded activation step 5 (plan «Migration Plan»): invalidate every
 * legacy lifecycle idempotency entry whose operation the cutover disables.
 *
 * The obligation-keyed entries (obligation.create registration keys,
 * obligation.attempt.start offer keys) are already gone with the legacy
 * table itself. What survives is `messages(app_id, idempotency_key)`:
 * every pre-cutover message was written by message.send/message.reply,
 * which are lifecycle writers. Left as-is, an exact pre-cutover replay
 * could later be answered by a forward writer's identity lookup as an
 * "idempotent replay" of a mutation that never carried a lifecycle effect.
 * Namespacing the key in place frees the presented identity (a lookup at
 * the original key now finds nothing to answer with) while preserving the
 * transport row untouched otherwise. The transform is injective, so the
 * UNIQUE(app_id, idempotency_key) index cannot be violated by it, and it
 * runs once inside the cutover transaction: a fresh database has no rows,
 * and no post-cutover writer ever runs again on pre-cutover keys.
 */
function invalidateLegacyLifecycleIdempotency(db) {
  db.exec("UPDATE messages SET idempotency_key = 'pre_cutover:' || idempotency_key");
}

// ---------------------------------------------------------------------
// Schema v9 (the lifecycle command ledger, Project Relay parent 2.3).
//
// RECOVERY-RETRY / RECOVERY-SWITCH (docs/lifecycle-control-plane/
// transitions.yaml) are administrative transitions: the contract requires
// no message row for them, and every other durable surface they touch
// (obligations, deliveries, resume_requests) already exists at v8. What v8
// has nowhere for is their idempotency identity: messages carry
// (app_id, idempotency_key) for message.commit, but a command without a
// message cannot hang its key there. This ledger is that one missing fact,
// shaped exactly like the message identity it mirrors: canonical payload
// hash for replay-vs-collision, result payload for faithful reconstruction,
// UNIQUE(app_id, operation, idempotency_key) so two competing commands
// race on the index inside the admitting transaction and exactly one wins.
const V9_LIFECYCLE_COMMANDS_TABLE = `CREATE TABLE lifecycle_commands (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES applications(id),
    operation TEXT NOT NULL CHECK (operation IN ('recovery.retry', 'recovery.switch')),
    idempotency_key TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    root_obligation_id TEXT NOT NULL REFERENCES obligations(id),
    result_payload TEXT NOT NULL,
    created_at TEXT NOT NULL,

    UNIQUE (app_id, operation, idempotency_key)
  )`;

// ---------------------------------------------------------------------
// Schema v10 (session.stop identity + bounded Stop-block evidence, Project
// Relay parent 3.2).
//
// session.stop is an administrative transition like recovery.retry/switch:
// the contract gives it no message row, so its (app, operation,
// idempotency_key) replay identity rides lifecycle_commands. SQLite cannot
// widen a CHECK in place, so the ledger is rebuilt: 'session.stop' joins
// the operation vocabulary, and root_obligation_id relaxes to nullable —
// a Stop is authenticated by ENDPOINT identity and fenced by process
// generation, not rooted at one obligation, so unlike recovery it has no
// single root to name. Every stored column is carried over verbatim; the
// rebuild is a pure re-shape.
const V10_LIFECYCLE_COMMANDS_TABLE = `CREATE TABLE lifecycle_commands_v10 (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES applications(id),
    operation TEXT NOT NULL CHECK (operation IN ('recovery.retry', 'recovery.switch', 'session.stop')),
    idempotency_key TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    root_obligation_id TEXT REFERENCES obligations(id),
    result_payload TEXT NOT NULL,
    created_at TEXT NOT NULL,

    UNIQUE (app_id, operation, idempotency_key)
  )`;

// The durable half of STOP-BLOCK-UNOWNED's bounded escape
// (leave_open_and_mark_attention, INV-18 / LC-S03): one row per blocked
// root holding BOTH facts the contract demands — the work stays open (this
// table never closes anything) and the work is made visible (the row IS
// the attention mark) — together with the anti-wedge counter that bounds
// the escape at three blocked Stops before a force-allow. The decision
// logic increments under the lifecycle_commands UNIQUE arbitration, so a
// replayed key can never consume a second unit of budget; wave 4's
// clearRootAttention clears exactly this row when explicit recovery admits
// a new attempt.
const V10_ROOT_ATTENTION_TABLE = `CREATE TABLE root_attention (
    root_obligation_id TEXT PRIMARY KEY REFERENCES obligations(id),
    stop_block_count INTEGER NOT NULL CHECK (stop_block_count BETWEEN 1 AND 3),
    attention_source TEXT NOT NULL,
    first_marked_at TEXT NOT NULL,
    last_block_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;

function rebuildLifecycleCommandsForStop(db) {
  db.exec(V10_LIFECYCLE_COMMANDS_TABLE);
  db.exec(
    `INSERT INTO lifecycle_commands_v10
      (id, app_id, operation, idempotency_key, payload_hash, root_obligation_id, result_payload, created_at)
     SELECT id, app_id, operation, idempotency_key, payload_hash, root_obligation_id, result_payload, created_at
       FROM lifecycle_commands`,
  );
  db.exec('DROP TABLE lifecycle_commands');
  db.exec('ALTER TABLE lifecycle_commands_v10 RENAME TO lifecycle_commands');
}

// ---------------------------------------------------------------------
// Schema v19 (explicit conversation closure).
//
// conversation.close is an administrative transition with no message row:
// its idempotency record therefore belongs with the existing recovery and
// Stop commands. SQLite CHECK constraints cannot be widened in place, so
// rebuild the ledger while preserving every prior command verbatim.
const V19_LIFECYCLE_COMMANDS_TABLE = `CREATE TABLE lifecycle_commands_v19 (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES applications(id),
    operation TEXT NOT NULL CHECK (operation IN ('recovery.retry', 'recovery.switch', 'session.stop', 'conversation.close')),
    idempotency_key TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    root_obligation_id TEXT REFERENCES obligations(id),
    result_payload TEXT NOT NULL,
    created_at TEXT NOT NULL,

    UNIQUE (app_id, operation, idempotency_key)
  )`;

function rebuildLifecycleCommandsForConversationClose(db) {
  db.exec(V19_LIFECYCLE_COMMANDS_TABLE);
  db.exec(
    `INSERT INTO lifecycle_commands_v19
      (id, app_id, operation, idempotency_key, payload_hash, root_obligation_id, result_payload, created_at)
     SELECT id, app_id, operation, idempotency_key, payload_hash, root_obligation_id, result_payload, created_at
       FROM lifecycle_commands`,
  );
  db.exec('DROP TABLE lifecycle_commands');
  db.exec('ALTER TABLE lifecycle_commands_v19 RENAME TO lifecycle_commands');
}

// ---------------------------------------------------------------------
// Schema v11 (the launch-collision discriminator, Project Relay parent
// 4.1 repair).
//
// One integer per endpoint row, advanced by exactly the writes that take
// ownership (endpoint.register's three stamping seams). Death evidence is
// fenced by BOTH process generation and this epoch: a capture frozen at
// launch time names the epoch the row had THEN, so evidence arriving after
// any registration — including a sibling launch's registration of the same
// predicted generation — names an older epoch and stays inert. Every
// existing row starts at 0: pre-v10 custody has no observed regime change
// to represent, and the first seam on each row moves it off that baseline.

const V11_ENDPOINT_OWNER_EPOCH = 'ALTER TABLE endpoints ADD COLUMN owner_epoch INTEGER NOT NULL DEFAULT 0';

// ---------------------------------------------------------------------
// Schema v12 (the per-launch ownership token, Project Relay parent 4.1
// repair completed).
//
// The epoch counts ownership regimes but cannot NAME one, so it fences
// both pre-registration siblings alike — including the one that went on
// to register, whose own exit then wrote nothing and left its captured
// custody open forever. This column names the regime: the launch token
// the tick minted for the child whose registration currently owns the
// row, or NULL when the current owner arrived without one (an interactive
// session, an application-registered target). Every seam that advances
// the generation and the epoch WRITES this column too — stamping the
// registering launch's token, or NULL — so a recorded token always
// identifies the live owner and never lingers from a superseded regime.
// Nullable with no default: pre-v11 rows have no launch identity to
// claim, and their evidence keeps falling back to the epoch rule.

const V12_ENDPOINT_OWNER_LAUNCH_TOKEN = 'ALTER TABLE endpoints ADD COLUMN owner_launch_token TEXT';

// ---------------------------------------------------------------------
// Schema v13 (minimal channel-route registry).
//
// The table intentionally carries only descriptor facts. Provider identity,
// credentials, executable configuration, availability state, and default
// routing policy remain outside Tightbeam. Reserved selector modes are a
// structural invariant so no integration can impersonate `all` or `origin`.
const V13_CHANNEL_ROUTES_TABLE = `CREATE TABLE channel_routes (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES applications(id),
    principal_id TEXT NOT NULL REFERENCES principals(id),
    endpoint_id TEXT NOT NULL REFERENCES endpoints(id),
    selector TEXT NOT NULL CHECK (selector NOT IN ('all', 'origin')),
    label TEXT NOT NULL,
    capabilities TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,

    UNIQUE (selector),
    UNIQUE (endpoint_id)
  )`;

const V13_MESSAGES_ORIGIN_CHANNEL_ROUTE = 'ALTER TABLE messages ADD COLUMN origin_channel_route_id TEXT REFERENCES channel_routes(id)';
const V13_DELIVERIES_CHANNEL_ROUTE = 'ALTER TABLE deliveries ADD COLUMN channel_route_id TEXT REFERENCES channel_routes(id)';

// ---------------------------------------------------------------------
// Schema v14 (channel-route retirement).
//
// v13's `UNIQUE (selector)` / `UNIQUE (endpoint_id)` are bare table-level
// constraints with no lifecycle state, so a selector's claim was
// permanent: once its endpoint closed, nothing could ever free the
// selector for re-registration (AC 3.1.2). This migration gives routes a
// two-state lifecycle (`active` | `retired`) and moves both uniqueness
// rules onto PARTIAL indexes scoped to `state = 'active'`, so a retired
// row's selector/endpoint claim no longer blocks a fresh registration.
// SQLite cannot drop a table-level UNIQUE in place, so the table is
// rebuilt (create/copy/drop/rename, same recipe as rebuildObligations —
// see that function's header note on why this is safe inside the
// migration's own transaction). Every existing row carries over as
// `active` with no `retired_at`: pre-v14 custody has nothing to record as
// retired. messages.origin_channel_route_id and deliveries.channel_route_id
// keep referencing channel_routes(id) by id, which the rebuild preserves
// verbatim, so both FKs stay valid across the rename.
const V14_CHANNEL_ROUTES_TABLE = `CREATE TABLE channel_routes_v14 (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES applications(id),
    principal_id TEXT NOT NULL REFERENCES principals(id),
    endpoint_id TEXT NOT NULL REFERENCES endpoints(id),
    selector TEXT NOT NULL CHECK (selector NOT IN ('all', 'origin')),
    label TEXT NOT NULL,
    capabilities TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'retired')),
    retired_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;

const V14_CHANNEL_ROUTES_COLUMNS_CARRIED_OVER = [
  'id',
  'app_id',
  'principal_id',
  'endpoint_id',
  'selector',
  'label',
  'capabilities',
  'created_at',
  'updated_at',
];

function rebuildChannelRoutesV14(db) {
  const before = db.prepare('SELECT COUNT(*) AS n FROM channel_routes').get().n;

  db.exec(V14_CHANNEL_ROUTES_TABLE);
  const carried = V14_CHANNEL_ROUTES_COLUMNS_CARRIED_OVER.join(', ');
  db.exec(`INSERT INTO channel_routes_v14 (${carried}, state) SELECT ${carried}, 'active' FROM channel_routes`);

  const copied = db.prepare('SELECT COUNT(*) AS n FROM channel_routes_v14').get().n;
  if (copied !== before) {
    const err = new Error(
      `channel_routes schema-14 rebuild copied ${copied} of ${before} rows; refusing to drop the original`,
    );
    err.code = 'migration_incompatible';
    throw err;
  }

  db.exec('DROP TABLE channel_routes');
  db.exec('ALTER TABLE channel_routes_v14 RENAME TO channel_routes');
  db.exec("CREATE UNIQUE INDEX channel_routes_active_selector ON channel_routes (selector) WHERE state = 'active'");
  db.exec("CREATE UNIQUE INDEX channel_routes_active_endpoint ON channel_routes (endpoint_id) WHERE state = 'active'");

  const foreignKeyIssues = db.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyIssues.length > 0) {
    const err = new Error(`channel_routes schema-14 rebuild left dangling foreign keys: ${JSON.stringify(foreignKeyIssues)}`);
    err.code = 'migration_incompatible';
    throw err;
  }
}

// ---------------------------------------------------------------------
// Schema v15 (opaque reply bindings and endpoint-fenced listeners).
//
// These are additive durable facts. A token is represented only by its
// digest; plaintext `rpb_` capability material is intentionally absent from
// the schema as well as the export path. Listener/wait rows record a later
// delivery choice and never determine binding validity.
const V15_REPLY_BINDING_TABLES = `
  CREATE TABLE reply_bindings (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES applications(id),
    channel_route_id TEXT NOT NULL REFERENCES channel_routes(id),
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    source_message_id TEXT NOT NULL REFERENCES messages(id),
    source_delivery_id TEXT NOT NULL REFERENCES deliveries(id),
    target_endpoint_id TEXT NOT NULL REFERENCES endpoints(id),
    source_provider_session_id TEXT,
    source_process_generation INTEGER,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'retired')),
    retired_at TEXT,
    retired_reason TEXT
  );
  CREATE UNIQUE INDEX reply_bindings_source_delivery ON reply_bindings(source_delivery_id);
  CREATE INDEX reply_bindings_app_route_state ON reply_bindings(app_id, channel_route_id, state);
  CREATE INDEX reply_bindings_target_endpoint_state ON reply_bindings(target_endpoint_id, state);

  CREATE TABLE reply_binding_tokens (
    token_digest TEXT PRIMARY KEY,
    binding_id TEXT NOT NULL REFERENCES reply_bindings(id),
    issued_at TEXT NOT NULL,
    retired_at TEXT
  );
  CREATE UNIQUE INDEX reply_binding_tokens_digest ON reply_binding_tokens(token_digest);
  CREATE INDEX reply_binding_tokens_binding ON reply_binding_tokens(binding_id);

  CREATE TABLE reply_binding_events (
    binding_id TEXT NOT NULL REFERENCES reply_bindings(id),
    external_event_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    committed_message_id TEXT REFERENCES messages(id),
    result_payload TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (binding_id, external_event_id)
  );
  CREATE UNIQUE INDEX reply_binding_events_binding_event ON reply_binding_events(binding_id, external_event_id);

  CREATE TABLE reply_waits (
    id TEXT PRIMARY KEY,
    binding_id TEXT NOT NULL REFERENCES reply_bindings(id),
    endpoint_id TEXT NOT NULL REFERENCES endpoints(id),
    provider_session_id TEXT,
    process_generation INTEGER,
    state TEXT NOT NULL CHECK (state IN ('pending_delivery', 'eligible', 'satisfied', 'failed', 'cancelled', 'expired')),
    terminal_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT
  );
  CREATE UNIQUE INDEX reply_waits_binding ON reply_waits(binding_id);
  CREATE INDEX reply_waits_endpoint_state ON reply_waits(endpoint_id, process_generation, state);

  CREATE TABLE listeners (
    id TEXT PRIMARY KEY,
    reply_wait_id TEXT REFERENCES reply_waits(id),
    endpoint_id TEXT NOT NULL REFERENCES endpoints(id),
    provider_session_id TEXT,
    process_generation INTEGER NOT NULL,
    listener_generation INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('parked', 'attached', 'waking', 'ended')),
    lease_expires_at TEXT,
    park_deadline_at TEXT NOT NULL,
    terminal_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE UNIQUE INDEX listeners_active_endpoint_generation
    ON listeners(endpoint_id, process_generation)
    WHERE state IN ('parked', 'attached', 'waking');
  CREATE UNIQUE INDEX listeners_wait_generation ON listeners(reply_wait_id, listener_generation)
    WHERE reply_wait_id IS NOT NULL;

  CREATE TABLE listener_presentations (
    id TEXT PRIMARY KEY,
    listener_id TEXT NOT NULL REFERENCES listeners(id),
    listener_generation INTEGER NOT NULL,
    message_id TEXT NOT NULL REFERENCES messages(id),
    target_delivery_id TEXT NOT NULL REFERENCES deliveries(id),
    state TEXT NOT NULL CHECK (state IN ('pending', 'acked', 'missed')),
    ack_deadline_at TEXT NOT NULL,
    acked_at TEXT,
    missed_at TEXT,
    fallback_resume_request_id TEXT REFERENCES resume_requests(id),
    fallback_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX listener_presentations_target_delivery ON listener_presentations(target_delivery_id);
  CREATE INDEX listener_presentations_listener_state ON listener_presentations(listener_id, listener_generation, state);
`;

// The daemon's real, ordered migration list (ws-10 src/daemon/migrations.mjs
// framework). v1 is this repository's schema baseline and is never
// rewritten; later workstreams append further { schemaVersion, apply(db) }
// entries here. See test/unit/migrations.test.mjs for the framework's own
// forward-only/atomic/ordered-application proof and
// test/unit/migration_v2.test.mjs for v2's data-parity proof.
export const MIGRATIONS = [
  {
    schemaVersion: 1,
    apply(db) {
      for (const statement of CREATE_STATEMENTS) db.exec(statement);
    },
  },
  {
    schemaVersion: 2,
    apply(db) {
      rebuildObligations(db);

      db.exec('ALTER TABLE endpoints ADD COLUMN runtime TEXT');
      db.exec('ALTER TABLE endpoints ADD COLUMN launch_mode TEXT');
      // `runtime` is the resume axis and `authority_name` the trust axis;
      // before v2 they were the same value, which is exactly the
      // inference resume.claim performed at read time.
      db.exec('UPDATE endpoints SET runtime = authority_name');

      // live -> idle is the conservative direction: an endpoint recorded
      // live under the old model is alive and not mid-turn.
      db.exec("UPDATE endpoints SET state = 'idle' WHERE state = 'live'");
      db.exec("UPDATE endpoints SET state = 'dead' WHERE state = 'offline'");

      // Rename the historical reason values alongside the state they name.
      db.exec("UPDATE resume_requests SET reason = 'endpoint_dead' WHERE reason = 'endpoint_offline'");
    },
  },
  {
    schemaVersion: 3,
    apply(db) {
      rebuildObligationsV3(db);
    },
  },
  {
    schemaVersion: 4,
    apply(db) {
      rebuildObligationsV4(db);
    },
  },
  {
    schemaVersion: 5,
    apply(db) {
      db.exec('ALTER TABLE obligations ADD COLUMN offer_registration_key TEXT');
      db.exec('DROP INDEX idx_obligations_delegation_offer');
      db.exec(`CREATE UNIQUE INDEX idx_obligations_delegation_offer
        ON obligations(parent_obligation_id, offer_registration_key)
        WHERE relationship = 'delegation' AND offer_registration_key IS NOT NULL`);
    },
  },
  {
    schemaVersion: 6,
    apply(db) {
      // Completed delivery records are immutable transport history. A
      // recovery route needs a fresh pending row for the same message and
      // endpoint, so uniqueness fences only active claimable rows.
      db.exec('DROP INDEX idx_deliveries_active_per_message_endpoint');
      db.exec(`CREATE UNIQUE INDEX idx_deliveries_active_per_message_endpoint
        ON deliveries(message_id, endpoint_id)
        WHERE state IN ('pending', 'claimed')`);
    },
  },
  {
    schemaVersion: 7,
    apply(db) {
      // Author-origin axis (harbor). The v5 pattern: one additive ALTER.
      // NOT NULL with a constant default means every pre-v7 row backfills
      // to 'agent'; the CHECK survives ADD COLUMN on node:sqlite and then
      // guards every later write — including state.import's plain INSERTs
      // (a value outside the vocabulary aborts the whole import inside its
      // transaction).
      db.exec("ALTER TABLE messages ADD COLUMN origin TEXT NOT NULL DEFAULT 'agent' CHECK (origin IN ('agent','inbound'))");
    },
  },
  {
    schemaVersion: 8,
    apply(db) {
      rebuildObligationsV7Forward(db);
      createForwardLifecycleTables(db);
      invalidateLegacyLifecycleIdempotency(db);
    },
  },
  {
    schemaVersion: 9,
    apply(db) {
      db.exec(V9_LIFECYCLE_COMMANDS_TABLE);
    },
  },
  {
    schemaVersion: 10,
    apply(db) {
      rebuildLifecycleCommandsForStop(db);
      db.exec(V10_ROOT_ATTENTION_TABLE);
    },
  },
  {
    schemaVersion: 11,
    apply(db) {
      db.exec(V11_ENDPOINT_OWNER_EPOCH);
    },
  },
  {
    schemaVersion: 12,
    apply(db) {
      db.exec(V12_ENDPOINT_OWNER_LAUNCH_TOKEN);
    },
  },
  {
    schemaVersion: 13,
    apply(db) {
      db.exec(V13_CHANNEL_ROUTES_TABLE);
      db.exec(V13_MESSAGES_ORIGIN_CHANNEL_ROUTE);
      db.exec(V13_DELIVERIES_CHANNEL_ROUTE);
    },
  },
  {
    schemaVersion: 14,
    apply(db) {
      rebuildChannelRoutesV14(db);
    },
  },
  {
    schemaVersion: 15,
    apply(db) {
      db.exec(V15_REPLY_BINDING_TABLES);
    },
  },
  {
    schemaVersion: 16,
    apply(db) {
      db.exec('ALTER TABLE messages ADD COLUMN in_reply_to_message_id TEXT REFERENCES messages(id)');
      db.exec(`CREATE TRIGGER trg_messages_reply_parent_same_conversation
        BEFORE INSERT ON messages
        WHEN NEW.in_reply_to_message_id IS NOT NULL
          AND (NEW.in_reply_to_message_id = NEW.id
            OR (EXISTS(SELECT 1 FROM messages WHERE id = NEW.in_reply_to_message_id)
              AND (SELECT conversation_id FROM messages WHERE id = NEW.in_reply_to_message_id) <> NEW.conversation_id))
      BEGIN
        SELECT RAISE(ABORT, 'message reply parent must be an existing message in the same conversation');
      END`);
      db.exec(`CREATE TRIGGER trg_messages_reply_parent_immutable
        BEFORE UPDATE OF in_reply_to_message_id ON messages
        WHEN OLD.in_reply_to_message_id IS NOT NEW.in_reply_to_message_id
      BEGIN
        SELECT RAISE(ABORT, 'message reply parent is immutable');
      END`);
    },
  },
  {
    // Gate A keeps acknowledgement and recovery continuity on the rows
    // that already own those lifecycles. Every column is nullable: these
    // facts did not exist when historical roots and resume requests were
    // written, and an upgrade must not invent an acknowledgement or a
    // replacement lineage for them.
    schemaVersion: 17,
    apply(db) {
      db.exec('ALTER TABLE obligations ADD COLUMN ack_due_at TEXT');
      db.exec('ALTER TABLE obligations ADD COLUMN ack_message_id TEXT REFERENCES messages(id)');
      db.exec('ALTER TABLE obligations ADD COLUMN ack_delivery_id TEXT REFERENCES deliveries(id)');
      db.exec('ALTER TABLE obligations ADD COLUMN ack_accepted_at TEXT');

      db.exec('ALTER TABLE resume_requests ADD COLUMN recovery_mode TEXT');
      db.exec('ALTER TABLE resume_requests ADD COLUMN replacement_for_request_id TEXT REFERENCES resume_requests(id)');
      db.exec('ALTER TABLE resume_requests ADD COLUMN replacement_endpoint_id TEXT REFERENCES endpoints(id)');
      db.exec('ALTER TABLE resume_requests ADD COLUMN replacement_session_id TEXT');
      db.exec('ALTER TABLE resume_requests ADD COLUMN replacement_admitted_at TEXT');
      db.exec('ALTER TABLE resume_requests ADD COLUMN replacement_failure_reason TEXT');
    },
  },
  {
    // Tachyon keeps process ownership, retirement, and presentation truth
    // as separate durable facts. Existing endpoints/listeners intentionally
    // receive NULL owner/admission fields: they remain parkable, but a
    // future retirement executor must fail closed without verified owner
    // identity rather than inventing one during migration.
    schemaVersion: 18,
    apply(db) {
      db.exec('ALTER TABLE endpoints ADD COLUMN owner_process_pid INTEGER');
      db.exec('ALTER TABLE endpoints ADD COLUMN owner_process_start_identity TEXT');
      db.exec('ALTER TABLE endpoints ADD COLUMN owner_process_group_id INTEGER');
      db.exec('ALTER TABLE endpoints ADD COLUMN owner_process_capture_source TEXT');
      db.exec('ALTER TABLE endpoints ADD COLUMN owner_process_generation INTEGER CHECK (owner_process_generation IS NULL OR owner_process_generation >= 1)');

      db.exec(`CREATE TABLE endpoint_retirements (
        id TEXT PRIMARY KEY,
        endpoint_id TEXT NOT NULL REFERENCES endpoints(id),
        process_generation INTEGER NOT NULL CHECK (process_generation >= 1),
        listener_id TEXT NOT NULL REFERENCES listeners(id),
        listener_generation INTEGER NOT NULL CHECK (listener_generation >= 1),
        state TEXT NOT NULL CHECK (state IN ('pending', 'terminated', 'failed', 'cancelled')),
        cause TEXT NOT NULL,
        owner_process_pid INTEGER,
        owner_process_start_identity TEXT,
        owner_process_group_id INTEGER,
        owner_process_capture_source TEXT,
        owner_process_generation INTEGER,
        failure_reason TEXT,
        confirmed_exit_at TEXT,
        confirmed_exit_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        UNIQUE (endpoint_id, process_generation, listener_generation)
      )`);
      db.exec('CREATE INDEX endpoint_retirements_endpoint_state ON endpoint_retirements(endpoint_id, state)');

      db.exec('ALTER TABLE listener_presentations ADD COLUMN reply_wait_id TEXT REFERENCES reply_waits(id)');
      db.exec('ALTER TABLE listener_presentations ADD COLUMN staged_at TEXT');
      db.exec('ALTER TABLE listener_presentations ADD COLUMN admitted_at TEXT');
      db.exec('DROP INDEX listener_presentations_target_delivery');
      db.exec("CREATE UNIQUE INDEX listener_presentations_target_delivery_pending ON listener_presentations(target_delivery_id) WHERE state = 'pending'");
    },
  },
  {
    schemaVersion: 19,
    apply(db) {
      rebuildLifecycleCommandsForConversationClose(db);
    },
  },
  {
    // v18 recorded the process tuple but not the ownership regime that
    // admitted it.  Retiring an interactive owner later must compare the
    // original epoch/token/session, not infer stability from a current read.
    schemaVersion: 20,
    apply(db) {
      db.exec('ALTER TABLE endpoint_retirements ADD COLUMN owner_epoch INTEGER');
      db.exec('ALTER TABLE endpoint_retirements ADD COLUMN owner_launch_token TEXT');
      db.exec('ALTER TABLE endpoint_retirements ADD COLUMN provider_session_id TEXT');
      const now = new Date().toISOString();
      db.prepare(`UPDATE endpoint_retirements SET state = 'failed', failure_reason = 'retirement_snapshot_unavailable', updated_at = ?, closed_at = ?
        WHERE state IN ('pending', 'terminated') AND (owner_epoch IS NULL OR provider_session_id IS NULL)`).run(now, now);
      db.prepare(`UPDATE endpoints SET state = 'retiring', updated_at = ?
        WHERE state = 'dead' AND launch_mode IS NOT 'non_interactive' AND EXISTS (
          SELECT 1 FROM endpoint_retirements r WHERE r.endpoint_id = endpoints.id
            AND r.failure_reason = 'retirement_snapshot_unavailable'
        )`).run(now);
    },
  },
  {
    // An ordinary non-interactive recovery has no listener presentation to
    // retain who admitted its body.  Record the exact owner tuple on its
    // request so a later process generation on the same provider session
    // cannot replay a prior receipt just because the request is completed.
    schemaVersion: 21,
    apply(db) {
      db.exec('ALTER TABLE resume_requests ADD COLUMN admitted_at TEXT');
      db.exec('ALTER TABLE resume_requests ADD COLUMN admitted_process_generation INTEGER CHECK (admitted_process_generation IS NULL OR admitted_process_generation >= 1)');
      db.exec('ALTER TABLE resume_requests ADD COLUMN admitted_provider_session_id TEXT');
    },
  },
  {
    // Delivery admission belongs to the durable unread row.  Existing work
    // deliberately remains unadmitted: a truthful notification attempt is
    // the only event allowed to open its first window.
    schemaVersion: 22,
    apply(db) {
      db.exec('ALTER TABLE deliveries ADD COLUMN admission_opened_at TEXT');
      db.exec('ALTER TABLE deliveries ADD COLUMN admission_process_generation INTEGER CHECK (admission_process_generation IS NULL OR admission_process_generation >= 1)');
      db.exec('ALTER TABLE deliveries ADD COLUMN admission_provider_session_id TEXT');
      db.exec('ALTER TABLE deliveries ADD COLUMN admission_owner_epoch INTEGER CHECK (admission_owner_epoch IS NULL OR admission_owner_epoch >= 1)');
      db.exec('ALTER TABLE deliveries ADD COLUMN admission_owner_launch_token TEXT');
      db.exec('ALTER TABLE deliveries ADD COLUMN admitted_at TEXT');
      db.exec('ALTER TABLE deliveries ADD COLUMN retry_armed_at TEXT');
      db.exec('ALTER TABLE deliveries ADD COLUMN takeover_decided_at TEXT');
      db.exec(`CREATE INDEX deliveries_admission_lookup
        ON deliveries(endpoint_id, admission_process_generation, admission_provider_session_id, admission_owner_epoch, created_at, id)
        WHERE read_at IS NULL AND admitted_at IS NULL AND admission_opened_at IS NOT NULL`);
      // SQLite considers NULL values distinct in a UNIQUE index.  Launch
      // tokens are either NULL or non-empty, so empty text is a safe
      // canonical representative for the tokenless predecessor owner.
      db.exec(`CREATE UNIQUE INDEX deliveries_one_active_admission_per_owner
        ON deliveries(endpoint_id, admission_process_generation, admission_provider_session_id, admission_owner_epoch,
           IFNULL(admission_owner_launch_token, ''))
        WHERE state != 'failed' AND read_at IS NULL AND admitted_at IS NULL AND admission_opened_at IS NOT NULL AND takeover_decided_at IS NULL`);
      // A completed/failed request is historical evidence too: allowing a
      // new row after it would let an obsolete timer obtain fresh authority.
      db.exec(`CREATE UNIQUE INDEX resume_requests_availability_takeover_once
        ON resume_requests(endpoint_id, message_id, reason)
        WHERE reason = 'availability_takeover'`);
    },
  },
  {
    schemaVersion: 23,
    apply(db) {
      db.exec('ALTER TABLE endpoints ADD COLUMN tachyon_armed_process_generation INTEGER CHECK (tachyon_armed_process_generation IS NULL OR tachyon_armed_process_generation >= 1)');
      reconcileTachyonArmingFromAudit(db);
    },
  },
  {
    // Forward-only launcher identity. Historical rows intentionally stay
    // NULL so Tightbeam never guesses Academy ownership.
    schemaVersion: 24,
    apply(db) {
      db.exec('ALTER TABLE endpoints ADD COLUMN academy_agent_name TEXT');
    },
  },
  {
    // Item 42 C (session resume safety). `owner_process_exited_at` is the
    // daemon's confirmed observation that the recorded owner process of the
    // endpoint's CURRENT generation is gone (retirement_executor.mjs
    // runOwnerProcessReconciliation). It is the one proof that lets an
    // interactive or unknown-mode session be resumed headlessly, and every
    // seam that stamps owner facts clears it. Existing rows start NULL: no
    // exit was ever observed.
    //
    // Endpoints stuck `retiring` behind a retirement that could never run
    // (owner_process_unverified: no owner was ever captured) return to
    // idle. Under Joe's 2026-09-29 rule a session whose owner is not proven
    // gone keeps its session and only gets work enqueued; `retiring` also
    // refused every hook state write, which broke those sessions if still
    // open. The failed retirement rows stay as history.
    schemaVersion: 25,
    apply(db) {
      db.exec('ALTER TABLE endpoints ADD COLUMN owner_process_exited_at TEXT');
      db.prepare(`UPDATE endpoints SET state = 'idle'
        WHERE state = 'retiring'
          AND NOT EXISTS (
            SELECT 1 FROM endpoint_retirements pending
             WHERE pending.endpoint_id = endpoints.id AND pending.state = 'pending'
          )
          AND EXISTS (
            SELECT 1 FROM endpoint_retirements failed
             WHERE failed.endpoint_id = endpoints.id
               AND failed.process_generation = endpoints.process_generation
               AND failed.state = 'failed'
               AND failed.failure_reason = 'owner_process_unverified'
          )`).run();
    },
  },
];

/**
 * Opens the schema against an already-open database (see
 * src/daemon/db.mjs): applies every pending migration from MIGRATIONS in
 * ascending order, each atomically recorded in schema_migrations on
 * success (src/daemon/migrations.mjs). Idempotent: a fresh database gets
 * the full table set plus one schema_migrations row per shipped version;
 * an already-current database opens clean with no duplicate migration
 * row; a v1 database is carried forward to SCHEMA_VERSION in place. A
 * database recording a schema version newer than SCHEMA_VERSION fails
 * closed with migration_incompatible.
 */
export function openSchema(db) {
  return applyMigrations(db, MIGRATIONS);
}

/**
 * Every applied schema migration, ascending — used by migration.status
 * (docs/protocol.md "State movement").
 */
export function migrationHistory(db) {
  return listAppliedMigrations(db);
}
