// migration.status — docs/protocol.md "State movement". `read_health` or
// admin, like daemon.status/capabilities.list. No secrets
// (docs/protocol.md "Diagnostics rule"): import history summary rows
// carry only manifest bookkeeping (source identity, counts, content_hash,
// timestamps, status) — never row-level record content.

export const migrationStatusOp = {
  name: 'migration.status',
  allowedScopes: ['admin', 'agent'],
  permission: 'read_health',
  handler(context) {
    const appliedMigrations = context.db
      .prepare('SELECT schema_version, applied_at FROM schema_migrations ORDER BY schema_version ASC')
      .all();

    // Imports are always all-or-nothing (state_import.mjs: one
    // transaction, no persisted partial/pending state) — nothing in this
    // daemon's design ever leaves an import "pending", so this is always
    // 0. Kept as an explicit field because docs/protocol.md's
    // migration.status result names it.
    const pendingImports = 0;

    const importRows = context.db
      .prepare(
        'SELECT import_id, source_product, source_revision, schema_version_at_import, record_counts, content_hash, imported_at, status FROM import_manifests ORDER BY imported_at ASC',
      )
      .all();

    return {
      result: {
        schema_version: context.schemaVersion,
        applied_migrations: appliedMigrations.map((r) => ({ schema_version: r.schema_version, applied_at: r.applied_at })),
        pending_imports: pendingImports,
        // Additive beyond docs/protocol.md's minimum contract: the ws-10
        // task brief asks migration.status to surface an "import history
        // summary"; protocol.md's literal result shape does not forbid
        // extra fields (see e.g. daemon_version on daemon.status).
        imports: importRows.map((r) => ({
          import_id: r.import_id,
          source_product: r.source_product,
          source_revision: r.source_revision,
          schema_version_at_import: r.schema_version_at_import,
          record_counts: JSON.parse(r.record_counts || '{}'),
          content_hash: r.content_hash,
          imported_at: r.imported_at,
          status: r.status,
        })),
      },
    };
  },
};
