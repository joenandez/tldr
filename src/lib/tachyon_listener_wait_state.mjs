import { isProcessAlive, processParentPid } from "./process_liveness.mjs";

const BLOCKING_STOP_HOOK_WAIT_STATE = "blocking_stop_hook";

function optionalPositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function tachyonWaitStatePayload(listener) {
  return {
    wait_state: listener?.wait_state || null,
    hook_pid: listener?.hook_pid ?? null,
    hook_ppid: listener?.hook_ppid ?? null,
    hook_current_ppid: listener?.hook_current_ppid ?? null,
    agent_pid: listener?.agent_pid ?? null,
    runtime: listener?.runtime || null,
  };
}

export function classifyBlockingStopHook(listener) {
  if (!listener || listener.wait_state !== BLOCKING_STOP_HOOK_WAIT_STATE) {
    return { eligible: false, reason: "missing_hook_wait_state" };
  }
  const hookPid = optionalPositiveNumber(listener.hook_pid);
  const hookPpid = optionalPositiveNumber(listener.hook_ppid);
  if (!hookPid || !hookPpid) {
    return { eligible: false, reason: "missing_hook_wait_state" };
  }
  if (!isProcessAlive(hookPid)) {
    return { eligible: false, reason: "hook_pid_dead" };
  }
  if (!isProcessAlive(hookPpid)) {
    return { eligible: false, reason: "hook_parent_dead" };
  }
  const currentPpid = processParentPid(hookPid);
  if (!currentPpid) {
    return { eligible: false, reason: "hook_ppid_unknown" };
  }
  if (currentPpid !== hookPpid) {
    return {
      eligible: false,
      reason: "hook_reparented",
      hook_current_ppid: currentPpid,
    };
  }
  return {
    eligible: true,
    reason: null,
    hook_current_ppid: currentPpid,
  };
}
