import { mutateActionStore, readActionStore } from "./agent_action_store.mjs";

const OUTCOMES = new Set(["timeout", "cancelled"]);

function legacyWaitKey(actionId) {
  return `wait:${actionId}`;
}

function waitKey(session, actionId) {
  return `wait1:${JSON.stringify([
    session.endpoint_id,
    session.session_id,
    session.process_generation,
    actionId,
  ])}`;
}

function readWaitEnvelope(store, session, actionId) {
  const envelopes = store?.envelopes;
  const key = waitKey(session, actionId);
  return Object.hasOwn(envelopes ?? {}, key)
    ? envelopes[key]
    : envelopes?.[legacyWaitKey(actionId)];
}

function completedWaitKey(session) {
  return JSON.stringify([
    session.endpoint_id,
    session.session_id,
    session.process_generation,
  ]);
}

function sameOwner(value, session) {
  return (
    value?.endpoint_id === session.endpoint_id &&
    value?.provider_session_id === session.session_id &&
    value?.process_generation === session.process_generation
  );
}

function validGuard(session) {
  const guard = session.pending_reply_guard;
  const ownerMatches = sameOwner(guard, session);
  const keyMatches =
    typeof guard?.guard_stop_key === "string" &&
    guard.guard_stop_key.length > 0;
  const referencesMatch =
    Array.isArray(guard?.pending_references) &&
    guard.pending_references.length > 0 &&
    guard.pending_references.every(
      (reference) => typeof reference === "string" && reference.length > 0,
    );
  return ownerMatches && keyMatches && referencesMatch ? guard : null;
}

function validOutcome({
  hint,
  session,
  actionId,
  guard = validGuard(session),
}) {
  const actionMatches =
    hint?.action_id === actionId && OUTCOMES.has(hint?.outcome);
  const ownerMatches = sameOwner(hint, session) && Boolean(guard);
  const guardMatches = guard?.guard_stop_key === hint?.guard_stop_key;
  const referencesMatch =
    JSON.stringify(guard?.pending_references) ===
    JSON.stringify(hint?.pending_references);
  return actionMatches && ownerMatches && guardMatches && referencesMatch
    ? hint
    : null;
}

function clearOwnerHints(envelopes, session) {
  for (const [key, entry] of Object.entries(envelopes)) {
    if (!sameOwner(entry, session) || !entry.wait_outcome) continue;
    const { wait_outcome: _staleOutcome, ...current } = entry;
    envelopes[key] = current;
  }
}

function clearCompletedWait(store, session) {
  if (store.completed_waits && typeof store.completed_waits === "object")
    delete store.completed_waits[completedWaitKey(session)];
}

export function readWaitMessage(session, actionId) {
  if (!actionId) return null;
  const entry = readWaitEnvelope(readActionStore(session), session, actionId);
  return sameOwner(entry, session) ? (entry.message_id ?? null) : null;
}

export function recordWaitMessage(session, actionId, messageId) {
  if (!actionId || !session.agent_action_store_path) return;
  const key = waitKey(session, actionId);
  mutateActionStore(session, (store) => {
    clearOwnerHints(store.envelopes, session);
    clearCompletedWait(store, session);
    const entry = store.envelopes[key] ?? {};
    const { wait_outcome: _staleOutcome, ...current } = entry;
    store.envelopes[key] = {
      ...current,
      endpoint_id: session.endpoint_id,
      provider_session_id: session.session_id,
      process_generation: session.process_generation,
      message_id: messageId,
    };
  });
}

export function readWaitTerminal(session, actionId) {
  if (!actionId) return null;
  const terminal = readWaitEnvelope(
    readActionStore(session),
    session,
    actionId,
  )?.wait_terminal;
  if (terminal?.action_id !== actionId || !sameOwner(terminal, session))
    return null;
  return OUTCOMES.has(terminal.outcome) ? terminal : null;
}

export function readWaitOutcome(session, actionId) {
  const entry = readWaitEnvelope(readActionStore(session), session, actionId);
  const guard = Object.hasOwn(entry ?? {}, "wait_guard")
    ? canonicalStoredGuard(entry.wait_guard, session)
    : validGuard(session);
  return validOutcome({ hint: entry?.wait_outcome, session, actionId, guard });
}

function canonicalStoredGuard(guard, session) {
  const invalid = [
    !sameOwner(guard, session),
    typeof guard?.guard_stop_key !== "string",
    !guard?.guard_stop_key,
    !Array.isArray(guard?.pending_references),
    !guard?.pending_references?.length,
    !(
      Array.isArray(guard?.pending_references) &&
      guard.pending_references.every(
        (reference) => typeof reference === "string" && reference.length > 0,
      )
    ),
  ];
  return invalid.some(Boolean) ? null : guard;
}

export function readCompletedWaitOutcome(session) {
  const store = readActionStore(session);
  const completedWaits = store?.completed_waits;
  const selector = completedWaits?.[completedWaitKey(session)];
  const entry = readWaitEnvelope(store, session, selector?.action_id);
  const terminal = entry?.wait_terminal;
  const guard = canonicalStoredGuard(entry?.wait_guard, session);
  const invalid = [
    !completedWaits,
    typeof completedWaits !== "object",
    Array.isArray(completedWaits),
    selector?.version !== 1,
    !sameOwner(selector, session),
    typeof selector?.action_id !== "string",
    !selector?.action_id,
    typeof selector?.guard_stop_key !== "string",
    !selector?.guard_stop_key,
    !sameOwner(entry, session),
    terminal?.action_id !== selector?.action_id,
    !sameOwner(terminal, session),
    !OUTCOMES.has(terminal?.outcome),
    !guard,
    guard?.guard_stop_key !== selector?.guard_stop_key,
    !validOutcome({
      hint: entry?.wait_outcome,
      session,
      actionId: selector?.action_id,
      guard,
    }),
    entry?.wait_outcome?.outcome !== terminal?.outcome,
  ];
  return invalid.some(Boolean) ? null : entry.wait_outcome;
}

export function readCurrentWaitOutcome(session, actionId) {
  const completed = readCompletedWaitOutcome(session);
  if (completed && (!actionId || completed.action_id === actionId))
    return completed;
  return actionId ? readWaitOutcome(session, actionId) : null;
}

export function recordWaitOutcome(session, actionId, outcome) {
  if (
    [!actionId, !session.agent_action_store_path, !OUTCOMES.has(outcome)].some(
      Boolean,
    )
  )
    return;
  const terminal = {
    action_id: actionId,
    endpoint_id: session.endpoint_id,
    provider_session_id: session.session_id,
    process_generation: session.process_generation,
    outcome,
  };
  const guard = validGuard(session);
  const hint = guard
    ? {
        action_id: actionId,
        endpoint_id: session.endpoint_id,
        provider_session_id: session.session_id,
        process_generation: session.process_generation,
        guard_stop_key: guard.guard_stop_key,
        pending_references: [...guard.pending_references],
        outcome,
      }
    : null;
  mutateActionStore(session, (store) => {
    if (
      !store.completed_waits ||
      typeof store.completed_waits !== "object" ||
      Array.isArray(store.completed_waits)
    )
      store.completed_waits = {};
    const key = waitKey(session, actionId);
    const entry = store.envelopes[key] ?? {};
    const { wait_outcome: _staleOutcome, ...current } = entry;
    const publishHint = hint && !entry.message_id;
    store.envelopes[key] = {
      ...current,
      endpoint_id: session.endpoint_id,
      provider_session_id: session.session_id,
      process_generation: session.process_generation,
      ...(guard
        ? {
            wait_guard: {
              endpoint_id: session.endpoint_id,
              provider_session_id: session.session_id,
              process_generation: session.process_generation,
              guard_stop_key: guard.guard_stop_key,
              pending_references: [...guard.pending_references],
            },
          }
        : {}),
      wait_terminal: terminal,
      ...(publishHint ? { wait_outcome: hint } : {}),
    };
    if (publishHint) {
      store.completed_waits[completedWaitKey(session)] = {
        version: 1,
        action_id: actionId,
        endpoint_id: session.endpoint_id,
        provider_session_id: session.session_id,
        process_generation: session.process_generation,
        guard_stop_key: guard.guard_stop_key,
      };
    }
  });
}
