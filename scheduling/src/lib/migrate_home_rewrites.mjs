// Store rewrites for `helm-tasks system migrate-home` (see migrate_home.mjs
// for the command contract). Plans every stored path under the old Helm home
// prefix, then applies the registry rewrite in one SQLite transaction and each
// JSON file rewrite as an atomic sibling-temp-then-rename replace.

import { createRequire } from "node:module";
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const REGISTRY_BUSY_TIMEOUT_MS = 5000;

export function emptyRewrites() {
  return {
    scope_registry_storage_root: 0,
    scope_registry_source_json: 0,
    scope_registry_last_backup_path: 0,
    scopes_json: 0,
    workspace_scope_json: 0,
    identity_agentmail_key_path: 0,
  };
}

// Pure: the rewritten value, or null when `value` is not under `from`. Matches
// the prefix on a path boundary so /x/.helm never rewrites /x/.helm-dev-a.
export function rewritePathPrefix(value, from, to) {
  if (typeof value !== "string") return null;
  if (value === from) return to;
  if (value.startsWith(`${from}/`)) return `${to}${value.slice(from.length)}`;
  return null;
}

function rewriteStringsDeep(value, from, to) {
  if (typeof value === "string") {
    const next = rewritePathPrefix(value, from, to);
    return next === null
      ? { value, changed: false }
      : { value: next, changed: true };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const result = rewriteStringsDeep(item, from, to);
      changed ||= result.changed;
      return result.value;
    });
    return { value: out, changed };
  }
  if (value && typeof value === "object") {
    let changed = false;
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      const result = rewriteStringsDeep(child, from, to);
      changed ||= result.changed;
      out[key] = result.value;
    }
    return { value: out, changed };
  }
  return { value, changed: false };
}

export function workspaceDirs(to) {
  try {
    return readdirSync(join(to, "workspaces"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(to, "workspaces", entry.name));
  } catch {
    return [];
  }
}

function readJsonFile(path) {
  const raw = readFileSync(path, "utf8");
  return { raw, parsed: JSON.parse(raw) };
}

// Reads the stores under `root` (the renamed home, or on a pre-rename dry run
// the old one) and plans each value under `from` rewritten to `to`.
export function planFileRewrites({ from, to, root = to, rewrites, skipped }) {
  const writes = [];

  const scopesPath = join(root, "scopes.json");
  if (existsSync(scopesPath)) {
    try {
      const { raw, parsed } = readJsonFile(scopesPath);
      if (Array.isArray(parsed?.scopes)) {
        let count = 0;
        const scopes = parsed.scopes.map((entry) => {
          const next = rewritePathPrefix(entry?.storage_root, from, to);
          if (next === null) return entry;
          count += 1;
          return { ...entry, storage_root: next };
        });
        if (count > 0) {
          rewrites.scopes_json = count;
          writes.push({
            kind: "scopes_json",
            path: scopesPath,
            value: { ...parsed, scopes },
            trailingNewline: raw.endsWith("\n"),
          });
        }
      }
    } catch {
      skipped.push({ path: scopesPath, reason: "unreadable_json" });
    }
  }

  for (const dir of workspaceDirs(root)) {
    const path = join(dir, "scope.json");
    if (!existsSync(path)) continue;
    try {
      const { raw, parsed } = readJsonFile(path);
      const next = rewritePathPrefix(parsed?.storage_root, from, to);
      if (next === null) continue;
      rewrites.workspace_scope_json += 1;
      writes.push({
        kind: "workspace_scope_json",
        path,
        value: { ...parsed, storage_root: next },
        trailingNewline: raw.endsWith("\n"),
      });
    } catch {
      skipped.push({ path, reason: "unreadable_json" });
    }
  }

  const identityPath = join(root, "identity.json");
  if (existsSync(identityPath)) {
    try {
      const { raw, parsed } = readJsonFile(identityPath);
      const next = rewritePathPrefix(parsed?.agentmail_key_path, from, to);
      if (next !== null) {
        rewrites.identity_agentmail_key_path = 1;
        writes.push({
          kind: "identity_agentmail_key_path",
          path: identityPath,
          value: { ...parsed, agentmail_key_path: next },
          trailingNewline: raw.endsWith("\n"),
        });
      }
    } catch {
      skipped.push({ path: identityPath, reason: "unreadable_json" });
    }
  }

  return writes;
}

function tableExists(db, name) {
  return Boolean(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name),
  );
}

function openRegistryDb(path, { readOnly }) {
  const { DatabaseSync } = require("node:sqlite");
  const db = readOnly
    ? new DatabaseSync(path, { readOnly: true })
    : new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout = ${REGISTRY_BUSY_TIMEOUT_MS}`);
  return db;
}

// Reads the registry and returns the planned row updates. Runs inside the
// write transaction on a real run so the plan and the write see one snapshot.
function planRegistryRewrites(db, { from, to, rewrites }) {
  const rowUpdates = [];
  let backupPath = null;
  if (tableExists(db, "scope_registry")) {
    const rows = db
      .prepare("SELECT scope_id, storage_root, source_json FROM scope_registry")
      .all();
    for (const row of rows) {
      const nextRoot = rewritePathPrefix(row.storage_root, from, to);
      let nextSource = null;
      if (typeof row.source_json === "string" && row.source_json) {
        try {
          const result = rewriteStringsDeep(JSON.parse(row.source_json), from, to);
          if (result.changed) nextSource = JSON.stringify(result.value);
        } catch {
          // Unparseable provenance stays as stored.
        }
      }
      if (nextRoot === null && nextSource === null) continue;
      if (nextRoot !== null) rewrites.scope_registry_storage_root += 1;
      if (nextSource !== null) rewrites.scope_registry_source_json += 1;
      rowUpdates.push({
        scope_id: row.scope_id,
        storage_root: nextRoot ?? row.storage_root,
        source_json: nextSource ?? row.source_json,
      });
    }
  }
  if (tableExists(db, "scope_registry_metadata")) {
    const meta = db
      .prepare(
        "SELECT generation, last_backup_path FROM scope_registry_metadata WHERE id = 1",
      )
      .get();
    const next = rewritePathPrefix(meta?.last_backup_path, from, to);
    if (next !== null) {
      rewrites.scope_registry_last_backup_path = 1;
      backupPath = next;
    }
  }
  return { rowUpdates, backupPath };
}

function countHistoryReferences(db, from) {
  if (!tableExists(db, "logical_runs")) return 0;
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM logical_runs WHERE metadata_json IS NOT NULL AND instr(metadata_json, ?) > 0",
    )
    .get(`${from}/`);
  return Number(row?.n || 0);
}

function applyRegistryRewrites(db, { rowUpdates, backupPath }, now) {
  if (rowUpdates.length === 0 && backupPath === null) return;
  const meta = db
    .prepare("SELECT generation FROM scope_registry_metadata WHERE id = 1")
    .get();
  const nextGeneration = Number(meta?.generation || 0) + 1;
  const update = db.prepare(
    "UPDATE scope_registry SET storage_root = ?, source_json = ?, generation = ?, updated_at = ? WHERE scope_id = ?",
  );
  for (const row of rowUpdates) {
    update.run(row.storage_root, row.source_json, nextGeneration, now, row.scope_id);
  }
  if (backupPath !== null) {
    db.prepare(
      "UPDATE scope_registry_metadata SET last_backup_path = ? WHERE id = 1",
    ).run(backupPath);
  }
  if (meta) {
    db.prepare(
      "UPDATE scope_registry_metadata SET generation = ?, updated_at = ? WHERE id = 1",
    ).run(nextGeneration, now);
  }
}

function writeJsonFileAtomic({ path, value, trailingNewline }) {
  const mode = statSync(path).mode & 0o777;
  const tmp = `${path}.migrate-home.${process.pid}.${Date.now()}.tmp`;
  const text = `${JSON.stringify(value, null, 2)}${trailingNewline ? "\n" : ""}`;
  try {
    writeFileSync(tmp, text, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// Rewrites the registry rows (planned inside the write transaction so plan and
// write see one snapshot) and counts history rows that still name the old
// prefix. A dry run opens the database read-only and only plans.
export function rewriteRegistry(dbPath, { from, to, rewrites, dryRun, now }) {
  const result = { historyReferences: 0, committedLatencyMs: null };
  if (!existsSync(dbPath)) return result;
  const db = openRegistryDb(dbPath, { readOnly: Boolean(dryRun) });
  try {
    if (dryRun) {
      planRegistryRewrites(db, { from, to, rewrites });
    } else {
      const started = Date.now();
      db.exec("BEGIN IMMEDIATE");
      try {
        applyRegistryRewrites(db, planRegistryRewrites(db, { from, to, rewrites }), now());
        db.exec("COMMIT");
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Preserve the original failure.
        }
        throw err;
      }
      result.committedLatencyMs = Date.now() - started;
    }
    result.historyReferences = countHistoryReferences(db, from);
    return result;
  } finally {
    db.close();
  }
}

// Writes the planned file rewrites in order. On failure the error carries how
// many were written; a rerun finishes the rest because the command is idempotent.
export function writeFileRewrites(fileWrites) {
  let written = 0;
  try {
    for (const write of fileWrites) {
      writeJsonFileAtomic(write);
      written += 1;
    }
  } catch (err) {
    err.written = written;
    throw err;
  }
  return written;
}

export const _internals = { rewriteStringsDeep };
