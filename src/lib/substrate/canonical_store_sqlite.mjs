/**
 * canonical_store_sqlite.mjs — Phase 1B SQLite engine for canonical state.
 *
 * Implements the same accessor/mutator surface as canonical_store.mjs but
 * reads/writes from the canonical tables in the installation runtime database.
 *
 * Each exported function accepts an optional opts argument:
 *   opts.home         — helm home dir (defaults to helmHome())
 *   opts.path         — runtime store path (defaults to runtimeStorePath(home))
 *   opts._readCounter — { increment() } test hook; asserts indexed reads, no full scan
 *
 * Message payloads and their uniqueness metadata are committed together.
 */

import { helmHome } from "../store.mjs";
import { runtimeStorePath, withRuntimeStore } from "../runtime_store.mjs";
import { withRuntimeStoreTransactionRetry } from "../runtime_store_retry.mjs";

// Message-index engine extracted to satisfy the 400-line file-size gate.
export {
  getMessage,
  listMessages,
  listMessagesForThread,
  findMessageByIdempotencyKey,
  mirrorMessageIndex,
  backfillMessageIndex,
  appendMessageIdempotent,
  findInboundMessageIdByExternalId,
} from "./canonical_store_sqlite_messages.mjs";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function defaultStoreArgs(opts) {
  const home = opts?.home ?? helmHome();
  return { home, path: opts?.path ?? runtimeStorePath(home) };
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Thread engine
// ---------------------------------------------------------------------------

/**
 * Upsert a thread into canonical_threads.
 *
 * @param {object} scope  — { scope_id }
 * @param {object} thread — thread record
 * @param {object} [opts] — { home?, path? }
 * @returns {object} the persisted record
 */
export function upsertThread(scope, thread, opts) {
  const storeArgs = defaultStoreArgs(opts);
  const now = nowIso();
  const scopeId = scope.scope_id;

  const result = withRuntimeStoreTransactionRetry(
    storeArgs,
    { context: { stage: "upsertThread" } },
    (db) => {
      const existing = db
        .prepare(
          "SELECT payload FROM canonical_threads WHERE scope_id=? AND thread_id=?",
        )
        .get(scopeId, thread.thread_id);
      const prior = existing ? JSON.parse(existing.payload) : null;
      const next = {
        ...prior,
        ...thread,
        created_at: prior?.created_at || thread.created_at,
        last_active_at: thread.last_active_at || thread.created_at,
      };
      db.prepare(
        `
        INSERT INTO canonical_threads
          (scope_id, thread_id, payload, owner_session_id, external_thread_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, thread_id) DO UPDATE SET
          payload            = excluded.payload,
          owner_session_id   = excluded.owner_session_id,
          external_thread_id = excluded.external_thread_id,
          updated_at         = excluded.updated_at
      `,
      ).run(
        scopeId,
        thread.thread_id,
        JSON.stringify(next),
        next.owner_session_id ?? null,
        next.external_thread_id ?? null,
        now,
      );
      return next;
    },
  );

  if (!result.ok) {
    process.stderr.write(
      `[canonical_store_sqlite] upsertThread busy scope=${scopeId} thread=${thread.thread_id}\n`,
    );
    return { ...thread, created_at: thread.created_at };
  }
  return result.value;
}

/**
 * Get a thread by ID from canonical_threads.
 *
 * @param {object} scope    — { scope_id }
 * @param {string} threadId
 * @param {object} [opts]   — { home?, path? }
 * @returns {object|null}
 */
export function getThread(scope, threadId, opts) {
  if (!threadId) return null;
  const storeArgs = defaultStoreArgs(opts);
  const row = withRuntimeStore(storeArgs, (db) =>
    db
      .prepare(
        "SELECT payload FROM canonical_threads WHERE scope_id=? AND thread_id=?",
      )
      .get(scope.scope_id, threadId),
  );
  if (!row) return null;
  try {
    return JSON.parse(row.payload);
  } catch {
    return null;
  }
}

/**
 * List all threads for a workspace scope.
 *
 * @param {object}      scope  — { scope_id }
 * @param {string|null} since  — ISO; filter by last_active_at
 * @param {object}      [opts] — { home?, path? }
 * @returns {object[]}
 */
export function listThreadsForWorkspace(scope, since, opts) {
  const storeArgs = defaultStoreArgs(opts);
  const rows = withRuntimeStore(storeArgs, (db) =>
    db
      .prepare("SELECT payload FROM canonical_threads WHERE scope_id=?")
      .all(scope.scope_id),
  );
  const out = [];
  for (const row of rows) {
    try {
      const t = JSON.parse(row.payload);
      if (t.workspace_id !== scope.scope_id) continue;
      if (since && t.last_active_at < since) continue;
      out.push(t);
    } catch {
      // skip malformed row
    }
  }
  out.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return out;
}

// ---------------------------------------------------------------------------
// Transport-state engine
// ---------------------------------------------------------------------------

function applyTransportPatch(prior, messageId, patch) {
  return {
    ...(prior ?? { message_id: messageId }),
    ...patch,
    message_id: messageId,
    last_attempt_at: patch.last_attempt_at || new Date().toISOString(),
  };
}

function writeTransportRow(db, scopeId, messageId, next, now) {
  db.prepare(
    `
    INSERT INTO canonical_transport_state
      (scope_id, message_id, payload, dispatch_decision, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(scope_id, message_id) DO UPDATE SET
      payload           = excluded.payload,
      dispatch_decision = excluded.dispatch_decision,
      updated_at        = excluded.updated_at
  `,
  ).run(
    scopeId,
    messageId,
    JSON.stringify(next),
    next.dispatch_decision ?? null,
    now,
  );
}

function bindExternalMessageIdentity(db, scopeId, messageId, next) {
  if (next.transport !== "email" || !next.external_id) return;
  db.prepare(
    `UPDATE canonical_message_index
       SET external_message_id = COALESCE(external_message_id, ?)
     WHERE scope_id=? AND message_id=?`,
  ).run(next.external_id, scopeId, messageId);
}

/**
 * Get a transport-state entry.
 *
 * @param {object} scope     — { scope_id }
 * @param {string} messageId
 * @param {object} [opts]    — { home?, path? }
 * @returns {object|null}
 */
export function getTransportState(scope, messageId, opts) {
  if (!messageId) return null;
  const storeArgs = defaultStoreArgs(opts);
  const row = withRuntimeStore(storeArgs, (db) =>
    db
      .prepare(
        "SELECT payload FROM canonical_transport_state WHERE scope_id=? AND message_id=?",
      )
      .get(scope.scope_id, messageId),
  );
  if (!row) return null;
  try {
    return JSON.parse(row.payload);
  } catch {
    return null;
  }
}

/**
 * Return all transport-state entries for a scope as a map.
 *
 * @param {object} scope  — { scope_id }
 * @param {object} [opts] — { home?, path? }
 * @returns {{ [messageId: string]: object }}
 */
export function loadTransportStateEntries(scope, opts) {
  const storeArgs = defaultStoreArgs(opts);
  const rows = withRuntimeStore(storeArgs, (db) =>
    db
      .prepare(
        "SELECT message_id, payload FROM canonical_transport_state WHERE scope_id=?",
      )
      .all(scope.scope_id),
  );
  const out = {};
  for (const row of rows) {
    try {
      out[row.message_id] = JSON.parse(row.payload);
    } catch {
      // skip malformed row
    }
  }
  return out;
}

/**
 * Update a transport-state entry (read-modify-write inside a transaction).
 *
 * @param {object} scope     — { scope_id }
 * @param {string} messageId
 * @param {object} patch
 * @param {object} [opts]    — { home?, path? }
 * @returns {object}
 */
export function updateTransportState(scope, messageId, patch, opts) {
  const storeArgs = defaultStoreArgs(opts);
  const now = nowIso();
  const scopeId = scope.scope_id;

  const result = withRuntimeStoreTransactionRetry(
    storeArgs,
    { context: { stage: "updateTransportState" } },
    (db) => {
      const existing = db
        .prepare(
          "SELECT payload FROM canonical_transport_state WHERE scope_id=? AND message_id=?",
        )
        .get(scopeId, messageId);
      const prior = existing ? JSON.parse(existing.payload) : null;
      const next = applyTransportPatch(prior, messageId, patch);
      bindExternalMessageIdentity(db, scopeId, messageId, next);
      writeTransportRow(db, scopeId, messageId, next, now);
      return next;
    },
  );

  if (!result.ok) {
    process.stderr.write(
      `[canonical_store_sqlite] updateTransportState busy scope=${scopeId} msg=${messageId}\n`,
    );
    return applyTransportPatch(null, messageId, patch);
  }
  return result.value;
}

/**
 * Write a transport-state row directly using an already-computed record.
 * Used by the shim's mirror and fallback paths to avoid a redundant SQLite RMW.
 *
 * @param {object} scope     — { scope_id }
 * @param {string} messageId
 * @param {object} record    — the fully-computed next record (from JSONL path)
 * @param {object} [opts]    — { home?, path? }
 * @returns {object}
 */
export function writeTransportStateDirect(scope, messageId, record, opts) {
  const storeArgs = defaultStoreArgs(opts);
  const now = nowIso();
  const scopeId = scope.scope_id;

  const result = withRuntimeStoreTransactionRetry(
    storeArgs,
    { context: { stage: "writeTransportStateDirect" } },
    (db) => {
      bindExternalMessageIdentity(db, scopeId, messageId, record);
      writeTransportRow(db, scopeId, messageId, record, now);
      return record;
    },
  );

  if (!result.ok) {
    process.stderr.write(
      `[canonical_store_sqlite] writeTransportStateDirect busy scope=${scopeId} msg=${messageId}\n`,
    );
  }
  return record;
}

/**
 * Atomic read-modify-write for transport state under BEGIN IMMEDIATE.
 * Concurrent mutators on the same key serialize — no lost update.
 *
 * NOTE: Not called by the production shim (canonical_store.mjs uses
 * writeTransportStateDirect with the already-computed value from the JSONL
 * mutex path).  Kept for direct-engine tests and future callers that need
 * a pure-SQLite RMW without a JSONL source-of-truth.
 * Consuming task: Phase 2.5 shadow-compare soak.
 *
 * @param {object}   scope     — { scope_id }
 * @param {string}   messageId
 * @param {Function} mutator   — (prior) => patch
 * @param {object}   [opts]    — { home?, path? }
 * @returns {object}
 */
export function mutateTransportState(scope, messageId, mutator, opts) {
  const storeArgs = defaultStoreArgs(opts);
  const now = nowIso();
  const scopeId = scope.scope_id;

  const result = withRuntimeStoreTransactionRetry(
    storeArgs,
    { context: { stage: "mutateTransportState" } },
    (db) => {
      const existing = db
        .prepare(
          "SELECT payload FROM canonical_transport_state WHERE scope_id=? AND message_id=?",
        )
        .get(scopeId, messageId);
      const prior = existing
        ? JSON.parse(existing.payload)
        : { message_id: messageId };
      // Structural clone matches canonical_store.mjs semantics.
      const patch = mutator(structuredClone(prior)) || {};
      const next = applyTransportPatch(prior, messageId, patch);
      bindExternalMessageIdentity(db, scopeId, messageId, next);
      writeTransportRow(db, scopeId, messageId, next, now);
      return next;
    },
  );

  if (!result.ok) {
    process.stderr.write(
      `[canonical_store_sqlite] mutateTransportState busy scope=${scopeId} msg=${messageId}\n`,
    );
    const patch = mutator({ message_id: messageId }) || {};
    return applyTransportPatch(null, messageId, patch);
  }
  return result.value;
}
