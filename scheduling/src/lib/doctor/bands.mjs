export const BANDS = ["scheduler", "hooks", "workspace"];

export const CHECKS = [
  {
    name: "daemon_tick_advancing",
    band: "scheduler",
    gates_in_mode: () => false,
  },
  {
    name: "claude_retired_hooks_absent",
    band: "hooks",
    gates_in_mode: () => true,
  },
  {
    name: "codex_retired_hooks_absent",
    band: "hooks",
    gates_in_mode: () => true,
  },
  // Informational: Helm degrades to its legacy session files when Tightbeam
  // cannot answer, and onboarding verification runs every band.
  {
    name: "session_source_tightbeam",
    band: "hooks",
    gates_in_mode: () => false,
  },
  {
    name: "resolve_workspace_smoke",
    band: "workspace",
    gates_in_mode: () => true,
  },
  {
    name: "skill_mirror_resolvable",
    band: "workspace",
    gates_in_mode: () => true,
  },
];

export const BAND_FLAGS = BANDS;
