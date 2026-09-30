#!/bin/sh
set -eu

# The tldr; front door command (bin/tldr-agents). Remediation names it, not
# this tldr-agent launcher, because the old bin aliases leave PATH (item 36).
front_door=tldr-agents
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
# State root defaults mirror src/lib/store.mjs (Phase E, item 19).
state_root_parent=${HOME}/.tldr-agents
tldr_agent_home=${TLDR_AGENT_HOME:-${state_root_parent}/agent}
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
  setup|status|configure|repair|uninstall|--help|-h|help) ;;
  *) echo "tldr-agent activation: invalid operation" >&2; exit 64 ;;
esac

show_help() {
  cat <<HELP
Usage: ${front_door} <command> [--json]

The plugin's libexec/tldr-agent launcher, run with no command, opens or focuses
the installed tldr; app in a macOS desktop session. In a headless session,
it reports read-only status.

Commands:
  configure  Open the installed app to change owner or replace the API key.
  setup      Install tldr; and continue onboarding. Refuses to replace a
             newer release or another product line unless
             --force-downgrade is given.
  status     Check installation and messaging readiness.
  repair     Repair the installation and messaging setup.
  uninstall  Open the app for uninstall confirmation.
  version    Print the active public or local development version.

Options:
  --json     Return the command result as JSON (the current default).
  -v, --version
             Print the active version without opening or installing anything.
  -h, --help Show this help without opening the app or installing anything.

Opening the app does not install or repair tldr; and does not require
healthy messaging. If the app is missing, run: ${front_door} setup
HELP
}

case "$operation" in --help|-h|help) show_help; exit 0 ;; esac
for argument in "$@"; do
  case "$argument" in --help|-h) show_help; exit 0 ;; esac
done
# --force-downgrade is consumed here (setup and repair only) and never reaches
# the installed runtime, which accepts --json alone.
force_downgrade=0
json_output=0
for argument in "$@"; do
  case "$argument" in
    --json) json_output=1 ;;
    --force-downgrade)
      case "$operation" in
        setup|repair) force_downgrade=1 ;;
        *) echo "tldr-agent: --force-downgrade applies to setup and repair only" >&2; exit 64 ;;
      esac
      ;;
    *) echo "tldr-agent: unsupported argument; run ${front_door} --help" >&2; exit 64 ;;
  esac
done
if [ "$json_output" = "1" ]; then set -- --json; else set --; fi

# This path deliberately precedes manifest checks and runtime activation.
# Settings must remain reachable when the messaging installation is unhealthy.
if [ "$operation" = "configure" ]; then
  if [ "$(tldr_default_operation)" != "configure" ]; then
    printf '{"ok":false,"data":null,"error":{"code":"NATIVE_APP_REQUIRES_GUI","message":"Opening tldr; requires a macOS desktop session.","retryable":false,"remediation":"Run %s configure in a macOS desktop session."}}\n' "$front_door"
    exit 1
  fi
  app_path='/Library/Application Support/Codename/Aegis/TldrAgentAegis.app'
  if [ ! -x "$app_path/Contents/MacOS/TldrAgentAegisSetup" ]; then
    printf '{"ok":false,"data":null,"error":{"code":"NATIVE_SETUP_NOT_INSTALLED","message":"tldr; is not installed.","retryable":false,"remediation":"%s setup"}}\n' "$front_door"
    exit 1
  fi
  signing_requirement='identifier "ai.codename.aegis.control" and anchor apple generic and certificate leaf[subject.OU] = "VVG962SM5J"'
  if ! /usr/bin/codesign --verify --deep --strict "-R=$signing_requirement" "$app_path" >/dev/null 2>&1; then
    printf '{"ok":false,"data":null,"error":{"code":"NATIVE_SETUP_INCOMPATIBLE","message":"tldr; app verification failed.","retryable":false,"remediation":"%s setup"}}\n' "$front_door"
    exit 1
  fi
  if ! /usr/bin/open "$app_path"; then
    printf '{"ok":false,"data":null,"error":{"code":"NATIVE_SETUP_UNAVAILABLE","message":"tldr; could not open.","retryable":true,"remediation":"Try %s configure again."}}\n' "$front_door"
    exit 1
  fi
  printf '%s\n' '{"ok":true,"data":{"status":"app-opened"},"error":null}'
  exit 0
fi
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
  if [ -f "${package_root}/LOCAL-SNAPSHOT-MANIFEST.json" ]; then
    TLDR_AGENT_PLUGIN_ROOT=${package_root}
    export TLDR_AGENT_PLUGIN_ROOT
    exec "$runtime_node" \
      "${package_root}/src/lib/local_snapshot_front_door.mjs" \
      "$operation" "$@"
  fi
  exec "$runtime_node" "$entrypoint" "$operation" "$@"
}

manifest_release() {
  /usr/bin/plutil -extract release raw -o - "$1" 2>/dev/null || true
}
# plutil reports a missing key on stdout, so its output counts only on success.
manifest_product() {
  product_value=$(/usr/bin/plutil -extract product raw -o - "$1" 2>/dev/null) || product_value=""
  printf '%s' "$product_value"
}

# Product identity (item 50). A manifest names its product in its product
# field; the unified product (tldr; + Helm + Tightbeam) is tldr-agents.
# Manifests from before the field (public tldr 1.x, unified 0.1.x) are read
# by release line instead: the unified product restarted at 0.1.0, so 0.x is
# the unified line and 1.x and later the public tldr line it supersedes.
unified_product=tldr-agents
release_line() {
  case "$1" in
    0.*) printf 'unified' ;;
    *) printf 'public' ;;
  esac
}
line_product() {
  case "$1" in
    0.*) printf '%s' "$unified_product" ;;
    *) printf 'public-tldr' ;;
  esac
}
# A product value as logs and messages print it.
product_text() {
  case "$1" in
    ''|*[!A-Za-z0-9._@/-]*) printf 'unrecognized' ;;
    *) printf '%s' "$1" ;;
  esac
}
# resolve_product_identity INSTALLED_MANIFEST INSTALLED_RELEASE THIS_RELEASE
# compares the installed manifest with this package's. It sets identity_rule:
#   product                    both name a product; compare the fields
#   version_line               the installed manifest names none; compare
#                              release lines (this side by its field if set)
#   product_incoming_missing   only the installed manifest names one; this
#                              package cannot prove it is the same product
# and installed_product, requested_product, installed_label, requested_label.
resolve_product_identity() {
  installed_product=$(manifest_product "$1")
  requested_product=$(manifest_product "$manifest")
  if [ -n "$installed_product" ]; then
    identity_rule=product
    [ -n "$requested_product" ] || identity_rule=product_incoming_missing
    installed_label="product $(product_text "$installed_product")"
  else
    identity_rule=version_line
    installed_product=$(line_product "$2")
    installed_label="$(release_line "$2") line"
  fi
  if [ -n "$requested_product" ]; then
    requested_label="product $(product_text "$requested_product")"
  else
    requested_product=$(line_product "$3")
    requested_label="$(release_line "$3") line"
  fi
}
same_product() {
  [ "$identity_rule" != "product_incoming_missing" ] && \
    [ "$installed_product" = "$requested_product" ]
}

if [ -x "$runtime_node" ] && [ -f "$entrypoint" ] && \
   [ -f "$installed_manifest" ] && [ -f "$manifest" ]; then
  installed_release=$(manifest_release "$installed_manifest")
  active_release=$(manifest_release "$manifest")
  if [ -n "$installed_release" ] && [ "$installed_release" = "$active_release" ]; then
    resolve_product_identity "$installed_manifest" "$installed_release" "$active_release"
    same_product && run_installed "$@"
    # The same release of another product is not this install; setup and
    # repair decide below whether to replace it.
    printf '{"ts":"%s","level":"warn","event":"install_fast_path_skipped","status":"other_product","params":{"operation":"bootstrap_%s","release":"%s","rule":"%s","installed_product":"%s","requested_product":"%s"}}\n' \
      "$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)" "$operation" "$(product_text "$installed_release")" "$identity_rule" \
      "$(product_text "$installed_product")" "$(product_text "$requested_product")" >&2
  fi
fi

case "$operation" in
  setup|repair) ;;
  *)
    printf '%s\n' '{"ok":true,"data":{"state":"setup-required","next_action":"setup"},"error":null}'
    exit 0
    ;;
esac

# Legacy guard (assertStateRootsCreatable in src/lib/store.mjs): setup and
# repair create the state roots, so they refuse while a root at its default
# location is missing and its legacy root is still a real directory.
legacy_root_pending() {
  [ "$1" = "$2" ] && [ ! -e "$1" ] && [ -d "$3" ] && [ ! -L "$3" ]
}
pending_roots=""
if legacy_root_pending "$tldr_agent_home" "${state_root_parent}/agent" "${HOME}/.tldr-agent"; then
  pending_roots="${pending_roots} agent"
fi
if legacy_root_pending "${state_root_parent}/helm" "${state_root_parent}/helm" "${HOME}/.helm"; then
  pending_roots="${pending_roots} helm"
fi
if legacy_root_pending "${TIGHTBEAM_STATE_ROOT:-${state_root_parent}/tightbeam}" "${state_root_parent}/tightbeam" "${HOME}/.tightbeam"; then
  pending_roots="${pending_roots} tightbeam"
fi
if [ -n "$pending_roots" ]; then
  printf '{"ts":"%s","level":"warn","event":"state_root_migration_pending","status":"refused","params":{"operation":"bootstrap_%s","pending":"%s"}}\n' \
    "$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)" "$operation" "${pending_roots# }" >&2
  printf '%s\n' '{"ok":false,"data":null,"error":{"code":"STATE_ROOT_MIGRATION_PENDING","message":"tldr; state has not moved to ~/.tldr-agents yet.","retryable":false,"remediation":"Move tldr; state into ~/.tldr-agents, then try again."}}'
  exit 1
fi

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

# Replacement rule (item 43). A stale package must never replace a newer
# install or another product's install: on 2026-09-28 an orphaned public
# tldr 1.0.0 cache reinstalled itself over the unified install because its
# bootstrap replaced on any release mismatch.
#
# Identity of an install is read from its activation-manifest.json and its
# tldr-agent/package.json:
#   package   package.json name, which is @joenandez/tldr for every line.
#   schema    the manifest schema_version, which must be 1.
#   product   the manifest product field when both manifests carry it, else
#             the release line (resolve_product_identity above, item 50).
# Releases are X.Y.Z with an optional -prerelease and order by semver
# precedence. A local update stamps X.Y.(Z+1)-local.<hash>, which sorts
# after X.Y.Z and before the real X.Y.(Z+1); two local builds of one base
# carry no order and replace each other.
#
# Decisions, installed compared with this package:
#   other package or schema, or an unreadable release   refuse, always
#   public tldr line under this unified package          replace (supersede)
#   any other product difference                         refuse
#   same line, installed newer                           refuse
#   same line, installed older, equal, or a sibling      replace
# --force-downgrade overrides the product-line and newer refusals. It cannot
# override a different package: the lifecycle replacement evidence below
# needs an @joenandez/tldr install. An equal release with a complete install
# never gets here; the fast path at the top runs it instead.
release_is_valid() {
  printf '%s\n' "$1" | /usr/bin/grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
}
# Prints older, same, newer, or sibling: the first release relative to the
# second, by semver precedence.
compare_releases() {
  /usr/bin/awk -v a="$1" -v b="$2" '
    function core(v) { sub(/-.*/, "", v); return v }
    function pre(v) { return index(v, "-") ? substr(v, index(v, "-") + 1) : "" }
    function cmp(x, y,  xn, yn) {
      xn = (x ~ /^[0-9]+$/); yn = (y ~ /^[0-9]+$/)
      if (xn && yn) return (x + 0 < y + 0) ? -1 : (x + 0 > y + 0)
      if (xn) return -1
      if (yn) return 1
      return (x < y) ? -1 : (x > y)
    }
    function verdict(c) { print (c < 0 ? "older" : "newer"); exit }
    BEGIN {
      split(core(a), ac, "."); split(core(b), bc, ".")
      for (i = 1; i <= 3; i++) { c = cmp(ac[i], bc[i]); if (c) verdict(c) }
      ap = pre(a); bp = pre(b)
      if (ap == bp) { print "same"; exit }
      if (ap == "") verdict(1)
      if (bp == "") verdict(-1)
      if (ap ~ /^local\./ && bp ~ /^local\./) { print "sibling"; exit }
      na = split(ap, ai, "."); nb = split(bp, bi, ".")
      for (i = 1; i <= na && i <= nb; i++) { c = cmp(ai[i], bi[i]); if (c) verdict(c) }
      if (na == nb) print "same"; else verdict(na < nb ? -1 : 1)
    }'
}
log_replacement_decision() {
  printf '{"ts":"%s","level":"%s","event":"install_replacement_decision","status":"%s","params":{"operation":"bootstrap_%s","installed_release":"%s","requested_release":"%s","decision":"%s","rule":"%s","installed_product":"%s","requested_product":"%s","force_downgrade":%s}}\n' \
    "$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$operation" "$3" "$release" "$4" \
    "$identity_rule" "$(product_text "$installed_product")" "$(product_text "$requested_product")" \
    "$([ "$force_downgrade" = "1" ] && printf true || printf false)" >&2
}
refuse_replacement() {
  printf '{"ok":false,"data":null,"error":{"code":"%s","message":"%s","retryable":false,"remediation":"%s"}}\n' "$1" "$2" "$3"
  exit 1
}
check_install_replacement() {
  installed_package_json="${install_root}/tldr-agent/package.json"
  # Absent evidence is handled by capture_prior_source below.
  [ -f "$installed_manifest" ] && [ -f "$installed_package_json" ] || return 0
  installed_release=$(manifest_release "$installed_manifest")
  installed_schema=$(/usr/bin/plutil -extract schema_version raw -o - "$installed_manifest" 2>/dev/null || true)
  installed_name=$(/usr/bin/plutil -extract name raw -o - "$installed_package_json" 2>/dev/null || true)
  if ! release_is_valid "$installed_release"; then
    installed_release=unrecognized
  fi
  resolve_product_identity "$installed_manifest" "$installed_release" "$release"
  if [ "$installed_name" != "@joenandez/tldr" ] || [ "$installed_schema" != "1" ] || \
     [ "$installed_release" = "unrecognized" ]; then
    log_replacement_decision error refused "$installed_release" other_package
    refuse_replacement INSTALLED_PACKAGE_DIFFERENT \
      "The install at ${install_root} (release ${installed_release}) belongs to another package; this package (release ${release}) cannot replace it. Nothing was changed." \
      "Leave it in place, or move ${install_root} aside yourself and run ${front_door} setup again."
  fi
  if ! same_product; then
    if [ "$identity_rule" = "version_line" ] && \
       [ "$(release_line "$installed_release")" = "public" ] && \
       [ "$requested_product" = "$unified_product" ]; then
      log_replacement_decision info allowed "$installed_release" supersede_public_line
      return 0
    fi
    difference=other_product
    [ "$identity_rule" != "version_line" ] || difference=other_product_line
    if [ "$force_downgrade" = "1" ]; then
      log_replacement_decision warn forced "$installed_release" "$difference"
      return 0
    fi
    log_replacement_decision error refused "$installed_release" "$difference"
    refuse_replacement INSTALLED_PRODUCT_DIFFERENT \
      "tldr; ${installed_release} (${installed_label}) is installed; this package is ${release} (${requested_label}), a different product. Nothing was changed." \
      "Run setup from the package that installed ${installed_release}, or rerun setup with --force-downgrade to replace it with ${release}."
  fi
  order=$(compare_releases "$installed_release" "$release")
  if [ "$order" = "newer" ]; then
    if [ "$force_downgrade" = "1" ]; then
      log_replacement_decision warn forced "$installed_release" downgrade
      return 0
    fi
    log_replacement_decision error refused "$installed_release" downgrade
    refuse_replacement INSTALLED_RELEASE_NEWER \
      "tldr; ${installed_release} is installed, which is newer than this package's release ${release}. Nothing was changed." \
      "Run setup from the package that installed ${installed_release}, or rerun setup with --force-downgrade to replace it with ${release}."
  fi
  log_replacement_decision info allowed "$installed_release" "replace_${order}"
}
if [ -e "$install_root" ]; then
  release_is_valid "$release" || {
    echo "tldr-agent activation: release integrity metadata invalid" >&2
    exit 68
  }
  check_install_replacement
fi

verify_file plugin_manifest >/dev/null
verify_file node_license >/dev/null
runtime_archive=$(verify_file "architectures.${architecture}.runtime")
source_archive=$(verify_file "architectures.${architecture}.tldr_agent")
aegis_package=$(verify_file "architectures.${architecture}.aegis")

prior_evidence="${tldr_agent_home}/tldr-agent-presplit-lifecycle.json"
prior_origin="${tldr_agent_home}/tldr-agent-lifecycle-origin.json"
verified_presplit_version="1.1.0"
verified_presplit_source_sha="33da40b4c8c830d0bb69eec6fbc2819afe97d77ccaa3c2b5c951a4d17fbfd74b"
verified_presplit_archive_sha="3f5505944fcea137e520d446a3a76e9cf06e7f9badffff8def716c16be9d8f45"
# A local update stamps <major>.<minor>.<patch+1>-local.<12 hex> over the
# installed package version (nextLocalVersion in the local snapshot builder).
prior_release_matches() {
  [ "$prior_release" = "$prior_version" ] && return 0
  local_base=$(printf '%s\n' "$prior_version" | \
    /usr/bin/sed -nE 's/^([0-9]+)\.([0-9]+)\.([0-9]+)([-+][0-9A-Za-z.+-]*)?$/\1.\2.\3/p')
  [ -n "$local_base" ] || return 1
  local_prefix="${local_base%.*}.$((${local_base##*.} + 1))-local."
  case "$prior_release" in
    "$local_prefix"[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) return 0 ;;
  esac
  return 1
}
capture_prior_source() {
  [ -e "$install_root" ] || return
  [ ! -e "$prior_evidence" ] || {
    echo "tldr-agent activation: prior lifecycle evidence is unresolved" >&2
    exit 70
  }
  prior_source="$install_root/tldr-agent/src/lib/tldr_agent_source_lifecycle.mjs"
  prior_package="$install_root/tldr-agent/package.json"
  prior_manifest="$install_root/activation-manifest.json"
  [ -f "$prior_source" ] && [ -f "$prior_package" ] && [ -f "$prior_manifest" ] || {
    echo "tldr-agent activation: prior source evidence is unavailable" >&2
    exit 70
  }
  prior_name=$(/usr/bin/plutil -extract name raw -o - "$prior_package" 2>/dev/null || true)
  prior_version=$(/usr/bin/plutil -extract version raw -o - "$prior_package" 2>/dev/null || true)
  prior_release=$(/usr/bin/plutil -extract release raw -o - "$prior_manifest" 2>/dev/null || true)
  prior_schema=$(/usr/bin/plutil -extract schema_version raw -o - "$prior_manifest" 2>/dev/null || true)
  prior_record_sha=$(/usr/bin/plutil -extract "architectures.${architecture}.tldr_agent.sha256" raw -o - "$prior_manifest" 2>/dev/null || true)
  [ "$prior_name" = "@joenandez/tldr" ] && prior_release_matches && \
    [ "$prior_schema" = "1" ] || {
    echo "tldr-agent activation: prior source evidence is invalid" >&2
    exit 70
  }
  case "$prior_version" in *[!A-Za-z0-9._+-]*|'') echo "tldr-agent activation: prior source version is invalid" >&2; exit 70 ;; esac
  case "$prior_record_sha" in [0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]*) ;; *) echo "tldr-agent activation: prior source record is invalid" >&2; exit 70 ;; esac
  [ "${#prior_record_sha}" -eq 64 ] || { echo "tldr-agent activation: prior source record is invalid" >&2; exit 70; }
  prior_source_sha=$(/usr/bin/shasum -a 256 "$prior_source" | /usr/bin/awk '{print $1}')
  case "$prior_source_sha" in [0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]*) ;; *) echo "tldr-agent activation: prior source digest is invalid" >&2; exit 70 ;; esac
  [ "${#prior_source_sha}" -eq 64 ] || { echo "tldr-agent activation: prior source digest is invalid" >&2; exit 70; }
  if [ -e "$prior_origin" ]; then
    origin_schema=$(/usr/bin/plutil -extract schema_version raw -o - "$prior_origin" 2>/dev/null || true)
    origin_store_schema=$(/usr/bin/plutil -extract lifecycle_store_schema_version raw -o - "$prior_origin" 2>/dev/null || true)
    origin_state=$(/usr/bin/plutil -extract state raw -o - "$prior_origin" 2>/dev/null || true)
    [ "$origin_schema" = "1" ] && [ "$origin_store_schema" = "1" ] && \
      [ "$origin_state" = "dedicated_lifecycle_store" ] || {
      echo "tldr-agent activation: prior lifecycle origin is invalid" >&2
      exit 70
    }
    prior_kind="post_split"
  else
    [ "$prior_version" = "$verified_presplit_version" ] && \
      [ "$prior_source_sha" = "$verified_presplit_source_sha" ] && \
      [ "$prior_record_sha" = "$verified_presplit_archive_sha" ] || {
      echo "tldr-agent activation: prior source is not a verified pre-split release" >&2
      exit 70
    }
    prior_kind="verified_pre_split"
  fi
  (umask 077; set -C; printf '{"schema_version":2,"package_name":"@joenandez/tldr","package_version":"%s","source_lifecycle_sha256":"%s","source_record_sha256":"%s","prior_source_kind":"%s"}\n' "$prior_version" "$prior_source_sha" "$prior_record_sha" "$prior_kind" > "$prior_evidence") || {
    echo "tldr-agent activation: prior source evidence cannot be captured" >&2
    exit 70
  }
}

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
  [ -f "$stage/tldr-agent/src/starport.mjs" ] || {
  echo "tldr-agent activation: activated release incomplete" >&2
  exit 69
}
/bin/cp "$aegis_package" "$stage/TldrAgentAegis.pkg"
/bin/cp "$manifest" "$stage/activation-manifest.json"
/bin/chmod -R go-rwx "$stage"

if [ -e "$install_root" ]; then
  capture_prior_source
  [ ! -e "$previous" ] || { echo "tldr-agent activation: prior rollback path exists" >&2; exit 70; }
  if ! /bin/mv "$install_root" "$previous"; then
    /bin/rm -f "$prior_evidence"
    exit 70
  fi
fi
if ! /bin/mv "$stage" "$install_root"; then
  [ ! -e "$previous" ] || /bin/mv "$previous" "$install_root"
  /bin/rm -f "$prior_evidence"
  exit 70
fi
stage=""
/bin/rm -rf "$previous"

[ "$(field release)" = "$release" ] || exit 68
run_installed "$@"
