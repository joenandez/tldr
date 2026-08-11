/**
 * Halcyon Phase 1A + 1B — runtime store migrations.
 *
 * Kept in a separate module so the migration DDL does not grow runtime_store.mjs
 * past its file-size ratchet baseline. runtime_store.mjs imports and appends
 * these entries into DEFAULT_RUNTIME_MIGRATIONS.
 */

/**
 * Migration 6 — dispatch_due_index (Phase 1A admission bridge).
 *
 * Creates a transactional projection of each job's dispatch eligibility that
 * is updated in the same mutation path as every saveJobs/persistRuntimePatch
 * call. H2 will consume this projection once a drift-free soak gate passes.
 *
 * Schema:
 *   PK(scope_id, job_id)         — one row per job, globally keyed by scope
 *   enabled INTEGER NOT NULL     — mirrors the job's enabled flag
 *   next_run_at TEXT             — ISO; NULL = job not scheduled
 *   active_run_id TEXT           — non-NULL suppresses dispatch for this job
 *   source_mtime_ms REAL         — mtime of jobs.json at projection time (drift detect)
 *   updated_at TEXT NOT NULL     — ISO; last write timestamp
 *
 * Index:
 *   idx_due(enabled, next_run_at) — covers the H2 due-query:
 *     SELECT * FROM dispatch_due_index WHERE enabled=1 AND next_run_at <= ?
 */
export const MIGRATION_DISPATCH_DUE_INDEX = {
  toVersion: 6,
  name: "halcyon phase 1a dispatch_due_index",
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS dispatch_due_index (
        scope_id        TEXT NOT NULL,
        job_id          TEXT NOT NULL,
        enabled         INTEGER NOT NULL,
        next_run_at     TEXT,
        active_run_id   TEXT,
        source_mtime_ms REAL,
        updated_at      TEXT NOT NULL,
        PRIMARY KEY (scope_id, job_id)
      );

      CREATE INDEX IF NOT EXISTS idx_due
        ON dispatch_due_index (enabled, next_run_at);
    `);
  },
};

/**
 * Migration 7 — canonical store tables (Phase 1B).
 *
 * Adds three scope-keyed tables that back the canonical_store.mjs engine
 * swap. Hot columns are first-class; full records ride in payload JSON.
 * messages.jsonl remains the append-only body log; byte_offset + byte_length
 * are both required so indexed row reads never fall back to a full scan.
 *
 * Tables:
 *   canonical_threads          PK(scope_id, thread_id)
 *   canonical_transport_state  PK(scope_id, message_id)
 *   canonical_message_index    PK(scope_id, message_id)
 *
 * Indexes:
 *   idx_threads_external  (scope_id, external_thread_id)
 *   idx_msg_thread        (scope_id, thread_id)
 *   uq_msg_idem           UNIQUE (scope_id, idempotency_key)  WHERE NOT NULL
 *   uq_msg_external       UNIQUE (scope_id, external_message_id) WHERE NOT NULL
 */
export const MIGRATION_CANONICAL_TABLES = {
  toVersion: 7,
  name: "halcyon phase 1b canonical_threads/transport_state/message_index",
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS canonical_threads (
        scope_id          TEXT NOT NULL,
        thread_id         TEXT NOT NULL,
        payload           TEXT NOT NULL,
        owner_session_id  TEXT,
        external_thread_id TEXT,
        updated_at        TEXT NOT NULL,
        PRIMARY KEY (scope_id, thread_id)
      );

      CREATE INDEX IF NOT EXISTS idx_threads_external
        ON canonical_threads (scope_id, external_thread_id);

      CREATE TABLE IF NOT EXISTS canonical_transport_state (
        scope_id          TEXT NOT NULL,
        message_id        TEXT NOT NULL,
        payload           TEXT NOT NULL,
        dispatch_decision TEXT,
        updated_at        TEXT NOT NULL,
        PRIMARY KEY (scope_id, message_id)
      );

      CREATE TABLE IF NOT EXISTS canonical_message_index (
        scope_id            TEXT NOT NULL,
        message_id          TEXT NOT NULL,
        thread_id           TEXT NOT NULL,
        byte_offset         INTEGER NOT NULL,
        byte_length         INTEGER NOT NULL,
        idempotency_key     TEXT,
        external_message_id TEXT,
        created_at          TEXT NOT NULL,
        PRIMARY KEY (scope_id, message_id)
      );

      CREATE INDEX IF NOT EXISTS idx_msg_thread
        ON canonical_message_index (scope_id, thread_id);

      CREATE UNIQUE INDEX IF NOT EXISTS uq_msg_idem
        ON canonical_message_index (scope_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS uq_msg_external
        ON canonical_message_index (scope_id, external_message_id)
        WHERE external_message_id IS NOT NULL;
    `);
  },
};

export const MIGRATION_RESERVED_8 = {
  toVersion: 8,
  name: "reserved schema slot 8",
  apply() {},
};

export const MIGRATION_RESERVED_9 = {
  toVersion: 9,
  name: "reserved schema slot 9",
  apply() {},
};

export const MIGRATION_TLDR_AGENT_MESSAGE_PAYLOADS = {
  toVersion: 10,
  name: "tldr; canonical message payloads",
  apply(db) {
    db.exec(`
      ALTER TABLE canonical_message_index ADD COLUMN payload TEXT;
    `);
  },
};
