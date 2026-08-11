import { appendActivityEvent } from "./tldr_agent_diagnostics.mjs";
import { writeState } from "./identity_state.mjs";

export function reconcileDeadOwnerState({
  scope,
  sessionId,
  ownerState,
  state,
}) {
  if (!sessionId || ownerState?.alive) return state;

  const stalePid = Number(ownerState?.pid);
  const currentState = state || ownerState?.stateRow;
  if (!currentState || !Number.isFinite(stalePid) || stalePid <= 1) {
    return currentState;
  }
  if (currentState.state !== "busy") return currentState;

  const data = {
    session_id: sessionId,
    last_pid: stalePid,
    previous_state: currentState.state,
  };
  try {
    writeState(sessionId, { state: "idle", lastPid: stalePid });
    appendActivityEvent({
      type: "comms_dispatcher_dead_owner_state_recovered",
      level: "warn",
      scope_id: scope?.scope_id ?? null,
      cwd: scope?.cwd ?? null,
      data: {
        ...data,
        message: "Reconciled stale busy owner state (pid alive check failed)",
      },
    });
  } catch (err) {
    appendActivityEvent({
      type: "comms_dispatcher_dead_owner_state_recover_failed",
      level: "warn",
      scope_id: scope?.scope_id ?? null,
      cwd: scope?.cwd ?? null,
      error: err?.message || String(err),
      data: {
        ...data,
        message:
          "Failed to reconcile stale owner state before resume; will continue with stale state",
      },
    });
  }
  return {
    ...currentState,
    state: "idle",
    last_pid: stalePid,
    lastPid: stalePid,
  };
}
