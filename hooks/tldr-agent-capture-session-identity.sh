#!/usr/bin/env bash
# tldr; session-start hook. Runs once per agent session at SessionStart.
# Writes ~/.tldr-agent/sessions/<id>/identity.json (immutable boot snapshot) and
# initial state.json (state=idle, no turn has begun). Idempotent on re-exec.
#
# Canonical session_id source is the stdin JSON payload Claude Code passes
# to hooks (`{ "session_id": "...", "hook_event_name": "SessionStart", ... }`).
# Env vars are kept as a fallback for harnesses that invoke hooks directly.
#
# Runtime detection priority (GH#19 fix, 2026-05-17):
#   1. stdin JSON `transcript_path` — most reliable, set by the runtime itself
#      at hook-fire time, regardless of which shell env wraps the spawn.
#      `.claude/projects/...` → claude, `.codex/sessions/...` → codex.
#   2. Env vars (CLAUDECODE / CLAUDE_CODE_SESSION_ID / CODEX_THREAD_ID).
#      Unreliable when the hook fires *before* the runtime has exported its
#      own env (early-bootstrap race observed on daemon-spawned sessions).
#   3. UUID version digit — UUIDv7 → codex, UUIDv4 → claude. Mirrors the
#      inferRuntime fallback in src/lib/substrate/resume_session.mjs.
#   4. HELM_AGENT_RUNTIME env (operator-supplied override) → fall through to
#      "unknown" only when every prior source has failed.
set -euo pipefail

# Read stdin once and reuse for both session_id resolution and runtime
# inference. resolve_session_id.sh will accept the JSON as $1.
STDIN_JSON=""
if [ ! -t 0 ]; then
  STDIN_JSON=$(cat 2>/dev/null || true)
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source "${SCRIPT_DIR}/lib/resolve_session_id.sh"
source "${SCRIPT_DIR}/lib/resolve-tldr-agent-node.sh"
resolve_tldr_agent_node >/dev/null 2>&1 || true
SESSION_ID=$(resolve_helm_session_id "$STDIN_JSON" || true)
if [ -z "${SESSION_ID}" ]; then
  exit 0
fi

RUNTIME=""
CWD="${PWD}"

if [ -n "${STDIN_JSON}" ] && command -v jq >/dev/null 2>&1; then
  TRANSCRIPT_PATH=$(printf '%s' "${STDIN_JSON}" | jq -r 'if type == "object" and (.transcript_path | type == "string") then .transcript_path else empty end' 2>/dev/null || true)
  CAPTURED_CWD=$(printf '%s' "${STDIN_JSON}" | jq -r 'if type == "object" and (.cwd | type == "string") and (.cwd | length > 0) then .cwd else empty end' 2>/dev/null || true)
  if [ -n "${CAPTURED_CWD}" ]; then CWD="${CAPTURED_CWD}"; fi
  case "${TRANSCRIPT_PATH}" in
    */.claude/*|*/claude/projects/*) RUNTIME="claude" ;;
    */.codex/*|*/codex/sessions/*) RUNTIME="codex" ;;
  esac
fi

if [ -z "${RUNTIME}" ]; then
  if [ -n "${CLAUDE_CODE_SESSION_ID:-${CLAUDE_SESSION_ID:-}}" ] || [ -n "${CLAUDECODE:-}" ]; then RUNTIME="claude"
  elif [ -n "${CODEX_THREAD_ID:-}" ]; then RUNTIME="codex"; fi
fi

if [ -z "${RUNTIME}" ]; then
  case "${SESSION_ID}" in
    [0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]-7[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]-*) RUNTIME="codex" ;;
    [0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]-4[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]-*) RUNTIME="claude" ;;
  esac
fi

if [ -z "${RUNTIME}" ]; then
  RUNTIME="${HELM_AGENT_RUNTIME:-unknown}"
fi

ROOT="${TLDR_AGENT_SESSIONS_ROOT:-${TLDR_AGENT_HOME:-${HOME}/.tldr-agent}/sessions}"
DIR="${ROOT}/${SESSION_ID}"
umask 077
mkdir -p "${DIR}"

PID="${HELM_AGENT_PID:-${PPID:-$$}}"
TTY=$(ps -o tty= -p "${PID}" 2>/dev/null | tr -d ' ')
case "${TTY}" in
  ''|'?'|'??') TTY="" ;;
  /dev/*) ;; # already absolute
  *) TTY="/dev/${TTY}" ;;
esac

COMMAND=$(ps -o command= -p "${PID}" 2>/dev/null || true)
RAW_LAUNCH_MODE="${HELM_AGENT_LAUNCH_MODE:-}"
LAUNCH_SOURCE="unknown"
case "${RAW_LAUNCH_MODE}" in
  interactive|non_interactive|unknown)
    LAUNCH_MODE="${RAW_LAUNCH_MODE}"
    LAUNCH_SOURCE="env"
    ;;
  headless|noninteractive)
    LAUNCH_MODE="non_interactive"
    LAUNCH_SOURCE="env"
    ;;
  *)
    if [ -n "${HELM_JOB_ID:-}" ] || [ -n "${HELM_RUN_ID:-}" ]; then
      LAUNCH_MODE="non_interactive"
      LAUNCH_SOURCE="helm_job"
    elif printf '%s\n' "${COMMAND}" | grep -Eq '(^|[[:space:]/])(codex[[:space:]]+exec|claude[[:space:]]+-p)([[:space:]]|$)'; then
      LAUNCH_MODE="non_interactive"
      LAUNCH_SOURCE="command_shape"
    elif [ -z "${TTY}" ]; then
      LAUNCH_MODE="unknown"
      LAUNCH_SOURCE="no_tty"
    elif printf '%s\n' "${COMMAND}" | grep -Eq '(^|[[:space:]/])(codex|claude)([[:space:]]|$)'; then
      LAUNCH_MODE="interactive"
      LAUNCH_SOURCE="tty_tui"
    else
      LAUNCH_MODE="unknown"
      LAUNCH_SOURCE="unknown"
    fi
    ;;
esac

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
IDENTITY_TMP="${DIR}/identity.json.tmp"
/bin/rm -f "${IDENTITY_TMP}"
printf '%s\n' '{"_tldr_agent_identity":true}' > "${IDENTITY_TMP}"
/usr/bin/plutil -insert session_id -string "${SESSION_ID}" "${IDENTITY_TMP}"
/usr/bin/plutil -insert runtime -string "${RUNTIME}" "${IDENTITY_TMP}"
/usr/bin/plutil -insert runtime_version -json null "${IDENTITY_TMP}"
/usr/bin/plutil -insert install_path -json null "${IDENTITY_TMP}"
/usr/bin/plutil -insert cwd -string "${CWD}" "${IDENTITY_TMP}"
/usr/bin/plutil -insert pid -integer "${PID}" "${IDENTITY_TMP}"
if [ -n "${TTY}" ]; then
  /usr/bin/plutil -insert controlling_tty -string "${TTY}" "${IDENTITY_TMP}"
else
  /usr/bin/plutil -insert controlling_tty -json null "${IDENTITY_TMP}"
fi
/usr/bin/plutil -insert launch_mode -string "${LAUNCH_MODE}" "${IDENTITY_TMP}"
/usr/bin/plutil -insert launch_source -string "${LAUNCH_SOURCE}" "${IDENTITY_TMP}"
/usr/bin/plutil -insert session_started_at -string "${NOW}" "${IDENTITY_TMP}"
PLUGIN_RELEASE=${CLAUDE_PLUGIN_VERSION:-unknown}
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" ]; then
  PLUGIN_RELEASE=$(/usr/bin/plutil -extract version raw -o - "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" 2>/dev/null || printf '%s' "${PLUGIN_RELEASE}")
fi
/usr/bin/plutil -insert plugin_release -string "${PLUGIN_RELEASE}" "${IDENTITY_TMP}"
/usr/bin/plutil -remove _tldr_agent_identity "${IDENTITY_TMP}"
/bin/chmod 600 "${IDENTITY_TMP}"
mv "${DIR}/identity.json.tmp" "${DIR}/identity.json"

cat > "${DIR}/state.json.tmp" <<EOF
{ "state": "idle", "since": $(date +%s)000, "last_pid": ${PID} }
EOF
mv "${DIR}/state.json.tmp" "${DIR}/state.json"
exit 0
