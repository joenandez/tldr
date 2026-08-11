import { helmHome } from "../store.mjs";
import { runtimeStorePath, withRuntimeStore } from "../runtime_store.mjs";
import { withRuntimeStoreTransactionRetry } from "../runtime_store_retry.mjs";

function defaultStoreArgs(opts) {
  const home = opts?.home ?? helmHome();
  return { home, path: opts?.path ?? runtimeStorePath(home) };
}

function parsePayload(row) {
  if (!row?.payload) return null;
  try {
    return JSON.parse(row.payload);
  } catch {
    return null;
  }
}

function selectPayload(db, where, params) {
  return parsePayload(
    db
      .prepare(`SELECT payload FROM canonical_message_index ${where}`)
      .get(...params),
  );
}

function selectExisting(db, scopeId, canonicalRow) {
  if (canonicalRow.idempotency_key) {
    const row = selectPayload(db, "WHERE scope_id=? AND idempotency_key=?", [
      scopeId,
      canonicalRow.idempotency_key,
    ]);
    if (row) return row;
  }
  if (canonicalRow.external_message_id) {
    const row = selectPayload(
      db,
      "WHERE scope_id=? AND external_message_id=?",
      [scopeId, canonicalRow.external_message_id],
    );
    if (row) return row;
  }
  return selectPayload(db, "WHERE scope_id=? AND message_id=?", [
    scopeId,
    canonicalRow.message_id,
  ]);
}

function initialTransportState(messageId, createdAt) {
  return {
    message_id: messageId,
    last_attempt_at: createdAt,
  };
}

export function getMessage(scope, messageId, opts) {
  if (!messageId) return null;
  return withRuntimeStore(defaultStoreArgs(opts), (db) =>
    selectPayload(db, "WHERE scope_id=? AND message_id=?", [
      scope.scope_id,
      messageId,
    ]),
  );
}

export function listMessages(scope, opts) {
  const rows = withRuntimeStore(defaultStoreArgs(opts), (db) =>
    db
      .prepare(
        `SELECT payload FROM canonical_message_index
         WHERE scope_id=? AND payload IS NOT NULL
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(scope.scope_id),
  );
  return rows.map(parsePayload).filter(Boolean);
}

export function listMessagesForThread(scope, threadId, limit, opts) {
  if (!threadId) return [];
  const normalizedLimit =
    limit === null || limit === undefined
      ? null
      : Math.max(0, Math.floor(Number(limit) || 0));
  if (normalizedLimit === 0) return [];
  const rows = withRuntimeStore(defaultStoreArgs(opts), (db) =>
    db
      .prepare(
        `SELECT payload FROM canonical_message_index
         WHERE scope_id=? AND thread_id=? AND payload IS NOT NULL
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(scope.scope_id, threadId),
  );
  const messages = rows.map(parsePayload).filter(Boolean);
  return normalizedLimit === null ? messages : messages.slice(-normalizedLimit);
}

export function findMessageByIdempotencyKey(scope, key, opts) {
  if (!key) return null;
  return withRuntimeStore(defaultStoreArgs(opts), (db) =>
    selectPayload(db, "WHERE scope_id=? AND idempotency_key=?", [
      scope.scope_id,
      key,
    ]),
  );
}

export function appendMessageIdempotent(scope, canonicalRow, opts) {
  const storeArgs = defaultStoreArgs(opts);
  const scopeId = scope.scope_id;
  const createdAt = canonicalRow.created_at ?? new Date().toISOString();
  const result = withRuntimeStoreTransactionRetry(
    storeArgs,
    { context: { stage: "appendMessageIdempotent" } },
    (db) => {
      const existing = selectExisting(db, scopeId, canonicalRow);
      if (existing) return { row: existing, existing: true };

      db.prepare(
        `INSERT OR IGNORE INTO canonical_message_index
          (scope_id, message_id, thread_id, byte_offset, byte_length,
           idempotency_key, external_message_id, created_at, payload)
         VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?)`,
      ).run(
        scopeId,
        canonicalRow.message_id,
        canonicalRow.thread_id,
        canonicalRow.idempotency_key ?? null,
        canonicalRow.external_message_id ?? null,
        createdAt,
        JSON.stringify(canonicalRow),
      );
      const inserted = db.prepare("SELECT changes() AS n").get().n > 0;
      if (!inserted) {
        return {
          row: selectExisting(db, scopeId, canonicalRow),
          existing: true,
        };
      }

      const transport = initialTransportState(
        canonicalRow.message_id,
        createdAt,
      );
      db.prepare(
        `INSERT OR IGNORE INTO canonical_transport_state
          (scope_id, message_id, payload, dispatch_decision, updated_at)
         VALUES (?, ?, ?, NULL, ?)`,
      ).run(
        scopeId,
        canonicalRow.message_id,
        JSON.stringify(transport),
        createdAt,
      );
      return { row: canonicalRow, existing: false };
    },
  );
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

export function mirrorMessageIndex(
  scope,
  canonicalRow,
  _offset,
  _length,
  opts,
) {
  return appendMessageIdempotent(scope, canonicalRow, opts);
}

export function backfillMessageIndex(scope, canonicalRow, opts) {
  return appendMessageIdempotent(scope, canonicalRow, opts);
}

export function findInboundMessageIdByExternalId(scope, externalId, opts) {
  if (!scope || !externalId) return null;
  const row = withRuntimeStore(defaultStoreArgs(opts), (db) =>
    selectPayload(db, "WHERE scope_id=? AND external_message_id=?", [
      scope.scope_id,
      externalId,
    ]),
  );
  return row?.metadata?.source === "inbound_webhook" ? row.message_id : null;
}
