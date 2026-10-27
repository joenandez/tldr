import { TightbeamError } from "../protocol/envelope.mjs";
import { pendingReplyExpectations } from "./pending_reply_expectations.mjs";
import { issueDirectWaitGuard } from "./explicit_wait_guard.mjs";

/**
 * Read the canonical pending-reply snapshot for an exact current app owner.
 * This does not open notification admission or mutate message/owner state.
 */
export function pendingReplyGuard(
  db,
  { appId, endpointId, providerSessionId, processGeneration, actionId },
) {
  const permission = db
    .prepare(
      "SELECT 1 FROM application_permissions WHERE app_id = ? AND permission = 'read_inbox'",
    )
    .get(appId);
  if (!permission) {
    throw new TightbeamError(
      "permission_denied",
      "missing required permission: read_inbox",
    );
  }

  const endpoint = db
    .prepare(
      `SELECT id, principal_id, process_generation, provider_session_id, owner_epoch, owner_launch_token
         FROM endpoints
        WHERE id = ? AND process_generation = ? AND provider_session_id = ?
          AND created_by_app_id = ? AND state IN ('idle', 'busy')`,
    )
    .get(endpointId, processGeneration, providerSessionId, appId);
  if (!endpoint) {
    throw new TightbeamError(
      "permission_denied",
      "pending reply guard is not granted for this exact endpoint owner",
    );
  }

  const pendingReferences = pendingReplyExpectations(db, endpoint)
    .map(({ reference }) => reference)
    .sort();
  if (pendingReferences.length === 0) return null;

  return {
    endpoint_id: endpoint.id,
    provider_session_id: endpoint.provider_session_id,
    process_generation: endpoint.process_generation,
    guard_stop_key: issueDirectWaitGuard(db, {
      appId,
      actionId,
      endpoint,
      references: pendingReferences,
    }),
    pending_references: pendingReferences,
  };
}
