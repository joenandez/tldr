#!/usr/bin/env bash

resolve_current_session_id() {
  local stdin_json session_id
  stdin_json="${1:-}"
  if [ -n "${stdin_json}" ]; then
    session_id=$(printf '%s' "${stdin_json}" | "${TLDR_AGENT_NODE}" -e '
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        try {
          const parsed = JSON.parse(input);
          if (parsed && typeof parsed === "object" && typeof parsed.session_id === "string") {
            process.stdout.write(parsed.session_id);
          }
        } catch {}
      });
    ' 2>/dev/null || true)
    if [ -n "${session_id}" ]; then
      printf '%s\n' "${session_id}"
      return 0
    fi
  fi
  session_id="${CLAUDE_SESSION_ID:-${CODEX_THREAD_ID:-${HELM_AGENT_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-}}}}"
  [ -n "${session_id}" ] && printf '%s\n' "${session_id}"
}

main() {
  local session_id root dir inbox state scratch size last_seen start now stdin_json candidate script_dir
  stdin_json=""
  if [ -s /dev/stdin ]; then
    IFS= read -r -d '' stdin_json || true
  fi
  session_id=$(resolve_current_session_id "${stdin_json}" || true)
  [ -n "${session_id}" ] || return 0

  root="${TLDR_AGENT_SESSIONS_ROOT:-${TLDR_AGENT_HOME:-${HOME}/.tldr-agent}/sessions}"
  dir="${root}/${session_id}"
  candidate="${dir}/ariadne-pending.json"
  if [ -n "${stdin_json}" ] && [ -s "${candidate}" ]; then
    script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
    printf '%s' "${stdin_json}" | node "${script_dir}/ariadne-post-tool-use.mjs" "${session_id}" >/dev/null 2>&1 || true
  fi
  inbox="${HELM_HOOK_INBOX:-${dir}/inbox.jsonl}"
  state="${HELM_HOOK_STATE:-${dir}/inbox-check-state.json}"
  scratch="${HELM_HOOK_SCRATCH:-${dir}/pending-mid-session-inject.jsonl}"

  [ -f "${inbox}" ] || return 0
  [ -s "${inbox}" ] || return 0

  mkdir -p "${dir}"
  size=$(wc -c < "${inbox}" 2>/dev/null | tr -d ' ' || printf '0')
  case "${size}" in ''|*[!0-9]*) size=0 ;; esac
  last_seen=0
  if [ -f "${state}" ]; then
    last_seen=$("${TLDR_AGENT_NODE}" -e '
      const { readFileSync } = require("node:fs");
      try {
        const value = JSON.parse(readFileSync(process.argv[1], "utf8")).last_seen_offset;
        process.stdout.write(String(Number.isSafeInteger(value) && value >= 0 ? value : 0));
      } catch {
        process.stdout.write("0");
      }
    ' "${state}" 2>/dev/null || printf '0')
    case "${last_seen}" in ''|*[!0-9]*) last_seen=0 ;; esac
  fi
  if [ "${last_seen}" -gt "${size}" ]; then
    last_seen=0
  fi
  [ "${size}" -gt "${last_seen}" ] || return 0

  start=$((last_seen + 1))
  tail -c +"${start}" "${inbox}" 2>/dev/null | "${TLDR_AGENT_NODE}" -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      for (const line of input.split(/\r?\n/)) {
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            process.stdout.write(`${JSON.stringify(parsed)}\n`);
          }
        } catch {}
      }
    });
  ' >> "${scratch}" 2>/dev/null || true
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  printf '{"last_seen_offset":%s,"last_check_ts":"%s"}\n' "${size}" "${now}" > "${state}.tmp"
  mv "${state}.tmp" "${state}"
  return 0
}

main "$@" >/dev/null 2>/dev/null || true
exit 0
