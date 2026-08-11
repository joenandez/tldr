import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

import { runtimeStorePath, withRuntimeStore } from "./runtime_store.mjs";
import { withRuntimeStoreTransactionRetry } from "./runtime_store_retry.mjs";
import {
  safelyRemoveBeaconPendingMarker,
  withBeaconStopIndexMutex,
  writeBeaconPendingMarker,
} from "./tldr_agent_beacon_stop_index.mjs";
import {
  fileMutexState,
  withFileMutex,
  withFileMutexAsync,
} from "./substrate/file_mutex.mjs";

const TERMINAL_OUTCOMES = new Set(["success", "failure", "blocked"]);

export { reconcileBeaconStopIndex } from "./tldr_agent_beacon_stop_index.mjs";

function opaqueId(prefix) {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}
function storeArgs(options) {
  const home = options?.home;
  return {
    home,
    path: options?.path ?? runtimeStorePath(home),
  };
}
function projectMarker(row) {
  if (!row) return null;
  return {
    obligationId: row.obligation_id,
    originThreadId: row.origin_thread_id,
    boundThreadId: row.bound_thread_id,
    confirmationMessageId: row.confirmation_message_id,
    terminalMessageId: row.terminal_message_id,
    terminalOutcome: row.terminal_outcome,
    status: row.status,
    cancellationReason: row.cancellation_reason,
    cancellationSourceRef: row.cancellation_source_ref,
    stopBlockCount: row.stop_block_count,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}
function failure(code, retryable = false) {
  return { ok: false, error: { code, retryable } };
}
function exactRow(db, input) {
  return db
    .prepare(
      `SELECT * FROM tldr_agent_beacon_obligations
       WHERE scope_id = ? AND owner_session_id = ? AND obligation_id = ?`,
    )
    .get(input.scopeId, input.sessionId, input.obligationId);
}
function mutate(stage, input, options, fn) {
  const result = withRuntimeStoreTransactionRetry(
    storeArgs(options),
    {
      context: { stage },
      retryMs: options?.retryMs,
      intervalMs: options?.intervalMs,
    },
    (db) => fn(db, input),
  );
  return result.ok ? result.value : failure("FOLLOWUP_STORE_BUSY", true);
}
function mutateWithStopIndex(stage, input, options, fn) {
  return withBeaconStopIndexMutex(
    options,
    () => mutate(stage, input, options, fn),
    () => failure("FOLLOWUP_STORE_BUSY", true),
  );
}
function nowIso(options) {
  return String(options?.now?.() ?? new Date().toISOString());
}
function lifecycleLockPath(input, options) {
  const storePath = storeArgs(options).path;
  const identity = [
    storePath,
    input.scopeId,
    input.sessionId,
    input.obligationId,
  ].join("\0");
  const key = createHash("sha256").update(identity).digest("hex");
  return join(dirname(storePath), "locks", "beacon", `${key}.lock`);
}
export function withBeaconLifecycleMutex(input, options, fn) {
  return withFileMutex(
    lifecycleLockPath(input, options),
    fn,
    options?.mutexOptions,
  );
}
export function withBeaconLifecycleMutexAsync(input, options, fn) {
  return withFileMutexAsync(
    lifecycleLockPath(input, options),
    fn,
    options?.mutexOptions,
  );
}
export function beaconLifecycleMutexState(input, options = {}) {
  return fileMutexState(
    lifecycleLockPath(input, options),
    options.mutexOptions,
  );
}
export function reserveBeaconRegistration(input, options = {}) {
  return mutateWithStopIndex(
    "beacon_reserve_registration",
    input,
    options,
    (db) => {
      const originThreadId = input.originThreadId ?? null;
      const existing = db
        .prepare(
          `SELECT * FROM tldr_agent_beacon_obligations
             WHERE scope_id = ? AND owner_session_id = ? AND registration_key = ?`,
        )
        .get(input.scopeId, input.sessionId, input.registrationKey);
      if (existing) {
        if (existing.origin_thread_id !== originThreadId) {
          return failure("FOLLOWUP_REGISTRATION_CONFLICT");
        }
        if (existing.status === "pending") {
          try {
            writeBeaconPendingMarker(
              {
                sessionId: input.sessionId,
                obligationId: existing.obligation_id,
              },
              options,
            );
          } catch {
            return failure("FOLLOWUP_STORE_BUSY", true);
          }
        }
        return { ok: true, created: false, marker: projectMarker(existing) };
      }

      const obligationId =
        options.createObligationId?.() ?? opaqueId("obligation");
      const boundThreadId =
        originThreadId ?? options.createThreadId?.() ?? opaqueId("thread");
      const confirmationMessageId =
        options.createConfirmationMessageId?.() ?? opaqueId("message");
      try {
        writeBeaconPendingMarker(
          { sessionId: input.sessionId, obligationId },
          options,
        );
      } catch {
        return failure("FOLLOWUP_STORE_BUSY", true);
      }
      db.prepare(
        `INSERT INTO tldr_agent_beacon_obligations (
             obligation_id, scope_id, owner_session_id, registration_key,
             origin_thread_id, bound_thread_id, confirmation_message_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        obligationId,
        input.scopeId,
        input.sessionId,
        input.registrationKey,
        originThreadId,
        boundThreadId,
        confirmationMessageId,
        nowIso(options),
      );
      return {
        ok: true,
        created: true,
        marker: projectMarker(exactRow(db, { ...input, obligationId })),
      };
    },
  );
}

export function readBeaconObligation(input, options = {}) {
  return withRuntimeStore(storeArgs(options), (db) =>
    projectMarker(exactRow(db, input)),
  );
}

export function assignBeaconTerminal(input, options = {}) {
  if (!TERMINAL_OUTCOMES.has(input.outcome)) {
    throw new TypeError(
      "Beacon terminal outcome must be success, failure, or blocked",
    );
  }
  return mutate("beacon_assign_terminal", input, options, (db) => {
    const existing = exactRow(db, input);
    if (!existing) return failure("FOLLOWUP_NOT_FOUND");
    if (existing.status !== "pending") {
      return failure("FOLLOWUP_ALREADY_RESOLVED");
    }
    if (existing.terminal_message_id) {
      if (existing.terminal_outcome !== input.outcome) {
        return failure("FOLLOWUP_TERMINAL_CONFLICT");
      }
      return { ok: true, assigned: false, marker: projectMarker(existing) };
    }

    const terminalMessageId =
      options.createTerminalMessageId?.() ?? opaqueId("message");
    db.prepare(
      `UPDATE tldr_agent_beacon_obligations
       SET terminal_message_id = ?, terminal_outcome = ?
       WHERE scope_id = ? AND owner_session_id = ? AND obligation_id = ?
         AND status = 'pending' AND terminal_message_id IS NULL`,
    ).run(
      terminalMessageId,
      input.outcome,
      input.scopeId,
      input.sessionId,
      input.obligationId,
    );
    return {
      ok: true,
      assigned: true,
      marker: projectMarker(exactRow(db, input)),
    };
  });
}

export function fulfillBeaconObligation(input, options = {}) {
  const result = mutateWithStopIndex("beacon_fulfill", input, options, (db) => {
    const existing = exactRow(db, input);
    if (!existing) return failure("FOLLOWUP_NOT_FOUND");
    if (existing.status === "fulfilled") {
      if (existing.terminal_message_id !== input.acceptedTerminalMessageId) {
        return failure("FOLLOWUP_ALREADY_RESOLVED");
      }
      return { ok: true, changed: false, marker: projectMarker(existing) };
    }
    if (existing.status !== "pending") {
      return failure("FOLLOWUP_ALREADY_RESOLVED");
    }
    if (
      !existing.terminal_message_id ||
      existing.terminal_message_id !== input.acceptedTerminalMessageId
    ) {
      return failure("FOLLOWUP_TERMINAL_CONFLICT");
    }

    db.prepare(
      `UPDATE tldr_agent_beacon_obligations
       SET status = 'fulfilled', resolved_at = ?
       WHERE scope_id = ? AND owner_session_id = ? AND obligation_id = ?
         AND status = 'pending' AND terminal_message_id = ?`,
    ).run(
      nowIso(options),
      input.scopeId,
      input.sessionId,
      input.obligationId,
      input.acceptedTerminalMessageId,
    );
    return {
      ok: true,
      changed: true,
      marker: projectMarker(exactRow(db, input)),
    };
  });
  if (result?.ok && result.marker?.status !== "pending") {
    safelyRemoveBeaconPendingMarker(input, options);
  }
  return result;
}

export function cancelBeaconObligation(input, options = {}) {
  if (
    !String(input.reason ?? "").trim() ||
    !String(input.revocationRef ?? "").trim()
  ) {
    return failure("FOLLOWUP_REVOCATION_REQUIRED");
  }
  const result = mutateWithStopIndex("beacon_cancel", input, options, (db) => {
    const existing = exactRow(db, input);
    if (!existing) return failure("FOLLOWUP_NOT_FOUND");
    if (existing.status === "cancelled") {
      const sameAudit =
        existing.cancellation_reason === input.reason &&
        existing.cancellation_source_ref === input.revocationRef;
      return sameAudit
        ? { ok: true, changed: false, marker: projectMarker(existing) }
        : failure("FOLLOWUP_ALREADY_RESOLVED");
    }
    if (existing.status !== "pending") {
      return failure("FOLLOWUP_ALREADY_RESOLVED");
    }
    const terminalEffectOwnsAttempt = existing.terminal_message_id
      ? db
          .prepare(
            `SELECT 1 FROM outbound_effects
             WHERE namespace = 'substrate_message'
               AND logical_event_key = ?
               AND status = 'accepted'
             LIMIT 1`,
          )
          .get(`beacon:${existing.terminal_message_id}`)
      : null;
    if (terminalEffectOwnsAttempt) {
      return failure("FOLLOWUP_ALREADY_RESOLVED");
    }

    db.prepare(
      `UPDATE tldr_agent_beacon_obligations
       SET status = 'cancelled', cancellation_reason = ?,
           cancellation_source_ref = ?, resolved_at = ?
       WHERE scope_id = ? AND owner_session_id = ? AND obligation_id = ?
         AND status = 'pending'`,
    ).run(
      input.reason,
      input.revocationRef,
      nowIso(options),
      input.scopeId,
      input.sessionId,
      input.obligationId,
    );
    return {
      ok: true,
      changed: true,
      marker: projectMarker(exactRow(db, input)),
    };
  });
  if (result?.ok && result.marker?.status !== "pending") {
    safelyRemoveBeaconPendingMarker(input, options);
  }
  return result;
}

export function listPendingBeaconObligationsForSession(input, options = {}) {
  return withRuntimeStore(storeArgs(options), (db) =>
    db
      .prepare(
        `SELECT * FROM tldr_agent_beacon_obligations
         WHERE owner_session_id = ? AND status = 'pending'
         ORDER BY created_at, obligation_id`,
      )
      .all(input.sessionId)
      .map((row) => ({ scopeId: row.scope_id, marker: projectMarker(row) })),
  );
}

export function applyBeaconStopPolicy(input, options = {}) {
  return mutate("beacon_apply_stop_policy", input, options, (db) => {
    const pending = db
      .prepare(
        `SELECT * FROM tldr_agent_beacon_obligations
         WHERE owner_session_id = ? AND status = 'pending'
         ORDER BY created_at, obligation_id`,
      )
      .all(input.sessionId);
    if (pending.length === 0) {
      return { ok: true, action: "allow", incremented: 0, markers: [] };
    }
    const shouldBlock = pending.some((row) => row.stop_block_count < 3);
    let incremented = 0;
    if (shouldBlock) {
      incremented = db
        .prepare(
          `UPDATE tldr_agent_beacon_obligations
           SET stop_block_count = stop_block_count + 1
           WHERE owner_session_id = ? AND status = 'pending'
             AND stop_block_count < 3`,
        )
        .run(input.sessionId).changes;
      options.afterStopCountMutation?.();
    }
    const markers = db
      .prepare(
        `SELECT * FROM tldr_agent_beacon_obligations
         WHERE owner_session_id = ? AND status = 'pending'
         ORDER BY created_at, obligation_id`,
      )
      .all(input.sessionId)
      .map(projectMarker);
    return {
      ok: true,
      action: shouldBlock ? "block" : "allow",
      incremented,
      markers,
    };
  });
}
