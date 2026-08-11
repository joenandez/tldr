import { helmHome } from "./store.mjs";
import { withRuntimeStore } from "./runtime_store.mjs";
import {
  deriveSideEffectKey,
  outboundEffectValueHash,
} from "./outbound_effect_identity.mjs";

function nonempty(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} is required`);
  }
  return value.trim();
}

function nowIso() {
  return new Date().toISOString();
}

function suppressionReason(status) {
  if (status === "accepted") return "already_accepted";
  if (status === "ambiguous") return "ambiguous_requires_reconciliation";
  if (status === "attempting") return "attempt_in_progress";
  if (status === "dry_run") return "dry_run_recorded";
  if (status === "blocked") return "blocked";
  return "duplicate_side_effect";
}

function authorizeAttempt(db, guard) {
  if (!guard) return true;
  if (guard.kind !== "beacon_delivery_pending") return false;
  const messageColumn =
    guard.purpose === "beacon_confirmation"
      ? "confirmation_message_id"
      : guard.purpose === "beacon_terminal"
        ? "terminal_message_id"
        : null;
  if (!messageColumn) return false;
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM tldr_agent_beacon_obligations
         WHERE scope_id = ? AND owner_session_id = ? AND obligation_id = ?
           AND ${messageColumn} = ? AND status = 'pending'`,
      )
      .get(guard.scopeId, guard.sessionId, guard.obligationId, guard.messageId),
  );
}

function blockedClaim(sideEffectKey) {
  return {
    allowed: false,
    side_effect_key: sideEffectKey,
    status: "blocked",
    reason: "beacon_obligation_not_pending",
  };
}

export function prepareBeaconOutboundEffect({
  home = helmHome(),
  namespace,
  logicalRunKey = null,
  logicalEventKey,
  effect,
  channel,
  recipient,
  payload,
  renderInputs = {},
  templateVersion = null,
  renderedPayloadRef = null,
  initialStatus = "attempting",
  reclaimFailedDefinite = false,
  claimGuard = null,
  now = nowIso(),
} = {}) {
  const sideEffectKey = deriveSideEffectKey({
    namespace,
    logicalEventKey,
    effect,
    channel,
    recipient,
    templateVersion,
  });
  const payloadHash = outboundEffectValueHash(payload ?? null);
  const renderInputsHash = outboundEffectValueHash(renderInputs ?? null);
  const timestamp = nonempty(now, "now");
  const normalizedStatus = nonempty(initialStatus, "initialStatus");

  return withRuntimeStore({ home }, (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = db
        .prepare("SELECT * FROM outbound_effects WHERE side_effect_key = ?")
        .get(sideEffectKey);
      if (existing) {
        if (
          existing.payload_hash !== payloadHash ||
          existing.render_inputs_hash !== renderInputsHash
        ) {
          db.prepare(
            "UPDATE outbound_effects SET status = 'blocked', updated_at = ? WHERE side_effect_key = ?",
          ).run(timestamp, sideEffectKey);
          db.exec("COMMIT");
          return {
            allowed: false,
            side_effect_key: sideEffectKey,
            status: "blocked",
            reason: "payload_changed_for_side_effect_key",
          };
        }
        if (reclaimFailedDefinite && existing.status === "failed_definite") {
          if (!authorizeAttempt(db, claimGuard)) {
            db.exec("COMMIT");
            return blockedClaim(sideEffectKey);
          }
          db.prepare(
            "UPDATE outbound_effects SET status = 'attempting', updated_at = ? WHERE side_effect_key = ? AND status = 'failed_definite'",
          ).run(timestamp, sideEffectKey);
          db.exec("COMMIT");
          return {
            allowed: true,
            reclaimed: true,
            side_effect_key: sideEffectKey,
            status: "attempting",
            payload_hash: payloadHash,
            render_inputs_hash: renderInputsHash,
          };
        }
        db.exec("COMMIT");
        return {
          allowed: false,
          side_effect_key: sideEffectKey,
          status: "suppressed_duplicate",
          reason: suppressionReason(existing.status),
          existing_status: existing.status,
        };
      }

      if (!authorizeAttempt(db, claimGuard)) {
        db.exec("COMMIT");
        return blockedClaim(sideEffectKey);
      }

      db.prepare(
        `INSERT INTO outbound_effects (
           side_effect_key, namespace, logical_run_key, logical_event_key,
           channel, recipient, status, payload_hash, render_inputs_hash,
           template_version, first_rendered_payload_ref, attempt_count,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      ).run(
        sideEffectKey,
        nonempty(namespace, "namespace"),
        logicalRunKey,
        nonempty(logicalEventKey, "logicalEventKey"),
        nonempty(channel, "channel"),
        nonempty(recipient, "recipient"),
        normalizedStatus,
        payloadHash,
        renderInputsHash,
        templateVersion,
        renderedPayloadRef,
        timestamp,
        timestamp,
      );
      db.exec("COMMIT");
      return {
        allowed: normalizedStatus === "attempting",
        side_effect_key: sideEffectKey,
        status: normalizedStatus,
        payload_hash: payloadHash,
        render_inputs_hash: renderInputsHash,
      };
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original error.
      }
      throw error;
    }
  });
}

export function recordBeaconOutboundEffectSuccess({
  home = helmHome(),
  sideEffectKey,
  providerMessageId = null,
  now = nowIso(),
} = {}) {
  const key = nonempty(sideEffectKey, "sideEffectKey");
  const timestamp = nonempty(now, "now");
  return withRuntimeStore({ home }, (db) => {
    const result = db
      .prepare(
        `UPDATE outbound_effects
         SET status = 'accepted', attempt_count = attempt_count + 1,
             last_provider_message_id = ?, updated_at = ?
         WHERE side_effect_key = ?`,
      )
      .run(providerMessageId, timestamp, key);
    return { updated: result.changes === 1, side_effect_key: key };
  });
}

export function recordBeaconOutboundEffectFailure({
  home = helmHome(),
  sideEffectKey,
  ambiguous = false,
  error = null,
  now = nowIso(),
} = {}) {
  const key = nonempty(sideEffectKey, "sideEffectKey");
  const timestamp = nonempty(now, "now");
  const status = ambiguous ? "ambiguous" : "failed_definite";
  return withRuntimeStore({ home }, (db) => {
    const result = db
      .prepare(
        `UPDATE outbound_effects
         SET status = ?, attempt_count = attempt_count + 1, updated_at = ?,
             first_rendered_payload_ref = COALESCE(first_rendered_payload_ref, ?)
         WHERE side_effect_key = ?`,
      )
      .run(status, timestamp, error, key);
    return { updated: result.changes === 1, side_effect_key: key, status };
  });
}

export function getBeaconOutboundEffect({
  home = helmHome(),
  sideEffectKey,
} = {}) {
  const key = nonempty(sideEffectKey, "sideEffectKey");
  return withRuntimeStore({ home }, (db) =>
    db
      .prepare("SELECT * FROM outbound_effects WHERE side_effect_key = ?")
      .get(key),
  );
}
