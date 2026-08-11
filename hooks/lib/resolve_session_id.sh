#!/usr/bin/env bash
# Resolve the current Helm agent session id from hook stdin JSON or env vars.
#
# Priority (GH#19 follow-up, 2026-05-17):
#   1. stdin JSON `.session_id` — authoritative; runtime stamps this per
#      hook fire, so a nested-spawn child hook gets the CHILD session id,
#      not whatever the parent shell happens to export.
#   2. Env vars (CLAUDE_SESSION_ID / CODEX_THREAD_ID / HELM_AGENT_SESSION_ID
#      / CLAUDE_CODE_SESSION_ID) — fallback for harnesses that invoke hooks
#      directly without a stdin payload.
#
# Why this order matters: when `claude -p` is invoked from inside another
# claude session, the child inherits the parent's CLAUDE_CODE_SESSION_ID
# in its env. The child's SessionStart hook fires with stdin.session_id =
# CHILD, but env = PARENT. Pre-fix the env won, so the hook overwrote the
# parent's identity.json. Discovered by the GH#19 e2e proof on 2026-05-17.

resolve_helm_session_id() {
  local stdin_json="${1-}"
  local session_id=""

  if [ -z "${stdin_json}" ] && [ ! -t 0 ]; then
    stdin_json=$(cat 2>/dev/null || true)
  fi

  if [ -n "${stdin_json}" ] && command -v jq >/dev/null 2>&1; then
    session_id=$(printf '%s' "${stdin_json}" | jq -r 'if type == "object" and (.session_id | type == "string") then .session_id else empty end' 2>/dev/null || true)
  fi

  if [ -z "${session_id}" ] && [ -n "${stdin_json}" ]; then
    case "${stdin_json}" in
      *'"session_id"'*)
        session_value=${stdin_json#*\"session_id\"}
        session_value=${session_value#*:}
        while [ "${session_value# }" != "${session_value}" ]; do
          session_value=${session_value# }
        done
        case "${session_value}" in
          \"*)
            session_value=${session_value#\"}
            session_id=${session_value%%\"*}
            ;;
        esac
        ;;
    esac
  fi

  if [ -z "${session_id}" ]; then
    session_id="${CLAUDE_SESSION_ID:-${CODEX_THREAD_ID:-${HELM_AGENT_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-}}}}"
  fi

  if [ -n "${session_id}" ]; then
    printf '%s\n' "${session_id}"
    return 0
  fi
  return 1
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  resolve_helm_session_id "$@"
fi
