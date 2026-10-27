// A read-only dispatch fence for a previously acquired resume claim.
import { TightbeamError } from "../../protocol/envelope.mjs";
import { withTransaction } from "../db.mjs";
import { verifyClaimToken } from "./claims_shared.mjs";
import { runtimeContract, runtimeIdEquals } from "./resume_shared.mjs";

const FIELDS = [
  "resume_request_id",
  "token",
  "endpoint_id",
  "provider_session_id",
  "process_generation",
  "owner_epoch",
  "owner_launch_token",
  "listener_id",
  "listener_generation",
];

function malformed(field, message) {
  throw new TightbeamError("malformed_request", message, { field });
}

function validateObject(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    malformed("payload", "assert-active payload must be an object");
  if (Object.keys(payload).some((field) => !FIELDS.includes(field)))
    malformed("payload", "assert-active payload contains an unsupported field");
}

function validateRequiredStrings(payload) {
  for (const field of [
    "resume_request_id",
    "token",
    "endpoint_id",
    "provider_session_id",
  ]) {
    if (typeof payload[field] !== "string" || payload[field].length === 0)
      malformed(field, `${field} is required and must be a non-empty string`);
  }
}

function validateNullableStrings(payload) {
  for (const field of ["owner_launch_token", "listener_id"]) {
    if (
      payload[field] !== null &&
      (typeof payload[field] !== "string" || payload[field].length === 0)
    ) {
      malformed(field, `${field} must be a non-empty string or null`);
    }
  }
}

function validateListenerFence(payload) {
  if ((payload.listener_id === null) !== (payload.listener_generation === null))
    malformed(
      "listener_generation",
      "listener id and generation must both be null or populated",
    );
  if (
    payload.listener_generation !== null &&
    (!Number.isInteger(payload.listener_generation) ||
      payload.listener_generation < 1)
  ) {
    malformed(
      "listener_generation",
      "listener_generation must be a positive integer or null",
    );
  }
}

function validate(payload) {
  validateObject(payload);
  validateRequiredStrings(payload);
  validateNullableStrings(payload);
  for (const field of ["process_generation", "owner_epoch"]) {
    const min = field === "owner_epoch" ? 0 : 1;
    if (!Number.isInteger(payload[field]) || payload[field] < min)
      malformed(field, `${field} is required and must be an integer >= ${min}`);
  }
  validateListenerFence(payload);
  return payload;
}

function currentListenerMatches(listener, payload) {
  if (!listener)
    return payload.listener_id === null && payload.listener_generation === null;
  return (
    payload.listener_id === listener.id &&
    payload.listener_generation === listener.listener_generation
  );
}

function listenerIsActiveForSession(listener, row, now) {
  if (!listener) return false;
  const activeState = ["parked", "attached", "waking"].includes(listener.state);
  const currentProcess = listener.process_generation === row.process_generation;
  const currentSession =
    listener.provider_session_id === row.provider_session_id;
  const unexpired =
    Date.parse(listener.lease_expires_at) > now.getTime() &&
    Date.parse(listener.park_deadline_at) > now.getTime();
  return activeState && currentProcess && currentSession && unexpired;
}

function requestIsSuperseded(db, row) {
  if (row.replacement_endpoint_id !== null) return true;
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM resume_requests WHERE replacement_for_request_id = ? LIMIT 1",
      )
      .get(row.id),
  );
}

function endpointSessionMatches(row, payload) {
  return (
    Boolean(row.provider_session_id) &&
    row.provider_session_id === row.session_id &&
    row.provider_session_id === payload.provider_session_id
  );
}

function endpointOwnerMatches(row, payload) {
  const ownerGenerationMatches =
    row.owner_process_generation === null ||
    row.owner_process_generation === row.process_generation;
  return (
    row.process_generation === payload.process_generation &&
    row.owner_epoch === payload.owner_epoch &&
    row.owner_launch_token === payload.owner_launch_token &&
    ownerGenerationMatches
  );
}

function endpointAvailable(row) {
  return !["closed", "retiring", "takeover_pending"].includes(
    row.endpoint_state,
  );
}

export const resumeAssertActiveOp = {
  name: "resume.assert-active",
  allowedScopes: ["agent"],
  permission: "claim_resume_requests",
  handler(context, input, connection) {
    const payload = validate(input);
    const grant = connection.permissions.get("claim_resume_requests");
    const allowedRuntimeTypes =
      grant && Array.isArray(grant.allowed_runtime_types)
        ? grant.allowed_runtime_types
        : [];
    const { canonicalize } = runtimeContract(context);
    const result = withTransaction(context.db, () => {
      const now = new Date();
      const row = context.db
        .prepare(
          `SELECT r.id, r.endpoint_id, r.session_id, r.state AS request_state,
                r.replacement_endpoint_id, e.provider_session_id, e.runtime, e.created_by_app_id,
                e.state AS endpoint_state, e.process_generation, e.owner_epoch, e.owner_launch_token,
                e.owner_process_generation
           FROM resume_requests r JOIN endpoints e ON e.id = r.endpoint_id
          WHERE r.id = ?`,
        )
        .get(payload.resume_request_id);
      if (
        !row ||
        row.endpoint_id !== payload.endpoint_id ||
        row.created_by_app_id !== connection.appId ||
        !allowedRuntimeTypes.some((runtime) =>
          runtimeIdEquals(runtime, row.runtime, canonicalize),
        )
      ) {
        throw new TightbeamError(
          "resume_handler_unavailable",
          "the exact resume authority is unavailable",
        );
      }

      const { alreadyResolved } = verifyClaimToken(context.db, {
        resourceType: "resume_request",
        resourceId: row.id,
        token: payload.token,
        now,
      });
      const activeClaim = context.db
        .prepare(
          "SELECT id, lease_expires_at FROM claims WHERE resource_type = 'resume_request' AND resource_id = ? AND state = 'claimed' AND token = ? AND lease_expires_at > ?",
        )
        .get(row.id, payload.token, now.toISOString());
      const latestListener = context.db
        .prepare(
          "SELECT id, listener_generation, process_generation, provider_session_id, state, lease_expires_at, park_deadline_at FROM listeners WHERE endpoint_id = ? ORDER BY process_generation DESC, listener_generation DESC, rowid DESC LIMIT 1",
        )
        .get(row.endpoint_id);
      const leaseCurrent =
        Date.parse(activeClaim?.lease_expires_at) > now.getTime();
      if (alreadyResolved || !leaseCurrent) {
        throw new TightbeamError(
          "claim_expired",
          "the exact resume authority is no longer current",
        );
      }
      const claimAuthorityCurrent =
        row.request_state === "claimed" &&
        !requestIsSuperseded(context.db, row) &&
        endpointAvailable(row);
      const endpointFenceCurrent =
        endpointSessionMatches(row, payload) &&
        endpointOwnerMatches(row, payload);
      const listenerFenceCurrent =
        currentListenerMatches(latestListener, payload) &&
        !listenerIsActiveForSession(latestListener, row, now);
      if (
        !claimAuthorityCurrent ||
        !endpointFenceCurrent ||
        !listenerFenceCurrent
      ) {
        throw new TightbeamError(
          "claim_expired",
          "the exact resume authority is no longer current",
        );
      }

      return {
        resume_request_id: row.id,
        endpoint_id: row.endpoint_id,
        provider_session_id: row.provider_session_id,
        active: true,
      };
    });

    return { result };
  },
};
