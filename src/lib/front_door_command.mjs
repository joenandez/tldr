// The name of the tldr; front door command (`bin/tldr-agents`, the root
// package.json bin of the same name). Code in this package that builds a
// command string for a person or an agent to run takes the name from here.
//
// It is `tldr-agents`, not `tldr`: the tldr-pages CLI installs `tldr`
// (Joe, 2026-09-28). The package stays @joenandez/tldr and the plugin stays
// `tldr`. Helm (scheduling/src/lib/helm_context.mjs), Tightbeam
// (messaging/src/cli/package_context.mjs), and the two shell scripts that
// cannot import this module keep their own copy of the name, because their
// source trees must not import this one; tests/test_tldr_front_door.mjs
// checks every copy against package.json.
export const FRONT_DOOR_COMMAND = "tldr-agents";

// Front door names this package once installed and no longer does. A local
// update removes a leftover link for one of these only when it points into
// a snapshot the update owns (scripts/lib/local_cli_activation.mjs).
export const RETIRED_FRONT_DOOR_COMMANDS = Object.freeze(["tldr"]);

// Component commands the package once installed as bin aliases beside the
// front door (item 36). The component files now live in libexec/, which no
// host adds to PATH (Claude Code adds a plugin's bin/): the front door and
// the launchd services run them by path. The PATH links are retired, and a
// local update removes a leftover one on the same ownership rule as a
// retired front door name.
export const RETIRED_COMPONENT_COMMANDS = Object.freeze([
  "tldr-agent",
  "helm-tasks",
  "helm-assignments",
  "tightbeam",
  "tightbeam-daemon",
]);
