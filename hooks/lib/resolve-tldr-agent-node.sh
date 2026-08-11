#!/bin/sh

resolve_tldr_agent_node() {
  case "${NODE_OPTIONS:-}" in
    *--conditions=tldr-agent-test*)
      case "${TLDR_AGENT_TEST_NODE_PATH:-}" in
        /*)
          [ -x "${TLDR_AGENT_TEST_NODE_PATH}" ] || return 1
          printf '%s\n' "${TLDR_AGENT_TEST_NODE_PATH}"
          return 0
          ;;
      esac
      ;;
  esac
  tldr_agent_home=${TLDR_AGENT_HOME:-${HOME}/.tldr-agent}
  tldr_agent_node="${tldr_agent_home}/install/runtime/bin/node"
  [ -x "$tldr_agent_node" ] || return 1
  printf '%s\n' "$tldr_agent_node"
}

activate_tldr_agent_node() {
  tldr_agent_node=$(resolve_tldr_agent_node) || return 1
  case "${NODE_OPTIONS:-}:${TLDR_AGENT_TEST_NODE_PATH:-}" in
    *--conditions=tldr-agent-test*:\/*)
      PATH="$(/usr/bin/dirname "$tldr_agent_node"):${PATH}"
      ;;
    *)
      PATH="$(/usr/bin/dirname "$tldr_agent_node"):/usr/bin:/bin"
      ;;
  esac
  export PATH
  TLDR_AGENT_NODE="$tldr_agent_node"
  export TLDR_AGENT_NODE
}
