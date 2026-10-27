import { createHmac, timingSafeEqual } from "node:crypto";

const STOP_BLOCK_CAP = 3;
const DIRECT_WAIT_DOMAIN = "tldr:agent.wait.direct-stop:v1:";

function directWaitSignature({
  secretHash,
  appId,
  actionId,
  endpoint,
  references,
}) {
  const canonical = JSON.stringify([
    appId,
    actionId,
    endpoint.id,
    endpoint.provider_session_id,
    endpoint.process_generation,
    endpoint.owner_epoch,
    references,
  ]);
  return `dw1.${createHmac("sha256", secretHash)
    .update(DIRECT_WAIT_DOMAIN)
    .update(canonical)
    .digest("hex")}`;
}

export function issueDirectWaitGuard(
  db,
  { appId, actionId, endpoint, references },
) {
  const application = db
    .prepare(
      "SELECT secret_hash FROM applications WHERE id = ? AND status = 'active'",
    )
    .get(appId);
  if (!application) return null;
  return directWaitSignature({
    secretHash: application.secret_hash,
    appId,
    actionId,
    endpoint,
    references,
  });
}

export function encodePendingReference(kind, identity, revision) {
  return `pr1.${Buffer.from(JSON.stringify([kind, identity, revision])).toString("base64url")}`;
}

export function isPendingReference(value) {
  if (typeof value !== "string" || !value.startsWith("pr1.")) return false;
  try {
    const decoded = JSON.parse(
      Buffer.from(value.slice(4), "base64url").toString(),
    );
    return (
      Array.isArray(decoded) &&
      decoded.length === 3 &&
      ["human", "agent"].includes(decoded[0])
    );
  } catch {
    return false;
  }
}

export function validateWaitOutcome(value) {
  const fields = [
    "action_id",
    "endpoint_id",
    "provider_session_id",
    "process_generation",
    "guard_stop_key",
    "pending_references",
    "outcome",
  ];
  if (!validWaitOutcome(value, fields)) return null;
  return { ...value, pending_references: [...value.pending_references] };
}

function validWaitOutcome(value, fields) {
  return (
    isWaitOutcomeObject(value) &&
    hasExactFields(value, fields) &&
    hasWaitIdentity(value) &&
    hasWaitReferences(value)
  );
}

function isWaitOutcomeObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactFields(value, fields) {
  return Object.keys(value).sort().join() === fields.sort().join();
}

function hasWaitIdentity(value) {
  const identities = [
    "action_id",
    "endpoint_id",
    "provider_session_id",
    "guard_stop_key",
  ];
  const validStrings = identities.every(
    (key) => typeof value[key] === "string" && value[key].length > 0,
  );
  return (
    validStrings &&
    Number.isSafeInteger(value.process_generation) &&
    value.process_generation > 0 &&
    ["timeout", "cancelled"].includes(value.outcome)
  );
}

function hasWaitReferences(value) {
  if (
    !Array.isArray(value.pending_references) ||
    !value.pending_references.length
  )
    return false;
  const unique = new Set(value.pending_references);
  return (
    unique.size === value.pending_references.length &&
    [...unique].every(isPendingReference) &&
    value.pending_references.join() ===
      [...value.pending_references].sort().join()
  );
}

function referencesEqual(left, right) {
  return (
    left.length === right.length &&
    left.every((reference, index) => reference === right[index])
  );
}

function priorGuardMatches(db, { appId, endpoint, processGeneration, hint }) {
  const rows = db
    .prepare(
      "SELECT result_payload FROM lifecycle_commands WHERE app_id = ? AND operation = 'session.stop' AND json_extract(result_payload, '$.guard_stop_key') = ? AND json_extract(result_payload, '$.endpoint_id') = ? AND json_extract(result_payload, '$.process_generation') = ? AND json_extract(result_payload, '$.provider_session_id') IS ? AND json_extract(result_payload, '$.wait_mode') = 'explicit'",
    )
    .all(
      appId,
      hint.guard_stop_key,
      endpoint.id,
      processGeneration,
      endpoint.provider_session_id,
    );
  return rows.some(({ result_payload }) => {
    const previous = JSON.parse(result_payload);
    return (
      previous.decision === "block" &&
      referencesEqual(
        previous.pending_references ?? [],
        hint.pending_references,
      )
    );
  });
}

function matchesSession(hint, endpoint, processGeneration) {
  return (
    hint.endpoint_id === endpoint.id &&
    hint.provider_session_id === endpoint.provider_session_id &&
    hint.process_generation === processGeneration
  );
}

function isDirectWaitGuard(db, { appId, endpoint, processGeneration, hint }) {
  if (!/^dw1\.[0-9a-f]{64}$/.test(hint.guard_stop_key)) return false;
  const application = db
    .prepare(
      "SELECT secret_hash FROM applications WHERE id = ? AND status = 'active'",
    )
    .get(appId);
  if (!application) return false;
  const expected = directWaitSignature({
    secretHash: application.secret_hash,
    appId,
    actionId: hint.action_id,
    endpoint: { ...endpoint, process_generation: processGeneration },
    references: hint.pending_references,
  });
  const suppliedBytes = Buffer.from(hint.guard_stop_key.slice(4), "hex");
  const expectedBytes = Buffer.from(expected.slice(4), "hex");
  return (
    suppliedBytes.length === expectedBytes.length &&
    timingSafeEqual(suppliedBytes, expectedBytes)
  );
}

// Not consumed: once the agent has waited for these exact replies, every later
// Stop is its own call. A new or revised expected reply changes the references.
function validEscape(
  db,
  { appId, endpoint, processGeneration, hint, references },
) {
  if (!hint) return false;
  return (
    matchesSession(hint, endpoint, processGeneration) &&
    referencesEqual(hint.pending_references, references) &&
    (priorGuardMatches(db, { appId, endpoint, processGeneration, hint }) ||
      isDirectWaitGuard(db, { appId, endpoint, processGeneration, hint }))
  );
}

function explicitBlockCount(
  db,
  { appId, endpoint, processGeneration, guardReference },
) {
  return db
    .prepare(
      "SELECT COUNT(DISTINCT idempotency_key) AS count FROM lifecycle_commands WHERE app_id = ? AND operation = 'session.stop' AND json_extract(result_payload, '$.wait_mode') = 'explicit' AND json_extract(result_payload, '$.endpoint_id') = ? AND json_extract(result_payload, '$.process_generation') = ? AND json_extract(result_payload, '$.guard_reference') = ?",
    )
    .get(appId, endpoint.id, processGeneration, guardReference).count;
}

function callerBlock(action, command, context) {
  const guardReference = action.reference;
  if (
    explicitBlockCount(context.db, { ...context, guardReference }) >=
    STOP_BLOCK_CAP
  )
    return { decision: "allow", obligation_ids: [] };
  const verb = action.action === "accept" ? "accept" : "complete";
  const instruction =
    action.action === "accept"
      ? "Accept or decline the offered work"
      : "Complete or update the work you hold";
  return {
    decision: "block",
    obligation_ids: [action.id],
    guard_stop_key: context.request.idempotency_key,
    endpoint_id: context.endpoint.id,
    process_generation: context.processGeneration,
    provider_session_id: context.endpoint.provider_session_id ?? null,
    wait_mode: "explicit",
    guard_reference: guardReference,
    reason: `[tightbeam] ${instruction} before stopping.\nAction: ${command} agent ${verb} --work ${action.id}`,
  };
}

function pendingBlock(db, { context, command, pending }) {
  const references = pending.map((item) => item.reference).sort();
  const guardReference = JSON.stringify(references);
  if (
    validEscape(db, {
      ...context,
      hint: context.request.wait_outcome,
      references,
    })
  ) {
    return {
      decision: "allow",
      obligation_ids: [],
      consumed_wait_action_id: context.request.wait_outcome.action_id,
      consumed_endpoint_id: context.endpoint.id,
      consumed_process_generation: context.processGeneration,
    };
  }
  if (explicitBlockCount(db, { ...context, guardReference }) >= STOP_BLOCK_CAP)
    return { decision: "allow", obligation_ids: [] };
  const labels = pending.map((item) => `  - ${item.label}`).join("\n");
  return {
    decision: "block",
    obligation_ids: [],
    pending_references: references,
    guard_reference: guardReference,
    guard_stop_key: context.request.idempotency_key,
    endpoint_id: context.endpoint.id,
    process_generation: context.processGeneration,
    provider_session_id: context.endpoint.provider_session_id ?? null,
    wait_mode: "explicit",
    reason: `[tightbeam] Cannot stop: ${pending.length} expected reply/replies remain:\n${labels}\nRun ${command} agent wait and stop again after it returns.`,
  };
}

export function explicitWaitGuard(
  db,
  { appId, endpoint, processGeneration, request, pending, callerAction },
  command,
) {
  const context = { db, appId, endpoint, processGeneration, request };
  if (callerAction) return callerBlock(callerAction, command, context);
  if (pending.length) return pendingBlock(db, { context, command, pending });
  return request.background_wait
    ? null
    : { decision: "allow", obligation_ids: [] };
}
