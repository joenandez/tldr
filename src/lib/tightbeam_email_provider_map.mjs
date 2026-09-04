import "./node_sqlite_warning.mjs";
import { chmodSync, existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

function providerMapPath(home) {
  return join(home, "tightbeam-email-provider-map.sqlite");
}

function secureProviderMapFiles(path) {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(candidate)) chmodSync(candidate, 0o600);
  }
}

function openProviderMap(home, { readOnly = false } = {}) {
  const path = providerMapPath(home);
  if (readOnly && !existsSync(path)) return null;
  const db = new DatabaseSync(path, readOnly ? { readOnly: true } : {});
  try {
    if (!readOnly) {
      secureProviderMapFiles(path);
      db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
      secureProviderMapFiles(path);
      db.exec(`CREATE TABLE IF NOT EXISTS provider_acceptance (
        delivery_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        route_id TEXT NOT NULL,
        origin_endpoint_id TEXT,
        origin_session_id TEXT,
        external_id TEXT NOT NULL,
        external_thread_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_reply_binding (
        delivery_id TEXT PRIMARY KEY,
        reply_binding TEXT NOT NULL,
        conversation_id TEXT,
        external_id TEXT,
        external_thread_id TEXT,
        current_reply_parent_external_id TEXT
      );
      CREATE TABLE IF NOT EXISTS provider_reply_parent_event (
        provider_message_id TEXT PRIMARY KEY,
        provider_thread_id TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        reply_binding TEXT NOT NULL,
        tightbeam_message_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS provider_acceptance_conversation
        ON provider_acceptance(conversation_id);
      CREATE INDEX IF NOT EXISTS provider_acceptance_thread
        ON provider_acceptance(external_thread_id);
      CREATE INDEX IF NOT EXISTS provider_reply_binding_thread
        ON provider_reply_binding(external_thread_id);
      CREATE INDEX IF NOT EXISTS provider_reply_binding_conversation
        ON provider_reply_binding(conversation_id);`);
      const columns = new Set(
        db
          .prepare("PRAGMA table_info(provider_acceptance)")
          .all()
          .map(({ name }) => name),
      );
      if (!columns.has("origin_endpoint_id")) {
        db.exec(
          "ALTER TABLE provider_acceptance ADD COLUMN origin_endpoint_id TEXT",
        );
      }
      if (!columns.has("origin_session_id")) {
        db.exec(
          "ALTER TABLE provider_acceptance ADD COLUMN origin_session_id TEXT",
        );
      }
      const bindingColumns = new Set(
        db
          .prepare("PRAGMA table_info(provider_reply_binding)")
          .all()
          .map(({ name }) => name),
      );
      if (!bindingColumns.has("conversation_id")) {
        db.exec(
          "ALTER TABLE provider_reply_binding ADD COLUMN conversation_id TEXT",
        );
      }
      if (!bindingColumns.has("current_reply_parent_external_id")) {
        db.exec(
          "ALTER TABLE provider_reply_binding ADD COLUMN current_reply_parent_external_id TEXT",
        );
      }
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

async function mutateProviderMap(home, mutate) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const db = openProviderMap(home);
  try {
    db.exec("BEGIN IMMEDIATE");
    mutate(db);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    db.close();
  }
  await chmod(providerMapPath(home), 0o600);
  secureProviderMapFiles(providerMapPath(home));
}

export async function recordProviderReplyBinding(home, delivery) {
  await mutateProviderMap(home, (db) => {
    db.prepare(
      `INSERT INTO provider_reply_binding (delivery_id, reply_binding, conversation_id)
       VALUES (?, ?, ?)
       ON CONFLICT(delivery_id) DO UPDATE SET
         reply_binding = excluded.reply_binding,
         conversation_id = excluded.conversation_id`,
    ).run(
      delivery.delivery_id,
      delivery.reply_binding,
      delivery.message.conversation_id,
    );
  });
}

export async function recordBoundProviderAcceptance(home, delivery, provider) {
  await mutateProviderMap(home, (db) => {
    const binding = db
      .prepare(
        `SELECT conversation_id, current_reply_parent_external_id
           FROM provider_reply_binding WHERE delivery_id = ?`,
      )
      .get(delivery.delivery_id);
    if (!binding) {
      throw new Error(
        "Tightbeam reply binding is not durable before provider acceptance",
      );
    }
    const previous = db
      .prepare(
        `SELECT current_reply_parent_external_id, external_id
           FROM provider_reply_binding
          WHERE conversation_id = ? AND delivery_id <> ?
            AND external_id IS NOT NULL AND external_thread_id = ?
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(
        binding.conversation_id,
        delivery.delivery_id,
        provider.external_thread_id,
      );
    const replyParent =
      binding.current_reply_parent_external_id ||
      previous?.current_reply_parent_external_id ||
      previous?.external_id ||
      provider.external_id;
    const updated = db
      .prepare(
        `UPDATE provider_reply_binding
            SET external_id = ?, external_thread_id = ?,
                current_reply_parent_external_id = ?
          WHERE delivery_id = ?`,
      )
      .run(
        provider.external_id,
        provider.external_thread_id,
        replyParent,
        delivery.delivery_id,
      );
    if (updated.changes !== 1)
      throw new Error("Tightbeam provider acceptance could not be recorded");
  });
}

export async function recordInboundProviderAcceptance(home, record) {
  await mutateProviderMap(home, (db) => {
    const hasProviderThread = typeof record.provider_thread_id === "string";
    const bindings = db
      .prepare(
        `SELECT delivery_id, conversation_id, external_id, external_thread_id
           FROM provider_reply_binding
          WHERE reply_binding = ?${hasProviderThread ? " AND external_thread_id = ?" : ""}`,
      )
      .all(
        record.reply_binding,
        ...(hasProviderThread ? [record.provider_thread_id] : []),
      );
    if (bindings.length !== 1 || typeof bindings[0].external_id !== "string") {
      throw new Error("Tightbeam provider reply binding is not accepted");
    }
    const binding = bindings[0];
    const providerThreadId = binding.external_thread_id;
    if (
      typeof record.tightbeam_conversation_id === "string" &&
      record.tightbeam_conversation_id !== binding.conversation_id
    ) {
      throw new Error(
        "Tightbeam inbound conversation does not match its provider binding",
      );
    }

    const existing = db
      .prepare(
        `SELECT provider_thread_id, delivery_id, reply_binding, tightbeam_message_id
           FROM provider_reply_parent_event
          WHERE provider_message_id = ?`,
      )
      .get(record.provider_message_id);
    if (existing) {
      if (
        existing.provider_thread_id !== providerThreadId ||
        existing.delivery_id !== binding.delivery_id ||
        existing.reply_binding !== record.reply_binding ||
        existing.tightbeam_message_id !== record.tightbeam_message_id
      ) {
        throw new Error(
          "Provider inbound event is bound to different reply authority",
        );
      }
      return;
    }

    db.prepare(
      `INSERT INTO provider_reply_parent_event
        (provider_message_id, provider_thread_id, delivery_id, reply_binding, tightbeam_message_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      record.provider_message_id,
      providerThreadId,
      binding.delivery_id,
      record.reply_binding,
      record.tightbeam_message_id,
    );
    const updated = db
      .prepare(
        `UPDATE provider_reply_binding
            SET current_reply_parent_external_id = ?
          WHERE delivery_id = ? AND reply_binding = ? AND external_thread_id = ?`,
      )
      .run(
        record.provider_message_id,
        binding.delivery_id,
        record.reply_binding,
        providerThreadId,
      );
    if (updated.changes !== 1) {
      throw new Error("Tightbeam provider reply parent could not be advanced");
    }
  });
}

export async function recordProviderMap(home, record) {
  await mutateProviderMap(home, (db) => {
    db.prepare(
      `INSERT INTO provider_acceptance (
      delivery_id, message_id, conversation_id, route_id, external_id, external_thread_id
      , origin_endpoint_id, origin_session_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(delivery_id) DO UPDATE SET
      message_id = excluded.message_id,
      conversation_id = excluded.conversation_id,
      route_id = excluded.route_id,
      origin_endpoint_id = excluded.origin_endpoint_id,
      origin_session_id = excluded.origin_session_id,
      external_id = excluded.external_id,
      external_thread_id = excluded.external_thread_id`,
    ).run(
      record.delivery_id,
      record.message_id,
      record.conversation_id,
      record.route_id,
      record.external_id,
      record.external_thread_id,
      record.origin_endpoint_id,
      record.origin_session_id,
    );
  });
}

export function lookupProviderMap(home, column, value) {
  const db = openProviderMap(home, { readOnly: true });
  if (!db) return null;
  try {
    const latest =
      column === "delivery_id" ? "" : " ORDER BY rowid DESC LIMIT 1";
    return (
      db
        .prepare(
          `SELECT delivery_id, message_id, conversation_id, route_id, origin_endpoint_id, origin_session_id, external_id, external_thread_id FROM provider_acceptance WHERE ${column} = ?${latest}`,
        )
        .get(value) || null
    );
  } finally {
    db.close();
  }
}

export function lookupProviderReplyBinding(home, column, value) {
  const db = openProviderMap(home, { readOnly: true });
  if (!db) return null;
  try {
    const columns = new Set(
      db
        .prepare("PRAGMA table_info(provider_reply_binding)")
        .all()
        .map(({ name }) => name),
    );
    const currentReplyParent = columns.has("current_reply_parent_external_id")
      ? "current_reply_parent_external_id"
      : "external_id AS current_reply_parent_external_id";
    const accepted =
      column === "delivery_id"
        ? ""
        : " AND external_id IS NOT NULL AND external_thread_id IS NOT NULL";
    const latest =
      column === "delivery_id" ? "" : " ORDER BY rowid DESC LIMIT 1";
    return (
      db
        .prepare(
          `SELECT delivery_id, reply_binding, conversation_id, external_id, external_thread_id,
                  ${currentReplyParent}
             FROM provider_reply_binding WHERE ${column} = ?${accepted}${latest}`,
        )
        .get(value) || null
    );
  } finally {
    db.close();
  }
}
