// Transfer: the holder of a root's open attempt hands the work itself to
// another session. It is recovery.switch (same ledger operation, same
// supersession, same routing) plus three things that only a holder-driven
// transfer needs, all inside the switch transaction: holder-only
// authorization, admission of the target to the thread, and one message that
// tells the superseded holder and carries the transfer body to the target.

import { TightbeamError } from "../protocol/envelope.mjs";
import {
  requireActingEndpoint,
  requireCustody,
  requireRecoverableRoot,
  runRecoveryCommand,
} from "./lifecycle_transition.mjs";
import {
  createNoticeDeliveries,
  insertMessage,
  payloadHash,
  requirePrincipal,
  resolveSendBranch,
} from "./ops/message_shared.mjs";

const TRANSFER_ROUTE_REASON = "recovery.switch";

function requireString(request, field) {
  const value = request?.[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new TightbeamError(
      "malformed_request",
      `${field} is required and must be a non-empty string`,
      { field },
    );
  }
  return value;
}

/** The target's process generation comes from its own row, never from the caller. */
function readTarget(db, { appId, targetEndpointId }) {
  const target = db
    .prepare(
      "SELECT id, principal_id, process_generation FROM endpoints WHERE id = ? AND created_by_app_id = ?",
    )
    .get(targetEndpointId, appId);
  if (!target) {
    throw new TightbeamError(
      "endpoint_unknown",
      `no endpoint "${targetEndpointId}" is visible to this application`,
      { field: "target_endpoint_id" },
    );
  }
  if (target.process_generation === null) {
    throw new TightbeamError(
      "obligation_conflict",
      `endpoint "${target.id}" has no adopted runtime process to transfer to`,
      { field: "target_endpoint_id" },
    );
  }
  return target;
}

function requireHolder(context, connection, { root, request }) {
  const principal = requirePrincipal(
    context.db,
    request.sender_principal_id,
    "sender_principal_id",
  );
  const origin = resolveSendBranch(connection, principal);
  if (!origin) {
    throw new TightbeamError(
      "permission_denied",
      "send_as_principal is required for this sender",
      { field: "sender_principal_id" },
    );
  }
  requireActingEndpoint(context.db, {
    appId: connection.appId,
    senderPrincipalId: principal.id,
    senderEndpointId: request.sender_endpoint_id,
    processGeneration: request.process_generation,
  });
  try {
    requireCustody(context.db, {
      node: root,
      senderEndpointId: request.sender_endpoint_id,
    });
  } catch (error) {
    if (error.code !== "obligation_conflict") throw error;
    throw new TightbeamError(
      "obligation_conflict",
      "only the session that holds this work can transfer it",
      { field: "sender_endpoint_id" },
    );
  }
  if (request.target_endpoint_id === request.sender_endpoint_id) {
    throw new TightbeamError(
      "obligation_conflict",
      "the work is already held by this endpoint",
      { field: "target_endpoint_id" },
    );
  }
  refuseOpenDelegation(context, { root, request });
  return origin;
}

// recovery.switch supersedes every open delegation under the attempt, and the
// transfer message reaches only the target and the old holder (AC-28). A
// nested delegation is open only while its parent is, so one level is enough.
function refuseOpenDelegation(context, { root, request }) {
  const delegation = context.db
    .prepare(
      `SELECT d.id FROM obligations d JOIN obligations a ON d.parent_id = a.id
        WHERE a.parent_id = ? AND a.role = 'attempt' AND a.status = 'open' AND a.custodian_endpoint_id = ?
          AND d.role = 'delegation' AND d.status = 'open'
        ORDER BY d.created_at, d.id LIMIT 1`,
    )
    .get(root.id, request.sender_endpoint_id);
  if (!delegation) return;
  context.logger?.warn?.({
    event: "transfer_refused",
    params: { root_obligation_id: root.id, delegation_id: delegation.id },
    result: { reason: "open_delegation" },
    status: "refused",
  });
  throw new TightbeamError(
    "obligation_conflict",
    `work "${root.id}" has open delegation "${delegation.id}"; a transfer would close it without telling its holder. Transfer after that delegation is completed or declined.`,
    {
      field: "root_obligation_id",
      reason: "open_delegation",
      delegation_id: delegation.id,
    },
  );
}

function admitTargetParticipant(context, { root, target }) {
  const admitted = context.db
    .prepare(
      "INSERT INTO conversation_participants (conversation_id, principal_id, role, added_at) VALUES (?, ?, NULL, ?) ON CONFLICT DO NOTHING",
    )
    .run(
      root.conversation_id,
      target.principal_id,
      new Date().toISOString(),
    ).changes;
  context.logger?.info({
    event: "transfer_participant_admission",
    params: {
      conversation_id: root.conversation_id,
      principal_id: target.principal_id,
      target_endpoint_id: target.id,
    },
    result: { admitted: admitted === 1 },
    status: "ok",
  });
}

function sendTransferMessage(context, connection, { root, request, origin }) {
  const body =
    request.body ??
    `Work ${root.id} is transferred from ${request.sender_endpoint_id} to ${request.target_endpoint_id}.`;
  const key = `transfer:${request.idempotency_key}`;
  const openingId =
    context.db
      .prepare(
        "SELECT message_id FROM message_effects WHERE effect = 'open' AND obligation_id = ?",
      )
      .get(root.id)?.message_id ?? null;
  const messageId = insertMessage(context.db, {
    conversationId: root.conversation_id,
    appId: connection.appId,
    senderPrincipalId: request.sender_principal_id,
    kind: "commit",
    body,
    metadata: {
      transfer: {
        root_obligation_id: root.id,
        from_endpoint_id: request.sender_endpoint_id,
        to_endpoint_id: request.target_endpoint_id,
      },
    },
    idempotencyKey: key,
    hash: payloadHash({ key, body }),
    origin,
    inReplyToMessageId: openingId,
  });
  return createNoticeDeliveries(context.db, {
    conversationId: root.conversation_id,
    messageId,
    endpointIds: [request.target_endpoint_id, request.sender_endpoint_id],
    routeReason: TRANSFER_ROUTE_REASON,
    sourceObligationId: root.id,
    effectType: "transfer",
    stateRoot: context.stateRoot,
    logger: context.logger,
  });
}

function transferWrap(context, connection, request) {
  return (body) => () => {
    const root = requireRecoverableRoot(context.db, {
      appId: connection.appId,
      rootObligationId: request.root_obligation_id,
    });
    const origin = requireHolder(context, connection, { root, request });
    admitTargetParticipant(context, {
      root,
      target: readTarget(context.db, {
        appId: connection.appId,
        targetEndpointId: request.target_endpoint_id,
      }),
    });
    const outcome = body();
    outcome.liveDeliveries.push(
      ...sendTransferMessage(context, connection, { root, request, origin })
        .liveDeliveries,
    );
    return outcome;
  };
}

/**
 * request: root_obligation_id, root_generation, target_endpoint_id,
 * sender_principal_id, sender_endpoint_id, process_generation (the
 * caller's own, fenced), idempotency_key, optional body.
 */
export function transferWork(context, connection, request) {
  const rootRequest = {
    root_obligation_id: requireString(request, "root_obligation_id"),
    root_generation: request.root_generation,
    target_endpoint_id: requireString(request, "target_endpoint_id"),
    sender_principal_id: requireString(request, "sender_principal_id"),
    sender_endpoint_id: requireString(request, "sender_endpoint_id"),
    process_generation: request.process_generation,
    idempotency_key: requireString(request, "idempotency_key"),
    body:
      request.body === undefined ? undefined : requireString(request, "body"),
  };
  const target = readTarget(context.db, {
    appId: connection.appId,
    targetEndpointId: rootRequest.target_endpoint_id,
  });
  const switchRequest = {
    ...rootRequest,
    target_process_generation: target.process_generation,
  };
  return runRecoveryCommand(
    context,
    connection,
    switchRequest,
    "recovery.switch",
    { wrap: transferWrap(context, connection, rootRequest) },
  );
}
