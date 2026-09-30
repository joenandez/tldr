// Generic forward-only migration framework (ws-10). schema.mjs supplies
// the daemon's real (currently single-entry, v1-baseline) migration list
// to this module; this module owns the mechanics: ordered application,
// one transaction per migration, a schema_migrations row recorded only on
// that migration's successful commit, and fail-closed when the database
// already records a schema_version newer than any migration this caller
// knows about (the state ownership contract §10 "Forward application is atomic
// and auditable").
//
// Kept generic (accepts any migrations array) specifically so a unit test
// can register a scratch fake v2 migration against a scratch database
// without that v2 ever appearing in the daemon's real migration list
// (src/daemon/schema.mjs) — see test/unit/migrations.test.mjs.

import { withTransaction } from './db.mjs';

/**
 * @typedef {object} Migration
 * @property {number} schemaVersion - target version this migration produces, e.g. 1
 * @property {(db) => void} apply - runs the migration's DDL/DML against db
 */

export function ensureMigrationsTable(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (schema_version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
}

/**
 * The highest schema_version recorded as applied, or 0 for a brand-new
 * database with no migrations table yet.
 */
export function currentSchemaVersion(db) {
  ensureMigrationsTable(db);
  const row = db.prepare('SELECT MAX(schema_version) AS version FROM schema_migrations').get();
  return row && row.version != null ? row.version : 0;
}

/**
 * Applies every migration in `migrations` whose schemaVersion is greater
 * than the database's current recorded version, strictly in ascending
 * schemaVersion order regardless of the input array's order. Each
 * migration runs inside its own BEGIN IMMEDIATE / COMMIT transaction
 * (src/daemon/db.mjs withTransaction): the migration's DDL/DML and its
 * schema_migrations row insert happen atomically together, so a failure
 * partway through one migration never leaves that migration's row behind
 * to falsely claim it succeeded, and never leaves a later migration
 * partially applied (each is its own transaction, applied one at a time).
 *
 * Fails closed with err.code === 'migration_incompatible' if the database
 * already records a schema_version higher than the highest schemaVersion
 * in `migrations` — this database was written by a newer daemon and this
 * caller does not know how to open it.
 *
 * Returns the schema_version the database is at after this call (the
 * highest schemaVersion among `migrations`, once every pending migration
 * has applied).
 */
export function applyMigrations(db, migrations) {
  ensureMigrationsTable(db);

  const ordered = [...migrations].sort((a, b) => a.schemaVersion - b.schemaVersion);
  const maxKnownVersion = ordered.length > 0 ? ordered[ordered.length - 1].schemaVersion : 0;
  const current = currentSchemaVersion(db);

  if (current > maxKnownVersion) {
    const err = new Error(`state schema version ${current} is newer than the version this daemon supports (${maxKnownVersion})`);
    err.code = 'migration_incompatible';
    throw err;
  }

  for (const migration of ordered) {
    if (migration.schemaVersion <= current) continue;
    withTransaction(db, () => {
      migration.apply(db);
      db.prepare('INSERT INTO schema_migrations (schema_version, applied_at) VALUES (?, ?)').run(
        migration.schemaVersion,
        new Date().toISOString(),
      );
    });
  }

  return maxKnownVersion;
}

/**
 * Every applied migration row, ascending by schema_version — the exact
 * shape docs/protocol.md's migration.status "applied_migrations" needs.
 */
export function listAppliedMigrations(db) {
  ensureMigrationsTable(db);
  return db.prepare('SELECT schema_version, applied_at FROM schema_migrations ORDER BY schema_version ASC').all();
}
