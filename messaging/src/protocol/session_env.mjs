// One session's identity in the environment, which a long-lived process
// must not pass on. The daemon is started by whichever client reaches it
// first, often a Helm run or a Subspace or Claude Code session; without this
// every session it later wakes would run as that one session: its Helm job
// and report duty, its Subspace topic, its Claude Code wiring (ac-jfv.10).
// Shared by ensureDaemon (src/cli/bootstrap.mjs) and the resumer's child env.
//
// The runtime session ids: the child's runtime stamps its own, and an
// inherited one is the confusion src/cli/hook_identity.mjs documents.
// The session-host binding (TIGHTBEAM_HOST, TIGHTBEAM_HOST_REF): a headless
// resume is not in any host's pane, and the child's SessionStart would
// otherwise register the daemon's own binding. The launch token and
// placeholder name one launch; the resumer sets fresh ones. The Academy identity: a
// genuine Academy resume goes through `academy run`, which sets it itself.
//
// Claude Code names are exact because CLAUDE_CODE_* also holds user
// configuration; HELM_, GROVE_ and SUBSPACE_AGENT_ are per-launch only.
const SESSION_ENV_NAMES = new Set([
  'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID',
  'TIGHTBEAM_HOST', 'TIGHTBEAM_HOST_REF', 'TIGHTBEAM_LAUNCH_TOKEN', 'TIGHTBEAM_PLACEHOLDER_ENDPOINT_ID',
  'ACADEMY_AGENT_NAME', 'ACADEMY_AGENT_DIR', 'ACADEMY_PROJECT_DIR',
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_NONINTERACTIVE', 'CLAUDE_PID',
  'CLAUDE_PROJECT_DIR', 'CLAUDE_ENV_FILE', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA',
]);
const SESSION_ENV_PREFIXES = ['HELM_', 'GROVE_', 'SUBSPACE_AGENT_'];

export function withoutSessionEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) =>
    !SESSION_ENV_NAMES.has(name) && !SESSION_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))));
}

// Slack is for Academy agents only (tldr, 2026-10-26): a session with no
// Academy agent name neither sees nor selects the slack route.
export const routeOpenTo = (selector, academyAgentName) => selector !== 'slack' || Boolean(academyAgentName);
