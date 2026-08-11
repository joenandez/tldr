#!/usr/bin/env bash
# tldr; PostToolUse hook. Renders pending mid-session mail injects.
_TLDR_AGENT_MARKER=tldr-agent-managed:runtime-hooks-v1

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
HELM_HOOKS_DIR="${HELM_HOOKS_DIR:-${SCRIPT_DIR}}"
source "${SCRIPT_DIR}/lib/resolve-tldr-agent-node.sh"
activate_tldr_agent_node || exit 0

resolve_current_session_id() {
  local stdin_json session_id
  stdin_json="${1:-}"
  if [ -n "${stdin_json}" ]; then
    source "${SCRIPT_DIR}/lib/resolve_session_id.sh"
    session_id=$(resolve_helm_session_id "${stdin_json}" || true)
    if [ -n "${session_id}" ]; then
      printf '%s\n' "${session_id}"
      return 0
    fi
  fi
  session_id="${CLAUDE_SESSION_ID:-${CODEX_THREAD_ID:-${HELM_AGENT_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-}}}}"
  [ -n "${session_id}" ] && printf '%s\n' "${session_id}"
}

render_filter() {
  cat <<'JQ'
select(type == "object") |
(.thread_id // "unknown" | tostring | gsub("[\r\n\t]+"; " ")) as $thread |
(.body // "(empty reply)" | tostring) as $body |
($tmpl
  | split("{thread_id}") | join($thread)
  | split("{tldr_agent_cmd}") | join("tldr-agent")
  | split("{body}") | join($body))
JQ
}

render_entry() {
  local entry session_id tmpl
  entry="$1"
  session_id="$2"
  tmpl="$3"
  jq -r --arg tmpl "${tmpl}" "$(render_filter)" 2>/dev/null <<<"${entry}" || true
}

render_stream() {
  local session_id tmpl
  session_id="$1"
  tmpl="$2"
  jq -r --unbuffered --arg tmpl "${tmpl}" "$(render_filter)" 2>/dev/null || true
}

main() {
  local session_id root dir scratch tmpl rendered stdin_json
  stdin_json=""
  if [ ! -t 0 ]; then
    stdin_json=$(cat 2>/dev/null || true)
  fi
  session_id=$(resolve_current_session_id "${stdin_json}" || true)
  [ -n "${session_id}" ] || return 0

  if [ -n "${stdin_json}" ]; then
    printf '%s' "${stdin_json}" | "${TLDR_AGENT_NODE}" "${SCRIPT_DIR}/lib/ariadne-post-tool-use.mjs" "${session_id}" >/dev/null 2>&1 || true
  fi

  root="${TLDR_AGENT_SESSIONS_ROOT:-${TLDR_AGENT_HOME:-${HOME}/.tldr-agent}/sessions}"
  dir="${root}/${session_id}"
  scratch="${HELM_HOOK_SCRATCH:-${dir}/pending-mid-session-inject.jsonl}"
  [ -s "${scratch}" ] || return 0
  command -v jq >/dev/null 2>&1 || return 0

  tmpl=$(cat "${HELM_HOOKS_DIR}/templates/mid_session_inject.tmpl" 2>/dev/null || true)
  [ -n "${tmpl}" ] || return 0

  rendered="${scratch}.rendered.$$"
  render_stream "${session_id}" "${tmpl}" < "${scratch}" > "${rendered}" || true
  if [ -s "${rendered}" ]; then
    "${TLDR_AGENT_NODE}" "${SCRIPT_DIR}/lib/mark-reply-presented.mjs" "${session_id}" "${scratch}" "post_tool_use_inject" >/dev/null 2>&1 || {
      rm -f "${rendered}"
      return 0
    }
    jq -c -Rs '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":(rtrimstr("\n"))}}' < "${rendered}" || true
  fi
  rm -f "${rendered}"
  : > "${scratch}"
  return 0
}

main "$@" || true
exit 0
