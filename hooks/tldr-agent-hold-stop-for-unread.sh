#!/usr/bin/env bash
# tldr; Stop hook. Flips state to "idle" when a turn ends, then lets Tachyon
# drain queued inbox replies or park on the dispatcher wake bridge.
# Canonical session_id source is the stdin JSON payload Claude Code passes
# to hooks (`{ "session_id": "...", "hook_event_name": "Stop", ... }`).
# Env vars are kept as a fallback for harnesses that invoke hooks directly.
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
case "${SCRIPT_PATH}" in
  /*) ;;
  *) SCRIPT_PATH="${PWD}/${SCRIPT_PATH}" ;;
esac
SCRIPT_DIR="${SCRIPT_PATH%/*}"
source "${SCRIPT_DIR}/lib/resolve-tldr-agent-node.sh"
activate_tldr_agent_node || exit 0

STDIN_JSON=""
if [ ! -t 0 ]; then
  IFS= read -r STDIN_JSON || true
fi
SESSION_ID=""
STOP_HOOK_ACTIVE=""
if [ -n "${STDIN_JSON}" ]; then
  case "${STDIN_JSON}" in
    *'"session_id"'*)
      SESSION_VALUE="${STDIN_JSON#*\"session_id\"}"
      SESSION_VALUE="${SESSION_VALUE#*:}"
      while [ "${SESSION_VALUE# }" != "${SESSION_VALUE}" ]; do
        SESSION_VALUE="${SESSION_VALUE# }"
      done
      if [ "${SESSION_VALUE#\"}" != "${SESSION_VALUE}" ]; then
        SESSION_VALUE="${SESSION_VALUE#\"}"
        SESSION_ID="${SESSION_VALUE%%\"*}"
      fi
      ;;
  esac
  case "${STDIN_JSON}" in
    *'"stop_hook_active"'*)
      STOP_ACTIVE_VALUE="${STDIN_JSON#*\"stop_hook_active\"}"
      STOP_ACTIVE_VALUE="${STOP_ACTIVE_VALUE#*:}"
      while [ "${STOP_ACTIVE_VALUE# }" != "${STOP_ACTIVE_VALUE}" ]; do
        STOP_ACTIVE_VALUE="${STOP_ACTIVE_VALUE# }"
      done
      case "${STOP_ACTIVE_VALUE}" in true*) STOP_HOOK_ACTIVE=1 ;; esac
      ;;
  esac
fi
if [ -z "${SESSION_ID}" ]; then
  SESSION_ID="${CLAUDE_SESSION_ID:-${CODEX_THREAD_ID:-${HELM_AGENT_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-}}}}"
fi
[ -z "${SESSION_ID}" ] && exit 0

ROOT="${TLDR_AGENT_SESSIONS_ROOT:-${TLDR_AGENT_HOME:-${HOME}/.tldr-agent}/sessions}"
DIR="${ROOT}/${SESSION_ID}"
if [ ! -d "${DIR}" ]; then
  mkdir -p "${DIR}"
fi

STATE_TMP=""
cleanup_state_tmp() {
  if [ -n "${STATE_TMP}" ] && [ -e "${STATE_TMP}" ]; then
    rm -f -- "${STATE_TMP}" 2>/dev/null || true
  fi
}
stop_signal() {
  printf '[🪳 TEMP STOP_HOOK_CANCELLATION] signal=%s session_id=%s\n' \
    "$1" "${SESSION_ID}" >> "${DIR}/tachyon-stop-preflight.log" 2>/dev/null || true
  cleanup_state_tmp
  exit 0
}
trap 'stop_signal TERM' TERM
trap 'stop_signal INT' INT
trap 'stop_signal HUP' HUP
trap cleanup_state_tmp EXIT

BEACON_PENDING=0
BEACON_PREFLIGHT_ERROR=0
unset HELM_BEACON_PENDING HELM_BEACON_PREFLIGHT_ERROR
RUNTIME_STORE="${TLDR_AGENT_HOME:-${HOME}/.tldr-agent}/runtime.sqlite"
if [ -f "${RUNTIME_STORE}" ]; then
  RUN_BEACON_PREFLIGHT=0
  if [ ! -f "${ROOT}/.beacon-stop-index-v1.ready" ]; then
    RUN_BEACON_PREFLIGHT=1
  elif [ -d "${DIR}/beacon-pending.d" ]; then
    for BEACON_MARKER in "${DIR}/beacon-pending.d/"*.pending; do
      if [ -e "${BEACON_MARKER}" ]; then
        RUN_BEACON_PREFLIGHT=1
        break
      fi
    done
  fi
  if [ "${RUN_BEACON_PREFLIGHT}" = "1" ]; then
    BEACON_PREFLIGHT_STATUS=0
    "${TLDR_AGENT_NODE}" "${SCRIPT_DIR}/lib/beacon-stop-preflight.mjs" \
      "${RUNTIME_STORE}" "${SESSION_ID}" "${ROOT}" \
      >/dev/null 2>&1 || BEACON_PREFLIGHT_STATUS=$?
    case "${BEACON_PREFLIGHT_STATUS}" in
      0)
        rm -f -- "${DIR}/beacon-stop-gate-errors.json"
        ;;
      10)
        rm -f -- "${DIR}/beacon-stop-gate-errors.json"
        BEACON_PENDING=1
        export HELM_BEACON_PENDING=1
        ;;
      *)
        BEACON_PREFLIGHT_ERROR=1
        export HELM_BEACON_PREFLIGHT_ERROR=1
        ;;
    esac
  fi
fi

REPLY_WAITING=0
if [ -s "${DIR}/reply-waiting.json" ]; then
  REPLY_WAITING=1
fi
ARIADNE_PENDING=0
if [ "${HELM_ARIADNE_DISABLE:-}" != "1" ] && [ -s "${DIR}/ariadne-pending.json" ]; then
  ARIADNE_PENDING=1
fi
printf '[🪳 TEMP TACHYON_STOP] stop_hook_entered session_id=%s beacon_pending=%s beacon_preflight_error=%s reply_waiting=%s ariadne_pending=%s\n' "${SESSION_ID}" "${BEACON_PENDING}" "${BEACON_PREFLIGHT_ERROR}" "${REPLY_WAITING}" "${ARIADNE_PENDING}" >> "${DIR}/tachyon-stop-preflight.log" 2>/dev/null || true

if [ "${BEACON_PENDING}" != "1" ] && [ "${BEACON_PREFLIGHT_ERROR}" != "1" ] && [ "${REPLY_WAITING}" != "1" ] && [ "${ARIADNE_PENDING}" != "1" ]; then
  PID="${HELM_AGENT_PID:-${PPID:-$$}}"
  STATE_TMP="${DIR}/.state.json.$$.$RANDOM.tmp"
  printf '{ "state": "idle", "since": %s000, "last_pid": %s }\n' \
    "$(date +%s)" "${PID}" > "${STATE_TMP}"
  mv "${STATE_TMP}" "${DIR}/state.json"
  STATE_TMP=""
  printf '[🪳 TEMP TACHYON_STOP] preflight_no_reply_waiting session_id=%s\n' "${SESSION_ID}" >> "${DIR}/tachyon-stop-preflight.log" 2>/dev/null || true
  exit 0
fi

if [ "${STOP_HOOK_ACTIVE:-}" = "1" ]; then
  export HELM_TACHYON_STOP_HOOK_ACTIVE=1
fi
"${TLDR_AGENT_NODE}" "${SCRIPT_DIR}/lib/tachyon-stop.mjs" "${SESSION_ID}"
