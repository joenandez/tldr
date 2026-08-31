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
      CREATE INDEX IF NOT EXISTS provider_acceptance_conversation
        ON provider_acceptance(conversation_id);
      CREATE INDEX IF NOT EXISTS provider_acceptance_thread
        ON provider_acceptance(external_thread_id);`);
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
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

async function recordProviderMap(home, record) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const db = openProviderMap(home);
  try {
    db.exec("BEGIN IMMEDIATE");
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

function lookupProviderMap(home, column, value) {
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

export function createTightbeamEmailDeliveryChannel({
  execute,
  readIdentity,
  home,
  commandFailure,
  authority,
  principalRef,
  endpointSession,
} = {}) {
  async function registeredEmailIdentity() {
    const identity = await readIdentity();
    if (!identity) return null;
    const principal = await execute({
      admin: false,
      credentials: identity,
      args: [
        "principal",
        "register",
        "--authority",
        authority,
        "--external-ref",
        principalRef,
        "--display-name",
        "Owner",
      ],
    });
    if (
      commandFailure(principal) ||
      typeof principal.result?.principal_id !== "string"
    )
      return null;
    const endpoint = await execute({
      admin: false,
      credentials: identity,
      args: [
        "endpoint",
        "register",
        "--authority",
        authority,
        "--principal",
        principal.result.principal_id,
        "--runtime",
        "reference",
        "--session",
        endpointSession,
        "--reference",
        authority,
      ],
    });
    if (
      commandFailure(endpoint) ||
      typeof endpoint.result?.endpoint_id !== "string"
    )
      return null;
    return { identity, endpoint: endpoint.result };
  }

  async function claimEmailDelivery() {
    const emailIdentity = await registeredEmailIdentity();
    if (!emailIdentity)
      return Object.freeze({ ok: false, code: "not_configured" });
    const routes = await execute({
      admin: false,
      credentials: emailIdentity.identity,
      args: ["channel", "route", "list"],
    });
    const route = routes?.result?.routes?.find(
      (candidate) => candidate?.selector === "email",
    );
    if (commandFailure(routes) || !route) {
      return Object.freeze({ ok: false, code: "route_unavailable" });
    }
    const claimed = await execute({
      admin: false,
      credentials: emailIdentity.identity,
      args: [
        "delivery",
        "claim",
        "--endpoint",
        emailIdentity.endpoint.endpoint_id,
        "--channel-route",
        route.route_id,
      ],
    });
    return commandFailure(claimed)
      ? Object.freeze({ ok: false, code: "claim_unavailable" })
      : Object.freeze({ ok: true, claim: claimed.result });
  }

  async function completeEmailDelivery({
    delivery_id: deliveryId,
    token,
    outcome,
  }) {
    const identity = await readIdentity();
    if (!identity) return Object.freeze({ ok: false, code: "not_configured" });
    const completed = await execute({
      admin: false,
      credentials: identity,
      args: [
        "delivery",
        "complete",
        deliveryId,
        "--token",
        token,
        "--outcome",
        outcome,
      ],
    });
    return commandFailure(completed)
      ? Object.freeze({ ok: false, code: "complete_failed" })
      : Object.freeze({ ok: true });
  }

  async function recordProviderAcceptance({ delivery, provider }) {
    const identity = await readIdentity();
    if (!identity) throw new Error("Tightbeam email identity is unavailable");
    const routes = await execute({
      admin: false,
      credentials: identity,
      args: ["channel", "route", "list"],
    });
    const route = routes?.result?.routes?.find(
      (candidate) => candidate?.selector === "email",
    );
    if (commandFailure(routes) || !route)
      throw new Error("Tightbeam email route is unavailable");
    await recordProviderMap(home, {
      delivery_id: delivery.delivery_id,
      message_id: delivery.message_id,
      conversation_id: delivery.message.conversation_id,
      route_id: route.route_id,
      origin_endpoint_id:
        typeof delivery.message?.sender_endpoint_id === "string"
          ? delivery.message.sender_endpoint_id
          : null,
      origin_session_id:
        typeof delivery.message?.sender_session_id === "string"
          ? delivery.message.sender_session_id
          : null,
      external_id: provider.external_id,
      external_thread_id: provider.external_thread_id,
    });
  }

  async function findThreadBinding(externalThreadId) {
    const record = lookupProviderMap(
      home,
      "external_thread_id",
      externalThreadId,
    );
    return record
      ? {
          conversation_id: record.conversation_id,
          route_id: record.route_id,
          ...(typeof record.origin_endpoint_id === "string"
            ? { origin_endpoint_id: record.origin_endpoint_id }
            : {}),
          ...(typeof record.origin_session_id === "string"
            ? { origin_session_id: record.origin_session_id }
            : {}),
        }
      : null;
  }
  async function findProviderAcceptanceByDelivery(deliveryId) {
    const record = lookupProviderMap(home, "delivery_id", deliveryId);
    return record
      ? {
          external_id: record.external_id,
          external_thread_id: record.external_thread_id,
        }
      : null;
  }
  async function findProviderThreadByConversation(conversationId) {
    const record = lookupProviderMap(home, "conversation_id", conversationId);
    return record
      ? {
          external_id: record.external_id,
          external_thread_id: record.external_thread_id,
        }
      : null;
  }
  return Object.freeze({
    claimEmailDelivery,
    completeEmailDelivery,
    recordProviderAcceptance,
    findProviderAcceptanceByDelivery,
    findThreadBinding,
    findProviderThreadByConversation,
  });
}
