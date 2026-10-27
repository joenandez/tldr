import { encodePendingReference } from "./explicit_wait_guard.mjs";

const ACTIVE_REPLY_STATES = "'pending_delivery', 'eligible'";

function humanExpectations(db, endpoint, now) {
  return db
    .prepare(
      `SELECT rw.id, rw.binding_id, rw.state, rw.updated_at, rw.provider_session_id, rw.process_generation,
            rb.source_message_id, rb.source_provider_session_id, rb.source_process_generation, rb.expires_at,
            json_extract(source_effect.effect_payload, '$.declaration.sender_endpoint_id') AS source_endpoint_id
       FROM reply_waits rw JOIN reply_bindings rb ON rb.id = rw.binding_id
       JOIN messages source ON source.id = rb.source_message_id LEFT JOIN message_effects source_effect ON source_effect.message_id = source.id
      WHERE rw.endpoint_id = ? AND rw.state IN (${ACTIVE_REPLY_STATES})
        AND rw.provider_session_id IS ? AND rw.process_generation IS ?
        AND rb.target_endpoint_id = rw.endpoint_id AND rb.state = 'active' AND rb.expires_at > ?`,
    )
    .all(
      endpoint.id,
      endpoint.provider_session_id,
      endpoint.process_generation,
      now,
    )
    .map((row) => ({
      kind: "human",
      id: row.id,
      reference: encodePendingReference(
        "human",
        [
          row.id,
          row.binding_id,
          row.source_message_id,
          row.source_endpoint_id,
          row.source_provider_session_id,
          row.source_process_generation,
          endpoint.id,
          row.provider_session_id,
          row.process_generation,
          endpoint.owner_epoch,
        ],
        [row.state, row.updated_at, row.expires_at],
      ),
      label: `human reply from message ${row.source_message_id}`,
    }));
}

function candidateRoots(db, endpoint) {
  return db
    .prepare(
      `WITH RECURSIVE chain(root_id, id, parent_id, custodian_endpoint_id) AS (
        SELECT id, id, parent_id, custodian_endpoint_id FROM obligations WHERE role = 'root' AND status = 'open'
        UNION ALL
        SELECT chain.root_id, child.id, child.parent_id, child.custodian_endpoint_id
          FROM obligations child JOIN chain ON child.parent_id = chain.id
      ), candidates(root_id) AS (
        SELECT node.id FROM obligations node JOIN message_effects effect ON effect.obligation_id = node.id
          WHERE node.role = 'root' AND node.status = 'open' AND effect.effect = 'open'
            AND json_extract(effect.effect_payload, '$.declaration.sender_endpoint_id') = ?
        UNION
        SELECT root_id FROM chain WHERE custodian_endpoint_id = ?
      )
      SELECT root_id AS id FROM candidates`,
    )
    .all(endpoint.id, endpoint.id)
    .map(({ id }) => id);
}

function rootNodes(db, rootId) {
  return db
    .prepare(
      `WITH RECURSIVE chain AS (SELECT * FROM obligations WHERE id = ? UNION ALL SELECT child.* FROM obligations child JOIN chain parent ON child.parent_id = parent.id)
      SELECT node.id, node.parent_id, node.role, node.status, node.generation, node.custodian_endpoint_id,
             node.accountable_principal_id, node.updated_at,
             (SELECT effect.id FROM message_effects effect JOIN messages message ON message.id = effect.message_id
               WHERE effect.obligation_id = node.id ORDER BY message.created_at DESC, effect.rowid DESC LIMIT 1) AS latest_effect_id
        FROM chain node ORDER BY node.id`,
    )
    .all(rootId);
}

function openLeaves(nodes) {
  const open = nodes.filter(
    (node) => node.role !== "root" && node.status === "open",
  );
  return open.filter(
    (node) => !open.some((child) => child.parent_id === node.id),
  );
}

function waitingElsewhere(db, leaves, endpoint) {
  return leaves.filter((leaf) => {
    if (leaf.custodian_endpoint_id) {
      return db
        .prepare("SELECT 1 FROM endpoints WHERE id = ? AND principal_id <> ?")
        .get(leaf.custodian_endpoint_id, endpoint.principal_id);
    }
    return leaf.role === "delegation" && offeredElsewhere(db, leaf, endpoint);
  });
}

function offeredElsewhere(db, leaf, endpoint) {
  const offer = db
    .prepare(
      "SELECT delivery.endpoint_id, target.principal_id FROM handoff_watches watch LEFT JOIN deliveries delivery ON delivery.id = watch.parent_delivery_id LEFT JOIN endpoints target ON target.id = delivery.endpoint_id WHERE watch.delegation_id = ? AND watch.state = 'awaiting_acceptance'",
    )
    .get(leaf.id);
  return offer
    ? offer.endpoint_id
      ? offer.endpoint_id !== endpoint.id &&
        offer.principal_id !== endpoint.principal_id
      : leaf.accountable_principal_id !== endpoint.principal_id
    : false;
}

function hasPendingAgentWork(db, endpoint, nodes) {
  if (!nodes.some((node) => node.role === "root" && node.status === "open"))
    return false;
  const leaves = openLeaves(nodes);
  if (
    !leaves.length ||
    leaves.some((leaf) => leaf.custodian_endpoint_id === endpoint.id)
  )
    return false;
  return waitingElsewhere(db, leaves, endpoint).length > 0;
}

function agentExpectation(db, endpoint, rootId) {
  const nodes = rootNodes(db, rootId);
  if (!hasPendingAgentWork(db, endpoint, nodes)) return null;
  const revision = nodes.map(
    ({
      id,
      status,
      generation,
      custodian_endpoint_id,
      updated_at,
      latest_effect_id,
    }) => [
      id,
      status,
      generation,
      custodian_endpoint_id,
      updated_at,
      latest_effect_id,
    ],
  );
  return {
    kind: "agent",
    id: rootId,
    reference: encodePendingReference(
      "agent",
      [
        rootId,
        endpoint.id,
        endpoint.provider_session_id,
        endpoint.process_generation,
        endpoint.owner_epoch,
      ],
      revision,
    ),
    label: `tracked agent work ${rootId}`,
  };
}

function agentExpectations(db, endpoint) {
  return [...candidateRoots(db, endpoint)]
    .map((id) => agentExpectation(db, endpoint, id))
    .filter(Boolean);
}

export function pendingReplyExpectations(
  db,
  endpoint,
  now = new Date().toISOString(),
) {
  return [
    ...humanExpectations(db, endpoint, now),
    ...agentExpectations(db, endpoint),
  ].sort((a, b) => a.reference.localeCompare(b.reference));
}

function latestEffectId(db, obligationId) {
  return (
    db
      .prepare(
        `SELECT effect.id FROM message_effects effect JOIN messages message ON message.id = effect.message_id
      WHERE effect.obligation_id = ? ORDER BY message.created_at DESC, effect.rowid DESC LIMIT 1`,
      )
      .get(obligationId)?.id ?? null
  );
}

export function callerActionForPendingOffer(db, endpoint, principalId) {
  const row = db
    .prepare(
      `SELECT d.id, d.updated_at, w.parent_delivery_id FROM obligations d JOIN handoff_watches w ON w.delegation_id = d.id AND w.state = 'awaiting_acceptance'
      WHERE d.role = 'delegation' AND d.status = 'open' AND d.custodian_endpoint_id IS NULL
        AND d.accountable_principal_id = ? AND (w.parent_delivery_id IS NULL OR EXISTS (SELECT 1 FROM deliveries offer WHERE offer.id = w.parent_delivery_id AND offer.endpoint_id = ?))
      ORDER BY d.created_at, d.id LIMIT 1`,
    )
    .get(principalId, endpoint.id);
  return row
    ? {
        ...row,
        action: "accept",
        reference: encodePendingReference(
          "agent",
          [row.id, endpoint.id, row.parent_delivery_id],
          [row.updated_at, latestEffectId(db, row.id)],
        ),
      }
    : null;
}

function untrackedOffers(db, endpointId) {
  const offers = db
    .prepare(
      "SELECT id, conversation_id, parent_id FROM obligations WHERE role = 'delegation' AND status = 'open' AND custodian_endpoint_id IS NULL",
    )
    .all();
  return offers
    .filter((offer) => {
      let current = offer.parent_id;
      for (let depth = 0; current && depth < 64; depth += 1) {
        const node = db
          .prepare(
            "SELECT parent_id, custodian_endpoint_id FROM obligations WHERE id = ?",
          )
          .get(current);
        if (!node) return false;
        if (node.custodian_endpoint_id === endpointId)
          return !db
            .prepare(
              "SELECT 1 FROM handoff_watches WHERE delegation_id = ? AND state = 'awaiting_acceptance'",
            )
            .get(offer.id);
        current = node.parent_id;
      }
      return false;
    })
    .map(({ id, conversation_id }) => ({ id, conversation_id }));
}

export { untrackedOffers };
export {
  encodePendingReference,
  validateWaitOutcome,
} from "./explicit_wait_guard.mjs";
export { isPendingReference } from "./explicit_wait_guard.mjs";
