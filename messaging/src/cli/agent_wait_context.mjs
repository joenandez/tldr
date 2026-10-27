import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readWaitTerminal } from "./agent_wait_journal.mjs";

function guardMatchesSession(value, session) {
  return (
    value.endpoint_id === session.endpoint_id &&
    value.provider_session_id === session.session_id &&
    value.process_generation === session.process_generation
  );
}

function hasGuardReferences(value) {
  return (
    Array.isArray(value.pending_references) &&
    value.pending_references.length > 0 &&
    value.pending_references.every(
      (reference) => typeof reference === "string" && reference.length > 0,
    )
  );
}

export function canonicalPendingReplyGuard(value, session) {
  const checks = [
    value && typeof value === "object" && !Array.isArray(value),
    guardMatchesSession(value ?? {}, session),
    typeof value?.guard_stop_key === "string" &&
      value.guard_stop_key.length > 0,
    hasGuardReferences(value ?? {}),
  ];
  const valid = checks.every(Boolean);
  return valid
    ? { ...value, pending_references: [...value.pending_references] }
    : null;
}

export function agentWaitContext(session, command) {
  return {
    endpoint_id: session.endpoint_id,
    provider_session_id: session.session_id,
    process_generation: session.process_generation,
    wait_action_id: command.actionId,
  };
}

export function cacheHandshakePendingReplyGuard(session, handshake, actionId) {
  if (!Object.hasOwn(handshake ?? {}, "pending_reply_guard")) {
    throw Object.assign(
      new Error(
        "the Tightbeam daemon needs an update to support agent wait; update or repair the messaging daemon and retry",
      ),
      { code: "notification_wait_unavailable" },
    );
  }
  const value = handshake.pending_reply_guard;
  let guard = null;
  if (value !== null) {
    if (value && !guardMatchesSession(value, session)) {
      throw Object.assign(
        new Error(
          "the current session identity changed while waiting; refresh the supported SessionStart hook and retry",
        ),
        { code: "session_identity_mismatch" },
      );
    }
    guard = canonicalPendingReplyGuard(value, session);
    const fields = [
      "endpoint_id",
      "provider_session_id",
      "process_generation",
      "guard_stop_key",
      "pending_references",
    ];
    const refs = guard?.pending_references;
    const invalid = [
      !guard,
      Boolean(guard) && Object.keys(value).length !== fields.length,
      Boolean(guard) &&
        !fields.every((field) => Object.hasOwn(value ?? {}, field)),
      !/^dw1\.[0-9a-f]{64}$/.test(guard?.guard_stop_key ?? ""),
      refs?.some(
        (reference, index) => index > 0 && refs[index - 1] >= reference,
      ),
    ];
    if (invalid.some(Boolean)) {
      throw Object.assign(
        new Error(
          "the Tightbeam daemon returned an invalid pending reply guard; update or repair the messaging daemon and retry",
        ),
        { code: "notification_wait_unavailable" },
      );
    }
  }
  if (readWaitTerminal(session, actionId)) return;
  cachePendingReplyGuard(session, guard);
}

function endpointCachePath(session) {
  return path.join(
    path.dirname(session.agent_action_store_path),
    "endpoint.json",
  );
}

function readEndpointCache(endpointPath, guard) {
  try {
    return JSON.parse(fs.readFileSync(endpointPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" && !guard) return null;
    throw Object.assign(
      new Error(
        "the current session identity cache is unreadable; refresh the supported SessionStart hook and retry",
      ),
      { code: "session_unavailable", cause: error },
    );
  }
}

function assertSessionCache(cache, session) {
  if (
    cache?.endpoint_id === session.endpoint_id &&
    cache?.session_id === session.session_id &&
    cache?.process_generation === session.process_generation
  )
    return;
  throw Object.assign(
    new Error(
      "the current session identity cache changed while waiting; refresh the supported SessionStart hook and retry",
    ),
    { code: "session_identity_mismatch" },
  );
}

function publishEndpointCache(endpointPath, cached) {
  const temporary = `${endpointPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(cached, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.renameSync(temporary, endpointPath);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      /* Preserve the publication error. */
    }
    throw Object.assign(
      new Error(
        `could not persist the current pending reply guard: ${error.message}`,
      ),
      { code: "action_identity_unavailable" },
    );
  }
}

export function cachePendingReplyGuard(session, guard) {
  if (!session.agent_action_store_path) return;
  const endpointPath = endpointCachePath(session);
  const cached = readEndpointCache(endpointPath, guard);
  if (!cached) {
    session.pending_reply_guard = null;
    return;
  }
  assertSessionCache(cached, session);
  if (guard) cached.pending_reply_guard = guard;
  else delete cached.pending_reply_guard;
  publishEndpointCache(endpointPath, cached);
  session.pending_reply_guard = guard;
}
