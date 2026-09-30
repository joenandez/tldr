import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { RuntimeStoreError, initializeRuntimeStore } from "./runtime_store.mjs";
import { helmHome } from "./store.mjs";

export const CURRENT_SCOPE_REGISTRY_SCHEMA_VERSION = 2;

function nowIso() {
  return new Date().toISOString();
}

function scopesJsonPath(home = helmHome()) {
  return join(home, "scopes.json");
}

function backupRoot(home = helmHome()) {
  return join(home, "backups", "scope-registry");
}

function safeTimestamp(iso) {
  return String(iso || nowIso())
    .replaceAll(":", "")
    .replaceAll(".", "-");
}

function stableId(value) {
  return createHash("sha1").update(String(value)).digest("hex").slice(0, 12);
}

function writeJsonAtomic(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function parseJsonFile(path, code) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new RuntimeStoreError(
      code,
      `failed to parse ${basename(path)}: ${err?.message || String(err)}`,
      { path },
    );
  }
}

function metadataFromDb(db, path = null) {
  const row = db
    .prepare("SELECT * FROM scope_registry_metadata WHERE id = 1")
    .get();
  if (!row) {
    throw new RuntimeStoreError(
      "scope_registry_missing_metadata",
      "scope registry metadata row is missing",
      { path },
    );
  }
  if (row.schema_version > CURRENT_SCOPE_REGISTRY_SCHEMA_VERSION) {
    throw new RuntimeStoreError(
      "scope_registry_schema_newer",
      `scope registry schema version ${row.schema_version} is newer than supported version ${CURRENT_SCOPE_REGISTRY_SCHEMA_VERSION}`,
      {
        path,
        schema_version: row.schema_version,
        supported_schema_version: CURRENT_SCOPE_REGISTRY_SCHEMA_VERSION,
      },
    );
  }
  return {
    schema_version: row.schema_version,
    generation: row.generation,
    updated_at: row.updated_at,
    migrated_from_scopes_json_at: row.migrated_from_scopes_json_at || null,
    last_backup_path: row.last_backup_path || null,
  };
}

function normalizeLegacyScope(entry, index, home, now, actor, reason) {
  const cwd = String(entry?.cwd || entry?.scope_id || "").trim();
  if (!cwd) {
    throw new RuntimeStoreError(
      "scope_registry_import_invalid",
      "scope entry is missing cwd/scope_id",
      { index },
    );
  }
  const scopeId = entry.scope_id || cwd;
  return {
    scope_id: scopeId,
    cwd,
    storage_root:
      entry.storage_root || join(home, "workspaces", stableId(scopeId)),
    generation: null,
    dispatch_state: "disabled",
    quarantine_state: "clear",
    quarantine_reason: null,
    registered_at: entry.registered_at || now,
    updated_at: now,
    enabled_at: null,
    disabled_at: now,
    actor,
    reason,
    source_json: JSON.stringify(entry),
  };
}

function readRows(db) {
  return db
    .prepare(
      `
        SELECT
          scope_id,
          cwd,
          storage_root,
          generation,
          dispatch_state,
          quarantine_state,
          quarantine_reason,
          registered_at,
          updated_at,
          enabled_at,
          disabled_at,
          actor,
          reason,
          source_json
        FROM scope_registry
        ORDER BY cwd, scope_id
      `,
    )
    .all()
    .map((row) => ({
      ...row,
      quarantine_reason: row.quarantine_reason || null,
      enabled_at: row.enabled_at || null,
      disabled_at: row.disabled_at || null,
      actor: row.actor || null,
      reason: row.reason || null,
      source_json: row.source_json || null,
    }));
}

function exportPayload(metadata, entries, exportedAt) {
  return {
    version: "2.0",
    schema_version: CURRENT_SCOPE_REGISTRY_SCHEMA_VERSION,
    generation: metadata.generation,
    exported_at: exportedAt,
    entries,
  };
}

export function assertScopeRegistryReady({
  home = helmHome(),
  now = nowIso,
} = {}) {
  const store = initializeRuntimeStore({ home });
  try {
    const metadata = metadataFromDb(store.db, store.path);
    return {
      ready: true,
      path: store.path,
      ...metadata,
      checked_at: now(),
    };
  } finally {
    store.close();
  }
}

export function listScopeRegistryV2({ home = helmHome() } = {}) {
  const store = initializeRuntimeStore({ home });
  try {
    const metadata = metadataFromDb(store.db, store.path);
    return {
      path: store.path,
      metadata,
      entries: readRows(store.db),
    };
  } finally {
    store.close();
  }
}

export function exportScopeRegistryV2({
  home = helmHome(),
  now = nowIso,
} = {}) {
  const store = initializeRuntimeStore({ home });
  try {
    const exportedAt = now();
    const metadata = metadataFromDb(store.db, store.path);
    const entries = readRows(store.db);
    const path = join(
      backupRoot(home),
      `registry-v2-generation-${metadata.generation}-${safeTimestamp(exportedAt)}.json`,
    );
    writeJsonAtomic(path, exportPayload(metadata, entries, exportedAt));
    return {
      export_path: path,
      generation: metadata.generation,
      exported: entries.length,
    };
  } finally {
    store.close();
  }
}

export function migrateScopesJsonToRegistryV2({
  home = helmHome(),
  actor = "helm",
  reason = "scopes_json_migration",
  now = nowIso,
} = {}) {
  const path = scopesJsonPath(home);
  const store = initializeRuntimeStore({ home });
  try {
    const metadata = metadataFromDb(store.db, store.path);
    if (!existsSync(path)) {
      return {
        migrated: 0,
        generation: metadata.generation,
        backup_path: null,
        export_path: null,
        reason: "scopes_json_missing",
      };
    }

    let parsed;
    try {
      parsed = parseJsonFile(path, "scope_registry_import_invalid");
    } catch (err) {
      const evidencePath = join(
        backupRoot(home),
        `corrupt-scopes-json-${safeTimestamp(now())}.txt`,
      );
      mkdirSync(backupRoot(home), { recursive: true });
      copyFileSync(path, evidencePath);
      err.details = { ...(err.details || {}), evidence_path: evidencePath };
      throw err;
    }
    if (!parsed || !Array.isArray(parsed.scopes)) {
      throw new RuntimeStoreError(
        "scope_registry_import_invalid",
        "scopes.json must contain a scopes array",
        { path },
      );
    }

    const existing = new Set(
      store.db
        .prepare("SELECT scope_id FROM scope_registry")
        .all()
        .map((row) => row.scope_id),
    );
    const importedAt = now();
    const rows = parsed.scopes
      .map((entry, index) =>
        normalizeLegacyScope(entry, index, home, importedAt, actor, reason),
      )
      .filter((entry) => !existing.has(entry.scope_id));

    if (rows.length === 0) {
      return {
        migrated: 0,
        generation: metadata.generation,
        backup_path: metadata.last_backup_path,
        export_path: null,
        reason: "already_migrated",
      };
    }

    const nextGeneration = metadata.generation + 1;
    const backupPath = join(
      backupRoot(home),
      `scopes-json-generation-${nextGeneration}-${safeTimestamp(importedAt)}.json`,
    );
    mkdirSync(backupRoot(home), { recursive: true });
    copyFileSync(path, backupPath);

    store.db.exec("BEGIN IMMEDIATE");
    try {
      const insert = store.db.prepare(`
        INSERT INTO scope_registry (
          scope_id,
          cwd,
          storage_root,
          generation,
          dispatch_state,
          quarantine_state,
          quarantine_reason,
          registered_at,
          updated_at,
          enabled_at,
          disabled_at,
          actor,
          reason,
          source_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of rows) {
        insert.run(
          row.scope_id,
          row.cwd,
          row.storage_root,
          nextGeneration,
          row.dispatch_state,
          row.quarantine_state,
          row.quarantine_reason,
          row.registered_at,
          row.updated_at,
          row.enabled_at,
          row.disabled_at,
          row.actor,
          row.reason,
          row.source_json,
        );
      }
      store.db
        .prepare(
          `
            UPDATE scope_registry_metadata
            SET generation = ?,
                updated_at = ?,
                migrated_from_scopes_json_at = ?,
                last_backup_path = ?
            WHERE id = 1
          `,
        )
        .run(nextGeneration, importedAt, importedAt, backupPath);
      store.db.exec("COMMIT");
    } catch (err) {
      try {
        store.db.exec("ROLLBACK");
      } catch {
        // Preserve original error.
      }
      throw err;
    }

    const exportPath = join(
      backupRoot(home),
      `registry-v2-generation-${nextGeneration}-${safeTimestamp(importedAt)}.json`,
    );
    const currentMetadata = metadataFromDb(store.db, store.path);
    writeJsonAtomic(
      exportPath,
      exportPayload(currentMetadata, readRows(store.db), importedAt),
    );
    return {
      migrated: rows.length,
      generation: nextGeneration,
      backup_path: backupPath,
      export_path: exportPath,
    };
  } finally {
    store.close();
  }
}

export function rollbackScopeRegistryV2({
  home = helmHome(),
  exportPath,
  actor = "helm",
  reason = "rollback",
  now = nowIso,
} = {}) {
  if (!exportPath) {
    throw new RuntimeStoreError(
      "scope_registry_rollback_missing_export",
      "rollback requires an exported registry path",
    );
  }
  const parsed = parseJsonFile(exportPath, "scope_registry_rollback_invalid");
  if (
    !parsed ||
    parsed.schema_version > CURRENT_SCOPE_REGISTRY_SCHEMA_VERSION ||
    !Array.isArray(parsed.entries)
  ) {
    throw new RuntimeStoreError(
      "scope_registry_rollback_invalid",
      "registry rollback export is invalid or unsupported",
      { export_path: exportPath },
    );
  }

  const store = initializeRuntimeStore({ home });
  try {
    const metadata = metadataFromDb(store.db, store.path);
    const restoredAt = now();
    const nextGeneration = metadata.generation + 1;
    store.db.exec("BEGIN IMMEDIATE");
    try {
      store.db.prepare("DELETE FROM scope_registry").run();
      const insert = store.db.prepare(`
        INSERT INTO scope_registry (
          scope_id,
          cwd,
          storage_root,
          generation,
          dispatch_state,
          quarantine_state,
          quarantine_reason,
          registered_at,
          updated_at,
          enabled_at,
          disabled_at,
          actor,
          reason,
          source_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const entry of parsed.entries) {
        insert.run(
          entry.scope_id,
          entry.cwd,
          entry.storage_root,
          nextGeneration,
          entry.dispatch_state === "enabled" ? "disabled" : "disabled",
          entry.quarantine_state || "clear",
          entry.quarantine_reason || null,
          entry.registered_at || restoredAt,
          restoredAt,
          null,
          restoredAt,
          actor,
          reason,
          entry.source_json || null,
        );
      }
      store.db
        .prepare(
          `
            UPDATE scope_registry_metadata
            SET generation = ?,
                updated_at = ?
            WHERE id = 1
          `,
        )
        .run(nextGeneration, restoredAt);
      store.db.exec("COMMIT");
    } catch (err) {
      try {
        store.db.exec("ROLLBACK");
      } catch {
        // Preserve original error.
      }
      throw err;
    }

    return {
      restored: parsed.entries.length,
      generation: nextGeneration,
    };
  } finally {
    store.close();
  }
}

function normalizeKnownScopeId(scopeId) {
  const value = String(scopeId || "").trim();
  if (!value) {
    throw new RuntimeStoreError(
      "scope_registry_scope_required",
      "scope registry operation requires a scope id",
    );
  }
  return value;
}

function requireReason(reason, action) {
  const value = String(reason || "").trim();
  if (!value) {
    throw new RuntimeStoreError(
      "scope_registry_reason_required",
      `${action} requires --reason evidence`,
      { action },
    );
  }
  return value;
}

export function setScopeDispatchState({
  home = helmHome(),
  scopeId,
  dispatchState,
  actor = "helm",
  reason,
  now = nowIso,
} = {}) {
  const id = normalizeKnownScopeId(scopeId);
  if (!["enabled", "disabled"].includes(dispatchState)) {
    throw new RuntimeStoreError(
      "scope_registry_dispatch_state_invalid",
      `invalid dispatch state: ${dispatchState}`,
      { dispatch_state: dispatchState },
    );
  }
  const evidence = requireReason(reason, `dispatch ${dispatchState}`);
  const store = initializeRuntimeStore({ home });
  try {
    const metadata = metadataFromDb(store.db, store.path);
    const changedAt = now();
    const nextGeneration = metadata.generation + 1;
    const result = store.db
      .prepare(
        `
          UPDATE scope_registry
          SET dispatch_state = ?,
              generation = ?,
              updated_at = ?,
              enabled_at = CASE WHEN ? = 'enabled' THEN ? ELSE NULL END,
              disabled_at = CASE WHEN ? = 'disabled' THEN ? ELSE disabled_at END,
              actor = ?,
              reason = ?
          WHERE scope_id = ?
        `,
      )
      .run(
        dispatchState,
        nextGeneration,
        changedAt,
        dispatchState,
        changedAt,
        dispatchState,
        changedAt,
        actor,
        evidence,
        id,
      );
    if (result.changes !== 1) {
      throw new RuntimeStoreError(
        "scope_registry_scope_not_found",
        `scope registry entry not found: ${id}`,
        { scope_id: id },
      );
    }
    store.db
      .prepare(
        "UPDATE scope_registry_metadata SET generation=?, updated_at=? WHERE id=1",
      )
      .run(nextGeneration, changedAt);
    return {
      generation: nextGeneration,
      entry: store.db
        .prepare("SELECT * FROM scope_registry WHERE scope_id=?")
        .get(id),
    };
  } finally {
    store.close();
  }
}

// Mirror legacy registration into V2 so new workspaces enter dispatch.
// Existing rows keep deliberate operator dispatch state.
export function upsertScopeRegistryV2({
  home = helmHome(),
  scope,
  dispatchState = "enabled",
  actor = "helm",
  reason = "scope_auto_register",
  now = nowIso,
} = {}) {
  const id = normalizeKnownScopeId(scope?.scope_id);
  const cwd = String(scope?.cwd || scope?.scope_id || "").trim();
  if (!cwd) {
    throw new RuntimeStoreError(
      "scope_registry_scope_required",
      "scope upsert requires a cwd",
      { scope_id: id },
    );
  }
  if (!["enabled", "disabled"].includes(dispatchState)) {
    throw new RuntimeStoreError(
      "scope_registry_dispatch_state_invalid",
      `invalid dispatch state: ${dispatchState}`,
      { dispatch_state: dispatchState },
    );
  }
  const evidence = requireReason(reason, `register ${dispatchState}`);
  const store = initializeRuntimeStore({ home });
  try {
    const existing = store.db
      .prepare("SELECT * FROM scope_registry WHERE scope_id = ?")
      .get(id);
    if (existing) {
      // Already registered — respect its current dispatch_state.
      const metadata = metadataFromDb(store.db, store.path);
      return {
        created: false,
        generation: metadata.generation,
        entry: existing,
      };
    }
    const metadata = metadataFromDb(store.db, store.path);
    const at = now();
    const nextGeneration = metadata.generation + 1;
    const storageRoot =
      scope.storage_root || join(home, "workspaces", stableId(id));
    store.db.exec("BEGIN IMMEDIATE");
    try {
      store.db
        .prepare(
          `
            INSERT INTO scope_registry (
              scope_id, cwd, storage_root, generation,
              dispatch_state, quarantine_state, quarantine_reason,
              registered_at, updated_at, enabled_at, disabled_at,
              actor, reason, source_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          id,
          cwd,
          storageRoot,
          nextGeneration,
          dispatchState,
          "clear",
          null,
          at,
          at,
          dispatchState === "enabled" ? at : null,
          dispatchState === "disabled" ? at : null,
          actor,
          evidence,
          JSON.stringify(scope),
        );
      store.db
        .prepare(
          "UPDATE scope_registry_metadata SET generation=?, updated_at=? WHERE id=1",
        )
        .run(nextGeneration, at);
      store.db.exec("COMMIT");
    } catch (err) {
      try {
        store.db.exec("ROLLBACK");
      } catch {
        // Preserve original error.
      }
      throw err;
    }
    return {
      created: true,
      generation: nextGeneration,
      entry: store.db
        .prepare("SELECT * FROM scope_registry WHERE scope_id=?")
        .get(id),
    };
  } finally {
    store.close();
  }
}

export function setScopeQuarantineState({
  home = helmHome(),
  scopeId,
  quarantined,
  actor = "helm",
  reason,
  now = nowIso,
} = {}) {
  const id = normalizeKnownScopeId(scopeId);
  const evidence = requireReason(
    reason,
    quarantined ? "quarantine" : "unquarantine",
  );
  const store = initializeRuntimeStore({ home });
  try {
    const metadata = metadataFromDb(store.db, store.path);
    const changedAt = now();
    const nextGeneration = metadata.generation + 1;
    const result = store.db
      .prepare(
        `
          UPDATE scope_registry
          SET quarantine_state = ?,
              quarantine_reason = ?,
              generation = ?,
              updated_at = ?,
              actor = ?,
              reason = ?
          WHERE scope_id = ?
        `,
      )
      .run(
        quarantined ? "quarantined" : "clear",
        quarantined ? evidence : null,
        nextGeneration,
        changedAt,
        actor,
        evidence,
        id,
      );
    if (result.changes !== 1) {
      throw new RuntimeStoreError(
        "scope_registry_scope_not_found",
        `scope registry entry not found: ${id}`,
        { scope_id: id },
      );
    }
    store.db
      .prepare(
        "UPDATE scope_registry_metadata SET generation=?, updated_at=? WHERE id=1",
      )
      .run(nextGeneration, changedAt);
    return {
      generation: nextGeneration,
      entry: store.db
        .prepare("SELECT * FROM scope_registry WHERE scope_id=?")
        .get(id),
    };
  } finally {
    store.close();
  }
}

export function removeScopeRegistryV2({
  home = helmHome(),
  scopeId,
  actor = "helm",
  reason = "scope_unregister",
  now = nowIso,
  beforeCommit = null,
  _commitForTest = null,
} = {}) {
  const id = normalizeKnownScopeId(scopeId);
  const evidence = requireReason(reason, "remove scope");
  const store = initializeRuntimeStore({ home });
  try {
    const existing = store.db
      .prepare("SELECT * FROM scope_registry WHERE scope_id = ?")
      .get(id);
    const metadata = metadataFromDb(store.db, store.path);
    if (!existing) {
      if (typeof beforeCommit === "function") beforeCommit();
      return { removed: 0, generation: metadata.generation, entry: null };
    }
    const changedAt = now();
    const nextGeneration = metadata.generation + 1;
    store.db.exec("BEGIN IMMEDIATE");
    try {
      store.db.prepare("DELETE FROM scope_registry WHERE scope_id = ?").run(id);
      store.db
        .prepare(
          "UPDATE scope_registry_metadata SET generation=?, updated_at=? WHERE id=1",
        )
        .run(nextGeneration, changedAt);
      if (typeof beforeCommit === "function") beforeCommit();
      _commitForTest ? _commitForTest(store.db) : store.db.exec("COMMIT");
    } catch (err) {
      try {
        store.db.exec("ROLLBACK");
      } catch {
        // Preserve original error.
      }
      throw err;
    }
    return {
      removed: 1,
      generation: nextGeneration,
      entry: existing,
      actor,
      reason: evidence,
    };
  } finally {
    store.close();
  }
}

export function pruneMissingScopeRegistryV2({
  home = helmHome(),
  actor = "helm",
  reason = "scope_cwd_missing",
  now = nowIso,
} = {}) {
  const evidence = requireReason(reason, "prune missing scopes");
  const store = initializeRuntimeStore({ home });
  try {
    const metadata = metadataFromDb(store.db, store.path);
    const missing = readRows(store.db).filter(
      (entry) => !existsSync(entry.cwd),
    );
    if (missing.length === 0) {
      return { removed: [], generation: metadata.generation };
    }
    const changedAt = now();
    const nextGeneration = metadata.generation + 1;
    store.db.exec("BEGIN IMMEDIATE");
    try {
      const deleteScope = store.db.prepare(
        "DELETE FROM scope_registry WHERE scope_id = ?",
      );
      for (const entry of missing) {
        deleteScope.run(entry.scope_id);
      }
      store.db
        .prepare(
          "UPDATE scope_registry_metadata SET generation=?, updated_at=? WHERE id=1",
        )
        .run(nextGeneration, changedAt);
      store.db.exec("COMMIT");
    } catch (err) {
      try {
        store.db.exec("ROLLBACK");
      } catch {
        // Preserve original error.
      }
      throw err;
    }
    return {
      removed: missing,
      generation: nextGeneration,
      actor,
      reason: evidence,
    };
  } finally {
    store.close();
  }
}

export function explainScopeRegistryV2({ home = helmHome(), scopeId } = {}) {
  const id = normalizeKnownScopeId(scopeId);
  const registry = listScopeRegistryV2({ home });
  const entry = registry.entries.find((candidate) => candidate.scope_id === id);
  if (!entry) {
    return {
      scope_id: id,
      generation: registry.metadata.generation,
      dispatchable: false,
      reason: "not_registered",
      entry: null,
    };
  }
  let reason = "dispatch_enabled";
  let dispatchable = true;
  if (entry.quarantine_state === "quarantined") {
    reason = "quarantined";
    dispatchable = false;
  } else if (entry.dispatch_state !== "enabled") {
    reason = "dispatch_disabled";
    dispatchable = false;
  } else if (!existsSync(entry.cwd)) {
    reason = "scope_cwd_missing";
    dispatchable = false;
  }
  return {
    scope_id: id,
    generation: registry.metadata.generation,
    dispatchable,
    reason,
    entry,
  };
}
