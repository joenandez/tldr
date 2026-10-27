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

// This package's source-owned Copilot plugin hooks file, the artifact a
// `--plugin-dir <package root>/.copilot-plugin` load runs.
export function unifiedPackageCopilotPluginHooksPath(packageRoot = defaultPackageRoot) {
  return path.join(packageRoot, '.copilot-plugin', 'hooks', 'hooks.json');
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

// The front door a Copilot recipe runs: this package's own path, POSIX
// single-quoted when the shell would split it. Never the bare command for a
// path that needs quoting, because a plugin-only install puts nothing on PATH.
export function quotedMessagingRecipe(packageRoot = defaultPackageRoot) {
  const frontDoor = unifiedPackageFrontDoorPath(packageRoot);
  if (frontDoor === null) return FRONT_DOOR_MESSAGING_COMMAND;
  return `${SHELL_WORD.test(frontDoor) ? frontDoor : `'${frontDoor.replaceAll("'", `'\\''`)}'`} messaging`;
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

export function tightbeamCodexWaitRecipe() {
  const command = JSON.stringify(
    `${tightbeamRecipeCommand()} agent wait --timeout 350s --json`,
  );
  return `Run this wait command, then stop again after it returns:\n` +
    `// @exec: {"yield_time_ms": 360000}\n` +
    `let result = await tools.exec_command({ cmd: ${command}, yield_time_ms: 30000 });\n` +
    `let session_id = result.session_id;\n` +
    `while (session_id) {\n` +
    `  result = await tools.write_stdin({ session_id, chars: "", yield_time_ms: 300000 });\n` +
    `  session_id = result.session_id;\n` +
    `}\n` +
    `text(result.output);`;
}

// The exact commands that answer a pending delegation offer. Every surface
// that tells a delegate about an offer (notification, resume brief, receive,
// threads, status) builds them here so they read the same. `prefix` is the
// recipe prefix, or the bare command name where the package path is not the
// agent's launcher (the daemon's resume brief).
export function offerActionCommands(delegationId, prefix = tightbeamRecipeCommand()) {
  return {
    accept: `${prefix} agent accept --work ${delegationId} --body "<note>"`,
    decline: `${prefix} agent decline --work ${delegationId} --body "<reason>"`,
  };
}

// F23: the exact commands the holder of tracked work runs with its work id.
// Every surface that presents a request to its holder (notification, resume
// and spawn briefs, receive, threads, thread) builds them here so they read
// the same. `ack` applies only to work that arrived as a user message.
export function workActionCommands(workId, prefix = tightbeamRecipeCommand()) {
  return {
    ack: `${prefix} agent ack --work ${workId} --body "<progress>"`,
    update: `${prefix} agent update --work ${workId} --body "<progress>"`,
    complete: `${prefix} agent complete --work ${workId} --body "<result>"`,
    delegate: `${prefix} agent delegate --work ${workId} --to session:<session-id> --body "<instructions>"`,
  };
}

// The text lines for held work, in one fixed order: the work id, then update,
// complete, delegate, and (only when owed) ack. `commandSuffix` turns `Update`
// into `Update command`, as the notification block words its other commands.
export function workActionLines(work, { prefix = tightbeamRecipeCommand(), indent = '', workLabel = 'Work', commandSuffix = '' } = {}) {
  const commands = workActionCommands(work.work_id, prefix);
  return [
    `${indent}${workLabel}: ${work.work_id} · you hold this request`,
    `${indent}Update${commandSuffix}: ${commands.update}`,
    `${indent}Complete${commandSuffix}: ${commands.complete}`,
    `${indent}Delegate${commandSuffix}: ${commands.delegate}`,
    ...(work.ack_pending ? [`${indent}Ack${commandSuffix}: ${commands.ack}`] : []),
  ];
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
