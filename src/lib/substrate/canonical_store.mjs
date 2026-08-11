import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  ensureWorkspaceConfigDir,
  helmHome,
  readJsonIfExists,
  writeJsonAtomic,
} from "../store.mjs";
import * as sqlite from "./canonical_store_sqlite.mjs";
import { createThreadIdentityOperations } from "./canonical_store_sqlite_ownership.mjs";

export const CURRENT_SCHEMA_VERSION = 1;

function helmHomeForScope(scope) {
  const storageRoot =
    typeof scope?.storage_root === "string" ? scope.storage_root : null;
  if (storageRoot && basename(dirname(storageRoot)) === "workspaces") {
    return dirname(dirname(storageRoot));
  }
  return helmHome();
}

function storeOpts(scope) {
  return { home: helmHomeForScope(scope) };
}

export function messagesDir(scope) {
  return join(scope.storage_root, "messages");
}

export function threadsPath(scope) {
  return join(messagesDir(scope), "threads.json");
}

export function messagesJsonlPath(scope) {
  return join(messagesDir(scope), "messages.jsonl");
}

export function transportStatePath(scope) {
  return join(messagesDir(scope), "transport-state.json");
}

export function messagesIndexPath(scope) {
  return join(messagesDir(scope), "messages.index.json");
}

export function schemaVersionPath(scope) {
  return join(messagesDir(scope), "schema_version.json");
}

export function storeLockPaths(scope) {
  return {
    threads: join(messagesDir(scope), ".threads.lock"),
    transportState: join(messagesDir(scope), ".transport-state.lock"),
    messages: join(messagesDir(scope), ".messages.lock"),
  };
}

// Retained only for callers that explicitly manage the pre-cut compatibility
// files. Canonical tldr; operations never call this helper.
export function ensureMessagesDir(scope) {
  ensureWorkspaceConfigDir(scope);
  mkdirSync(messagesDir(scope), { recursive: true });
}

export function readSchemaVersion(scope) {
  const parsed = readJsonIfExists(schemaVersionPath(scope), null);
  return parsed && Number.isFinite(parsed.version) ? parsed.version : null;
}

export function getThread(scope, threadId) {
  return threadId ? sqlite.getThread(scope, threadId, storeOpts(scope)) : null;
}

export function listThreadsForWorkspace(scope, since = null) {
  return sqlite.listThreadsForWorkspace(scope, since, storeOpts(scope));
}

export function upsertThread(scope, thread) {
  return sqlite.upsertThread(scope, thread, storeOpts(scope));
}

export const {
  claimThreadIdentity,
  activateThreadIdentity,
  releaseThreadIdentityClaim,
} = createThreadIdentityOperations({ storeOpts });

export function getMessage(scope, messageId) {
  return messageId
    ? sqlite.getMessage(scope, messageId, storeOpts(scope))
    : null;
}

export function listMessages(scope) {
  return sqlite.listMessages(scope, storeOpts(scope));
}

export function listMessagesForThread(scope, threadId, limit = null) {
  return threadId
    ? sqlite.listMessagesForThread(scope, threadId, limit, storeOpts(scope))
    : [];
}

export function listThreadHistoryMessages(scope, threadId, limit = null) {
  return listMessagesForThread(scope, threadId, limit).map((row) => ({
    id: `message:${row.message_id}`,
    ts: row.created_at || row.scheduled_for || null,
    kind: "message",
    status: row.status || null,
    message_id: row.message_id,
    thread_id: row.thread_id,
    message_kind: row.kind || null,
    transport: row.transport || null,
    target: row.target || null,
    target_class: row.target_class || null,
    subject: row.subject || null,
    reason: row.reason || null,
  }));
}

export function findMessageByIdempotencyKey(scope, key) {
  return key
    ? sqlite.findMessageByIdempotencyKey(scope, key, storeOpts(scope))
    : null;
}

export function appendMessage(scope, canonicalRow) {
  return sqlite.appendMessageIdempotent(scope, canonicalRow, storeOpts(scope))
    .row;
}

export function appendMessageIdempotent(scope, canonicalRow) {
  return sqlite.appendMessageIdempotent(scope, canonicalRow, storeOpts(scope));
}

export function getTransportState(scope, messageId) {
  return messageId
    ? sqlite.getTransportState(scope, messageId, storeOpts(scope))
    : null;
}

export function loadTransportStateEntries(scope) {
  return sqlite.loadTransportStateEntries(scope, storeOpts(scope));
}

export function findInboundMessageIdByExternalId(scope, externalId) {
  return scope && externalId
    ? sqlite.findInboundMessageIdByExternalId(
        scope,
        externalId,
        storeOpts(scope),
      )
    : null;
}

export function updateTransportState(scope, messageId, patch) {
  return sqlite.updateTransportState(scope, messageId, patch, storeOpts(scope));
}

export function mutateTransportState(scope, messageId, mutator) {
  return sqlite.mutateTransportState(
    scope,
    messageId,
    mutator,
    storeOpts(scope),
  );
}

const MIGRATIONS = new Map();

export function registerMigration(toVersion, runner) {
  MIGRATIONS.set(toVersion, runner);
}

export function migrate(scope, toVersion = CURRENT_SCHEMA_VERSION) {
  if (!existsSync(schemaVersionPath(scope))) {
    ensureMessagesDir(scope);
    writeJsonAtomic(schemaVersionPath(scope), {
      version: CURRENT_SCHEMA_VERSION,
      created_at: new Date().toISOString(),
    });
  }
  const current = readSchemaVersion(scope) || CURRENT_SCHEMA_VERSION;
  if (current === toVersion) return { from: current, to: toVersion, ran: [] };
  const ran = [];
  let cursor = current;
  while (cursor < toVersion) {
    const next = cursor + 1;
    const runner = MIGRATIONS.get(next);
    if (!runner) {
      throw new Error(
        `canonical_store.migrate: no migration registered for v${next}`,
      );
    }
    runner(scope);
    ran.push(next);
    cursor = next;
  }
  writeJsonAtomic(schemaVersionPath(scope), {
    version: toVersion,
    created_at: new Date().toISOString(),
  });
  return { from: current, to: toVersion, ran };
}
