// Idempotency for message.commit (drive-liveness T5). A plain commit replays
// only an identical payload under its key. A commit that carries an explicit
// `action_id` is keyed by (app, sender principal, requester namespace, action id) alone: the
// namespace is the requester's Academy agent name, so another session of the
// same agent and principal replays it, and the endpoint id when the endpoint has no name.
// Two principals may share an Academy name, so the principal is part of the key.
// A repeat whose payload differs still returns the original, flagged. The CLI first asks
// message.action_replay, so a replay never resolves or registers a recipient.

import { createHash } from "node:crypto";
import { TightbeamError } from "../protocol/envelope.mjs";
import {
  reconstructResult,
  requireActingEndpoint,
} from "./lifecycle_transition.mjs";
import { requirePrincipal, resolveSendBranch } from "./ops/message_shared.mjs";

/** The idempotency key for a request: its action-id key, or the caller's own. */
export function commitIdempotencyKey(
  db,
  { appId, request, effect, senderPrincipalId },
) {
  if (request.action_id === undefined) return request.idempotency_key;
  if (
    typeof request.action_id !== "string" ||
    request.action_id.length === 0 ||
    effect.type !== "open"
  ) {
    throw new TightbeamError(
      "malformed_request",
      "action_id must be a non-empty string on an open effect",
      { field: "action_id" },
    );
  }
  requireActingEndpoint(db, {
    appId,
    senderPrincipalId,
    senderEndpointId: effect.sender_endpoint_id,
    processGeneration: effect.process_generation,
  });
  const name = db
    .prepare("SELECT academy_agent_name AS n FROM endpoints WHERE id = ?")
    .get(effect.sender_endpoint_id)?.n;
  const namespace = name
    ? `agent:${name}`
    : `endpoint:${effect.sender_endpoint_id}`;
  const digest = createHash("sha256")
    .update(
      JSON.stringify([appId, senderPrincipalId, namespace, request.action_id]),
    )
    .digest("hex");
  return `action:${digest.slice(0, 32)}`;
}

// The sender's own session fields are not "args": a retry from another session of the same agent carries different ones.
// Nor is the resolved target when the request carries the raw `--to` the caller typed (compared through
// the metadata): `new:` and `academy:` resolve to a fresh endpoint on every retry.
const SESSION_FIELDS = ["sender_endpoint_id", "process_generation"];
const TARGET_FIELDS = ["target_principal_id", "target_endpoint_id"];
const without = (effect, fields) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(effect).filter(([key]) => !fields.includes(key)),
    ),
  );

// Subject and reason live on the conversation, not in the message: the repeat's come from its inline metadata or the conversation it named.
const subjectAndReason = (db, conversationId, inline) => {
  const metadata =
    inline ??
    JSON.parse(
      db
        .prepare("SELECT metadata FROM conversations WHERE id = ?")
        .get(conversationId)?.metadata ?? "{}",
    );
  return JSON.stringify([metadata.subject, metadata.reason]);
};

function argsDiffer(db, existing, { request, effect }) {
  const stored = db
    .prepare("SELECT effect_payload FROM message_effects WHERE message_id = ?")
    .get(existing.id);
  const declaration = JSON.parse(stored.effect_payload).declaration;
  const fields =
    typeof request.metadata?.tightbeam_agent?.request_to === "string"
      ? [...SESSION_FIELDS, ...TARGET_FIELDS]
      : SESSION_FIELDS;
  return (
    existing.body !== request.body ||
    existing.metadata !== JSON.stringify(request.metadata ?? {}) ||
    without(declaration, fields) !== without(effect, fields) ||
    subjectAndReason(db, existing.conversation_id, null) !==
      subjectAndReason(
        db,
        request.conversation_id,
        request.conversation_metadata ?? null,
      )
  );
}

/** The message already committed under `idempotencyKey`, or null. A different payload is a collision unless `byAction`, which returns it (flagged when the args differ). */
export function findIdempotentReplay(
  db,
  { appId, idempotencyKey, hashes, byAction = null },
) {
  const existing = db
    .prepare(
      "SELECT id, conversation_id, payload_hash, body, metadata FROM messages WHERE app_id = ? AND idempotency_key = ?",
    )
    .get(appId, idempotencyKey);
  if (!existing) return null;
  if (hashes.includes(existing.payload_hash)) return existing;
  if (byAction)
    return { ...existing, argsDiffer: argsDiffer(db, existing, byAction) };
  throw new TightbeamError(
    "idempotency_collision",
    `idempotency_key "${idempotencyKey}" was already used with a different payload`,
    { field: "idempotency_key" },
  );
}

/**
 * message.action_replay: a read-only lookup of the work an action id already opened, asked before
 * the CLI resolves or registers a recipient, so a retry allocates nothing. It answers with the same
 * replay a commit would, `replay: false` when the action id is new.
 * shortcut: two first-time retries racing before either commits can both allocate a recipient
 * (the commit itself still replays one request); closing that needs allocation inside the commit.
 */
export const messageActionReplayOp = {
  name: "message.action_replay",
  allowedScopes: ["agent"],
  permission: "send_as_principal",
  handler(context, payload, connection) {
    const text = (field) => {
      if (typeof payload?.[field] !== "string" || payload[field].length === 0)
        throw new TightbeamError(
          "malformed_request",
          `${field} is required and must be a non-empty string`,
          { field },
        );
      return payload[field];
    };
    const senderPrincipalId = text("sender_principal_id");
    // The same sender-authority check commit makes: a lookup is no wider than a send.
    if (
      resolveSendBranch(
        connection,
        requirePrincipal(context.db, senderPrincipalId, "sender_principal_id"),
      ) !== "agent"
    )
      throw new TightbeamError(
        "permission_denied",
        "send_as_principal for this sender's authority is required",
      );
    const declared = payload.obligation_effect;
    if (!Number.isInteger(declared?.process_generation))
      throw new TightbeamError(
        "malformed_request",
        "obligation_effect.process_generation is required",
        { field: "obligation_effect.process_generation" },
      );
    const effect = {
      type: "open",
      completion_mode: declared.completion_mode,
      sender_endpoint_id: declared.sender_endpoint_id,
      process_generation: declared.process_generation,
    };
    const request = {
      action_id: text("action_id"),
      body: text("body"),
      metadata: payload.metadata,
      conversation_metadata: payload.conversation_metadata,
    };
    const startedAt = Date.now();
    const replay = findIdempotentReplay(context.db, {
      appId: connection.appId,
      idempotencyKey: commitIdempotencyKey(context.db, {
        appId: connection.appId,
        request,
        effect,
        senderPrincipalId,
      }),
      hashes: [],
      byAction: { request, effect },
    });
    context.logger?.info({
      event: "action_replay_lookup",
      params: { sender_principal_id: senderPrincipalId },
      result: { replay: Boolean(replay), args_differ: replay?.argsDiffer },
      status: "ok",
      latency_ms: Date.now() - startedAt,
    });
    if (!replay) return { result: { replay: false } };
    return {
      result: {
        replay: true,
        ...reconstructResult(context.db, {
          messageId: replay.id,
          conversationId: replay.conversation_id,
          idempotentReplay: true,
        }),
        ...(replay.argsDiffer ? { replay_args_differ: true } : {}),
      },
    };
  },
};
