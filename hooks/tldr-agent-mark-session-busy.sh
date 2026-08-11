#!/usr/bin/env bash
# tldr; UserPromptSubmit hook. Flips state to "busy" when a turn begins.
# Canonical session_id source is the stdin JSON payload Claude Code passes
# to hooks (`{ "session_id": "...", "hook_event_name": "UserPromptSubmit", ... }`).
# Env vars are kept as a fallback for harnesses that invoke hooks directly.
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "${SCRIPT_DIR}/lib/resolve-tldr-agent-node.sh"
activate_tldr_agent_node || exit 0

STDIN_JSON=""
if [ ! -t 0 ]; then
  STDIN_JSON=$(cat 2>/dev/null || true)
fi
source "${SCRIPT_DIR}/lib/resolve_session_id.sh"
SESSION_ID=$(resolve_helm_session_id "${STDIN_JSON}" || true)
[ -z "${SESSION_ID}" ] && exit 0

ROOT="${TLDR_AGENT_SESSIONS_ROOT:-${TLDR_AGENT_HOME:-${HOME}/.tldr-agent}/sessions}"
DIR="${ROOT}/${SESSION_ID}"
mkdir -p "${DIR}"

PID="${HELM_AGENT_PID:-${PPID:-$$}}"
cat > "${DIR}/state.json.tmp" <<EOF
{ "state": "busy", "since": $(date +%s)000, "last_pid": ${PID} }
EOF
mv "${DIR}/state.json.tmp" "${DIR}/state.json"
"${TLDR_AGENT_NODE}" "${SCRIPT_DIR}/lib/user-prompt-submit.mjs" "${SESSION_ID}" || true
exit 0
