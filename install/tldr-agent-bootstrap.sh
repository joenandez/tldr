#!/bin/sh
set -eu

package_root=""
tldr_default_operation() {
  if [ "${TLDR_AGENT_ASSUME_GUI_SESSION:-}" = "0" ]; then printf 'status'; return; fi
  if [ "${TLDR_AGENT_ASSUME_GUI_SESSION:-}" = "1" ]; then printf 'configure'; return; fi
  if [ -n "${CI:-}" ]; then printf 'status'; return; fi
  if [ "$(/bin/launchctl managername 2>/dev/null || true)" = "Aqua" ]; then
    printf 'configure'
  else
    printf 'status'
  fi
}
operation="$(tldr_default_operation)"
tldr_agent_home=${TLDR_AGENT_HOME:-${HOME}/.tldr-agent}
install_root="${tldr_agent_home}/install"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --package-root) package_root=${2-}; shift 2 ;;
    --install-root) install_root=${2-}; shift 2 ;;
    --operation) operation=${2-}; shift 2; break ;;
    *) echo "tldr-agent activation: invalid argument" >&2; exit 64 ;;
  esac
done

case "$operation" in
  setup|status|configure|repair|uninstall) ;;
  *) echo "tldr-agent activation: invalid operation" >&2; exit 64 ;;
esac
[ -n "$package_root" ] || {
  package_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
}
case "$package_root" in /*) ;; *) echo "tldr-agent activation: package root must be absolute" >&2; exit 64 ;; esac

runtime_node="${install_root}/runtime/bin/node"
entrypoint="${install_root}/tldr-agent/src/starport.mjs"
manifest="${package_root}/release/activation-manifest.json"
installed_manifest="${install_root}/activation-manifest.json"
run_installed() {
  PATH="${install_root}/runtime/bin:/usr/bin:/bin"
  export PATH TLDR_AGENT_HOME
  exec "$runtime_node" "$entrypoint" "$operation" "$@"
}

manifest_release() {
  /usr/bin/plutil -extract release raw -o - "$1" 2>/dev/null || true
}

if [ -x "$runtime_node" ] && [ -f "$entrypoint" ] && \
   [ -f "$installed_manifest" ] && [ -f "$manifest" ]; then
  installed_release=$(manifest_release "$installed_manifest")
  active_release=$(manifest_release "$manifest")
  if [ -n "$installed_release" ] && [ "$installed_release" = "$active_release" ]; then
    run_installed "$@"
  fi
fi

case "$operation" in
  setup|configure|repair) ;;
  *)
    printf '%s\n' '{"ok":true,"data":{"state":"setup-required","next_action":"setup"},"error":null}'
    exit 0
    ;;
esac

[ -f "$manifest" ] || {
  echo "tldr-agent activation: release integrity metadata missing" >&2
  exit 68
}

field() {
  /usr/bin/plutil -extract "$1" raw -o - "$manifest" 2>/dev/null
}
[ "$(field schema_version)" = "1" ] || {
  echo "tldr-agent activation: release integrity metadata invalid" >&2
  exit 68
}
release=$(field release)
architecture=$(/usr/bin/uname -m)
case "$architecture" in arm64|x86_64) ;; *) echo "tldr-agent activation: architecture incompatible" >&2; exit 67 ;; esac

verify_file() {
  prefix=$1
  relative_path=$(field "$prefix.path")
  case "$relative_path" in
    ""|/*|../*|*/../*|*/..) echo "tldr-agent activation: release integrity path invalid" >&2; exit 68 ;;
  esac
  path="${package_root}/${relative_path}"
  [ -f "$path" ] || { echo "tldr-agent activation: release integrity file missing" >&2; exit 68; }
  expected_bytes=$(field "$prefix.bytes")
  expected_sha=$(field "$prefix.sha256")
  actual_bytes=$(/usr/bin/stat -f %z "$path")
  actual_sha=$(/usr/bin/shasum -a 256 "$path" | /usr/bin/awk '{print $1}')
  [ "$actual_bytes" = "$expected_bytes" ] && [ "$actual_sha" = "$expected_sha" ] || {
    echo "tldr-agent activation: release integrity check failed" >&2
    exit 68
  }
  printf '%s\n' "$path"
}

verify_file plugin_manifest >/dev/null
verify_file hook_manifest >/dev/null
verify_file node_license >/dev/null
runtime_archive=$(verify_file "architectures.${architecture}.runtime")
source_archive=$(verify_file "architectures.${architecture}.tldr_agent")
aegis_package=$(verify_file "architectures.${architecture}.aegis")

install_parent=$(/usr/bin/dirname "$install_root")
/bin/mkdir -p "$install_parent"
stage=$(/usr/bin/mktemp -d "${install_parent}/.tldr-agent-install.XXXXXX")
previous="${install_parent}/.tldr-agent-previous.$$"
cleanup() {
  [ -z "${stage:-}" ] || /bin/rm -rf "$stage"
}
trap cleanup EXIT HUP INT TERM
/bin/mkdir -p "$stage/runtime" "$stage/tldr-agent"
/usr/bin/tar -xzf "$runtime_archive" --strip-components=1 -C "$stage/runtime"
/usr/bin/tar -xzf "$source_archive" -C "$stage/tldr-agent"
[ -x "$stage/runtime/bin/node" ] && \
  [ -f "$stage/tldr-agent/src/starport.mjs" ] && \
  [ -f "$stage/tldr-agent/src/tldr-agent.mjs" ] || {
  echo "tldr-agent activation: activated release incomplete" >&2
  exit 69
}
/bin/cp "$aegis_package" "$stage/TldrAgentAegis.pkg"
/bin/cp "$manifest" "$stage/activation-manifest.json"
/bin/chmod -R go-rwx "$stage"

if [ -e "$install_root" ]; then
  [ ! -e "$previous" ] || { echo "tldr-agent activation: prior rollback path exists" >&2; exit 70; }
  /bin/mv "$install_root" "$previous"
fi
if ! /bin/mv "$stage" "$install_root"; then
  [ ! -e "$previous" ] || /bin/mv "$previous" "$install_root"
  exit 70
fi
stage=""
/bin/rm -rf "$previous"

[ "$(field release)" = "$release" ] || exit 68
run_installed "$@"
