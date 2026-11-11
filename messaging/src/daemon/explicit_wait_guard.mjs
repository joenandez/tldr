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
  // A message hint names its message: progress is counted per message.
  const fields = [
    ...(value?.outcome === "message" ? ["message_id"] : []),
    "action_id",
    "endpoint_id",
    "provider_session_id",
    "process_generation",
    "guard_stop_key",
    "pending_references",
    "outcome",
  ];
  if (!validWaitOutcome(value, fields)) return null;
  if (fields.includes("message_id") && !validMessageId(value.message_id))
    return null;
  return { ...value, pending_references: [...value.pending_references] };
}

function validMessageId(value) {
  return typeof value === "string" && value.length > 0;
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
    ["timeout", "cancelled", "message"].includes(value.outcome)
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

// Progress is keyed by message, not by wait: an unread delivery that every
// `agent wait` returns again under a new action id is counted once per
// reference set on an endpoint/generation, then it is just another Stop.
function progressCounted(db, context, { hint, guardReference }) {
  return Boolean(
    db
      .prepare(
        "SELECT 1 AS counted FROM lifecycle_commands WHERE app_id = ? AND operation = 'session.stop' AND json_extract(result_payload, '$.progress_message_id') = ? AND json_extract(result_payload, '$.endpoint_id') = ? AND json_extract(result_payload, '$.process_generation') = ? AND json_extract(result_payload, '$.guard_reference') = ? LIMIT 1",
      )
      .get(
        context.appId,
        hint.message_id,
        context.endpoint.id,
        context.processGeneration,
        guardReference,
      ),
  );
}

function provenWait(db, { appId, endpoint, processGeneration, hint }) {
  return (
    matchesSession(hint, endpoint, processGeneration) &&
    (priorGuardMatches(db, { appId, endpoint, processGeneration, hint }) ||
      isDirectWaitGuard(db, { appId, endpoint, processGeneration, hint }))
  );
}

// Not consumed: once the agent has waited for these exact replies and the wait
// ended in timeout or cancelled, every later Stop is its own call. A new or
// revised expected reply changes the references and re-arms the guard.
function validEscape(db, context, { hint, references }) {
  if (!["timeout", "cancelled"].includes(hint?.outcome)) return false;
  return (
    referencesEqual(hint.pending_references, references) &&
    provenWait(db, { ...context, hint })
  );
}

// A message outcome proves the agent really waited: the Stop stays blocked (the
// agent is nudged to wait again) but is not counted toward the cap, once per message.
function validProgress(db, context, { hint, guardReference }) {
  if (hint?.outcome !== "message") return false;
  return (
    provenWait(db, { ...context, hint }) &&
    !progressCounted(db, context, { hint, guardReference })
  );
}

// Consecutive blocks since the last Stop that used a wait hint; a wait resets it.
function explicitBlockCount(
  db,
  { appId, endpoint, processGeneration, guardReference },
) {
  return db
    .prepare(
      "SELECT COUNT(DISTINCT idempotency_key) AS count FROM lifecycle_commands WHERE app_id = ? AND operation = 'session.stop' AND json_extract(result_payload, '$.wait_mode') = 'explicit' AND json_extract(result_payload, '$.endpoint_id') = ? AND json_extract(result_payload, '$.process_generation') = ? AND json_extract(result_payload, '$.guard_reference') = ? AND rowid > COALESCE((SELECT MAX(rowid) FROM lifecycle_commands WHERE app_id = ? AND operation = 'session.stop' AND json_extract(result_payload, '$.consumed_endpoint_id') = ? AND json_extract(result_payload, '$.consumed_process_generation') = ?), 0)",
    )
    .get(
      appId,
      endpoint.id,
      processGeneration,
      guardReference,
      appId,
      endpoint.id,
      processGeneration,
    ).count;
}

// STOP_BLOCK_CAP consecutive blocks with no wait means the wait path itself is
// broken (command failing, daemon down): allow rather than wedge the session.
function capReached(db, context, guardReference) {
  const count = explicitBlockCount(db, { ...context, guardReference });
  if (count < STOP_BLOCK_CAP) return false;
  if (context.trace)
    context.trace.explicit_cap_allow = {
      endpoint_id: context.endpoint.id,
      count,
    };
  return true;
}

function callerBlock(action, command, context) {
  const guardReference = action.reference;
  if (capReached(context.db, context, guardReference))
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
  const hint = context.request.wait_outcome;
  const consumed = hint && {
    consumed_wait_action_id: hint.action_id,
    consumed_endpoint_id: context.endpoint.id,
    consumed_process_generation: context.processGeneration,
  };
  if (validEscape(db, context, { hint, references }))
    return { decision: "allow", obligation_ids: [], ...consumed };
  const progress = validProgress(db, context, { hint, guardReference });
  if (!progress && capReached(db, context, guardReference))
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
    ...(progress ? { ...consumed, progress_message_id: hint.message_id } : {}),
    reason: `[tightbeam] Cannot stop: ${pending.length} expected reply/replies remain:\n${labels}\nRun ${command} agent wait and stop again after it returns.`,
  };
}

export function explicitWaitGuard(
  db,
  { appId, endpoint, processGeneration, request, pending, callerAction, trace },
  command,
) {
  const context = { db, appId, endpoint, processGeneration, request, trace };
  if (callerAction) return callerBlock(callerAction, command, context);
  if (pending.length) return pendingBlock(db, { context, command, pending });
  return request.background_wait
    ? null
    : { decision: "allow", obligation_ids: [] };
}
