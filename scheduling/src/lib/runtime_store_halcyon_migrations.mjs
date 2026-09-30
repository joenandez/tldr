/**
 * Halcyon Phase 1A — runtime store migrations.
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
 * Migration 7 is permanently reserved.
 *
 * Earlier releases used this slot for retired communication persistence. Keep
 * the version in the chain so v6 stores can advance safely, but never create
 * retired communication schema in a fresh runtime store.
 */
export const MIGRATION_EVENTIDE_RESERVED_V7 = {
  toVersion: 7,
  name: "eventide reserved retired communication schema slot",
  apply() {},
};
