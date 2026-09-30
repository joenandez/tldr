import { MESSAGING_COMMAND, TASKS_COMMAND } from "../helm_context.mjs";

export const HINTS = {
  daemon_tick_advancing: `${TASKS_COMMAND} up`,
  claude_retired_hooks_absent: `${TASKS_COMMAND} bootstrap-hooks --uninstall --runtime claude`,
  codex_retired_hooks_absent: `${TASKS_COMMAND} bootstrap-hooks --uninstall --runtime codex`,
  session_source_tightbeam: `${MESSAGING_COMMAND} doctor`,
  resolve_workspace_smoke: `${TASKS_COMMAND} doctor --deep --workspace`,
  skill_mirror_resolvable: `${TASKS_COMMAND} onboard`,
};

export function hintFor(name) {
  return HINTS[name] || null;
}
