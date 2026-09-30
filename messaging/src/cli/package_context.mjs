import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const messagingRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const defaultPackageRoot = path.resolve(messagingRoot, '..');

// The unified package's front door command (`bin/tldr-agents`, the root
// package.json bin of the same name). Tightbeam runs under it as
// `tldr-agents messaging <args>`. Every Tightbeam string that names the front
// door takes the name from here; the root package keeps the same name in
// src/lib/front_door_command.mjs, which this tree must not import, and a
// root test checks the two agree.
export const FRONT_DOOR_COMMAND = 'tldr-agents';
export const FRONT_DOOR_MESSAGING_COMMAND = `${FRONT_DOOR_COMMAND} messaging`;

// The unified package keeps its component launchers (the dispatcher and
// this Tightbeam launcher) in libexec/, which no host adds to PATH; bin/
// holds only the front door (W6 lane L).
export function unifiedPackageTightbeamPath(packageRoot = defaultPackageRoot) {
  return existsSync(path.join(packageRoot, 'libexec', 'component-dispatch'))
    ? path.join(packageRoot, 'libexec', 'tightbeam')
    : null;
}

// The package's front door (`<package root>/bin/tldr-agents`), or null
// outside the unified package.
export function unifiedPackageFrontDoorPath(packageRoot = defaultPackageRoot) {
  return unifiedPackageTightbeamPath(packageRoot) === null
    ? null
    : path.join(packageRoot, 'bin', FRONT_DOOR_COMMAND);
}

// A path the shell passes through as one word, unquoted.
const SHELL_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

// This package's own front door as a runnable prefix: its absolute path
// (`<package root>/bin/tldr-agents messaging`), or the bare command when that
// path would need quoting or no package front door exists. Recipes name the exact launcher the hook and the
// skills resolve, not whatever `tldr-agents` PATH holds (a plugin-only
// install puts nothing on PATH), and the PreToolUse ACK gate admits this
// path only when it is the front door beside the hook's own CLI.
function unifiedMessagingRecipe(packageRoot) {
  const frontDoor = unifiedPackageFrontDoorPath(packageRoot);
  return frontDoor !== null && SHELL_WORD.test(frontDoor)
    ? `${frontDoor} messaging`
    : FRONT_DOOR_MESSAGING_COMMAND;
}

// The Tightbeam command prefix for a recipe the CLI prints for an agent to
// run (hook notifications, next actions). The standalone package and its
// `~/.tightbeam/install` launcher are retired (items 17 and 33), so every
// recipe names this package's front door.
export function tightbeamCommandHint(packageRoot = defaultPackageRoot) {
  return unifiedMessagingRecipe(packageRoot);
}

// The same recipe prefix for the ACK instruction, the unread-inbox action,
// and the acknowledge command. The ACK gate admits it.
export function tightbeamRecipeCommand(packageRoot = defaultPackageRoot) {
  return unifiedMessagingRecipe(packageRoot);
}

// The command name for prose and for text built where the package's own
// path is not the agent's launcher (the daemon's resume brief and safe
// actions, doctor and bootstrap remediation). Tracker item 36 removes the
// old aliases, so this names the front door.
export function tightbeamCommandName() {
  return FRONT_DOOR_MESSAGING_COMMAND;
}

// Rewrites a daemon-built action that starts with the bare front door
// command into this package's own recipe form, so a CLI prints one runnable
// launcher. Anything else is returned unchanged.
export function localTightbeamAction(action, packageRoot = defaultPackageRoot) {
  const bare = `${tightbeamCommandName()} `;
  return typeof action === 'string' && action.startsWith(bare)
    ? `${tightbeamRecipeCommand(packageRoot)} ${action.slice(bare.length)}`
    : action;
}
