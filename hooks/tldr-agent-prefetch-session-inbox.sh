#!/usr/bin/env bash
# tldr-agent-managed:runtime-hooks-v1

_tldr_agent_hook_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "${_tldr_agent_hook_dir}/lib/resolve-tldr-agent-node.sh"
activate_tldr_agent_node || exit 0

# Keep the dominant no-unread path in this tiny wrapper. The retained Helm
# parser is loaded only when stdin or inbox bytes require real work.
if [ ! -s /dev/stdin ]; then
  _tldr_agent_session_id="${CLAUDE_SESSION_ID:-${CODEX_THREAD_ID:-${HELM_AGENT_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-}}}}"
  [ -z "${_tldr_agent_session_id}" ] ||
    [ -s "${HELM_HOOK_INBOX:-${TLDR_AGENT_SESSIONS_ROOT:-${TLDR_AGENT_HOME:-${HOME}/.tldr-agent}/sessions}/${_tldr_agent_session_id}/inbox.jsonl}" ] ||
    exit 0
fi
exec bash "${_tldr_agent_hook_dir}/lib/prefetch-session-inbox-slow.sh" "$@"
