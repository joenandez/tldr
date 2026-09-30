// `tightbeam hooks install|uninstall` — idempotent, tagged, atomic merge
// of Tightbeam's five lifecycle hooks into a runtime's settings file.
// Adapted from helm/src/lib/bootstrap_hooks.mjs (marker-tagged matcher-
// less group, temp-then-rename write, one settings shape written to two
// paths — see the internal provenance record).
//
//   claude  ->  ~/.claude/settings.json
//   codex   ->  ~/.codex/hooks.json      (Claude-Code-shaped JSON)
//
// Codex has a SECOND, incompatible hook surface: `[hooks]` in
// ~/.codex/config.toml uses snake_case event names, argv arrays, and a
// hyphenated payload (`thread-id`, `session-id`). This installer targets
// hooks.json only and never writes config.toml.
//
// Two deliberate departures from the source, both about not damaging a
// file we do not own:
//
//  1. **Replace in place, never re-append.** Codex records per-entry trust
//     in config.toml under `[hooks.state."<hooks.json path>:<event>:<group
//     index>:<hook index>"]` — the key embeds the INDEX. Helm's planChanges
//     rebuilds the array as `[...filtered, desired]`, which shifts every
//     foreign group that followed ours and silently invalidates trust for
//     entries the installer never touched. Ours keeps every foreign group
//     at its original index and only ever appends when nothing of ours is
//     present.
//
//     UNINSTALL cannot make that promise, and does not pretend to:
//     deleting an element from the middle of an array shifts every
//     element behind it. So it reports the trust keys that shift
//     (shiftedCodexTrustKeys), and the CLI prints them, because the one
//     thing worse than a re-approval prompt is a silent one.
//  2. **No write when nothing changed.** Byte-identical re-install is a
//     stated exit criterion; comparing the serialized result against the
//     file's current bytes is the only way to guarantee it.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

// The runtime leaf is shared truth (the architecture contract §5): every runtime
// this installer touches — target set, settings paths, admission gates —
// resolves through a registry instance, never a local table. Admission
// itself lives in the leaf so registration and startup load enforce the
// same contract; the installer re-exports it as defense in depth.
import { admitHookContract, createRuntimeRegistry, HOOK_ADMISSION_ERROR_CODES } from '../runtimes/registry.mjs';
import { REPLY_BINDING_POLICY } from '../protocol/reply_listener_policy.mjs';
import { unifiedPackageFrontDoorPath, unifiedPackageTightbeamPath } from './package_context.mjs';

export { admitHookContract, HOOK_ADMISSION_ERROR_CODES };

export const TIGHTBEAM_MARKER = 'tightbeam-managed:runtime-hooks-v2';

// Every marker generation this installer recognises as its own. A future
// generation appends here so an old install is cleanly replaced (and
// removed) instead of being left behind as a duplicate.
export const TIGHTBEAM_MARKERS = [TIGHTBEAM_MARKER, 'tightbeam-managed:runtime-hooks-v1'];

/**
 * Deprecated shim, kept only because doctor_checks.mjs (mid-repair by
 * another worker and off-limits here) still imports it to guess --runtime
 * tokens by settings-path equality. The registry-derived target set is
 * `registry.names()`; new consumers must not use this constant.
 */
export const RUNTIMES = ['claude', 'codex'];

// ---------------------------------------------------------------------------
// Admission gates live in src/runtimes/registry.mjs (admitHookContract):
// registration and startup load refuse an unsupported contract there, and
// bootstrapHooks re-checks every target before writing — one silent
// registration must never become a host-wide install outage.
// ---------------------------------------------------------------------------

function namedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// The event map, matching helm/src/lib/bootstrap_hooks.mjs:46-50. The
// three direct events register the CLI verb, because a script that only
// re-invokes the CLI is a pass-through; the two tool-boundary events must
// stay shell so no Node process starts at every tool call.
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'PreToolUse', 'PostToolUse'];
const STOP_TIMEOUT_SECONDS = Math.ceil(REPLY_BINDING_POLICY.maxParkMs / 1000) + 60;

const DIRECT_VERBS = { SessionStart: 'session-start', UserPromptSubmit: 'user-prompt-submit', Stop: 'stop' };
const SCRIPT_FILES = { PreToolUse: 'pre-tool-use', PostToolUse: 'post-tool-use' };

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

// Hooks run only from the unified package: its front door runs every hook
// verb, and for the two tool-boundary events the shipped shell gates. The
// standalone package, its activator, and its `~/.tightbeam/install` launcher
// were retired (items 17 and 33), so outside the unified package there is no
// command to install and the installer refuses by name.
function unifiedHookLaunchers(packageRoot) {
  const cli = unifiedPackageTightbeamPath(packageRoot);
  const frontDoor = unifiedPackageFrontDoorPath(packageRoot);
  if (cli === null || frontDoor === null) {
    throw namedError(
      'unified_package_missing',
      `no tldr-agents package at ${packageRoot} (libexec/component-dispatch is absent); Tightbeam hooks install only from the unified package`,
    );
  }
  return { cli, frontDoor };
}

// A settings command is a shell string. Quote anything outside the set of
// characters a shell passes through unchanged, so an install under a path
// with a space still produces a runnable command.
function shellQuote(value) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

// A builtins-only view for callers that hold no registry (unit tests,
// direct library use). The CLI always passes a state-root-scoped instance.
let sharedBuiltinRegistry = null;
function builtinOnlyRegistry() {
  if (sharedBuiltinRegistry === null) {
    sharedBuiltinRegistry = createRuntimeRegistry({ stateRoot: '(builtins-only)' });
  }
  return sharedBuiltinRegistry;
}

/**
 * The settings file a runtime record declares, resolved against `home`.
 * Builtins ship home-relative paths ('.claude/settings.json'), which is why
 * a relative manifest path joins home too; '~/…' expands the same way
 * doctor resolves it. Bare '~' would resolve to the home directory itself —
 * a rename onto $HOME — and a '~user' form has no resolution Tightbeam
 * owns; both are named refusals rather than silent joins.
 */
export function recordSettingsPath(record, home = homedir()) {
  const declared = record.hooksInstall.settingsPath;
  if (declared.startsWith('~/')) return path.join(home, declared.slice(2));
  if (declared.startsWith('~')) {
    throw namedError('invalid_settings_path', `hooksInstall.settingsPath "${declared}" does not name a settings file (bare "~" and "~user" forms are unsupported); declare an absolute or home-relative path`);
  }
  return path.isAbsolute(declared) ? declared : path.join(home, declared);
}

/**
 * The settings file for one runtime id — canonical, legacy alias, or
 * registered manifest id — as resolved through `registry`. An unknown id is
 * a named rejection, never a fallback to defaults.
 */
export function settingsPathFor(runtime, home = homedir(), registry = builtinOnlyRegistry()) {
  const record = registry.get(runtime);
  if (!record) {
    throw namedError('unknown_runtime', `unknown runtime: ${runtime} (registered runtimes: ${registry.names().join(', ')})`);
  }
  return recordSettingsPath(record, home);
}

/**
 * One hook's shell command line. `runtimeBinding` is set only for
 * manifest-origin runtimes: their command lines append
 * `--runtime <canonical-id>` so downstream identity never sniffs — a Grok
 * or Muse hook reading Claude-shaped config would otherwise resolve as
 * claude-code and corrupt endpoint identity. Builtins keep their exact
 * historical bytes.
 */
export function hookCommandFor(event, {
  packageRoot = path.resolve(repoRoot(), '..'),
  runtimeBinding,
} = {}) {
  if (!DIRECT_VERBS[event] && !SCRIPT_FILES[event]) throw new Error(`unknown hook event: ${event}`);
  // Every hook runs through the tldr; front door
  // (`tldr-agents messaging hook <event>`), as the plugin's hooks.json does.
  // It runs the same hook verb, and for the two tool-boundary events the same
  // shell gates, so the watermark fast path still starts no Node process.
  const { cli, frontDoor } = unifiedHookLaunchers(packageRoot);
  const binding = runtimeBinding === undefined ? '' : ` --runtime ${shellQuote(runtimeBinding)}`;
  const runtimeEnvironment = runtimeBinding === undefined ? '' : `TIGHTBEAM_RUNTIME=${shellQuote(runtimeBinding)} `;
  if (DIRECT_VERBS[event]) return `${shellQuote(frontDoor)} messaging hook ${DIRECT_VERBS[event]}${binding}`;
  // The binding reaches the shell as data, preserving its watermark fast
  // path. Only the script's slow path starts the package CLI with --runtime.
  return `TIGHTBEAM_CLI=${shellQuote(cli)} ${runtimeEnvironment}${shellQuote(frontDoor)} messaging hook ${SCRIPT_FILES[event]}`;
}

// Claude Code's canonical hooks structure, which Codex 0.148.0 reads
// unchanged from ~/.codex/hooks.json:
//   { "hooks": { "<Event>": [ { "hooks": [ { "type": "command", ... } ] } ] } }
export function buildHookGroup(event, options) {
  const hook = { type: 'command', command: hookCommandFor(event, options), _tightbeam: TIGHTBEAM_MARKER };
  if (event === 'Stop') hook.timeout = STOP_TIMEOUT_SECONDS;
  return { hooks: [hook] };
}

function isTightbeamGroup(group, recognizedCommands) {
  if (!group || !Array.isArray(group.hooks)) return false;
  return group.hooks.some((hook) => isTightbeamHook(hook, recognizedCommands));
}

function isTightbeamHook(hook, recognizedCommands) {
  return hook && (
    (typeof hook._tightbeam === 'string' && TIGHTBEAM_MARKERS.includes(hook._tightbeam))
    || (recognizedCommands instanceof Set && recognizedCommands.has(hook.command))
  );
}

function isCompatibleCodexLifecycleGroup(event, group) {
  const commands = group?.hooks
    ?.map?.((hook) => hook?.command)
    .filter((command) => typeof command === 'string');
  if (!commands) return false;
  if (event === 'SessionStart') return commands.some((command) => command.includes('subspace-codex-session-start.sh'));
  if (event === 'Stop') return commands.some((command) => command.includes('subspace-codex-stop-lifecycle.sh'));
  return false;
}

// Codex names an event in a trust key the way it names it in config.toml:
// snake_case. Derived rather than tabulated so a new entry in HOOK_EVENTS
// cannot silently produce a key that names nothing.
function codexEventKey(event) {
  return event.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * The `[hooks.state."…"]` trust keys an uninstall invalidates, in the
 * order they appear in the file: every hook from our group's index to the
 * end of the event array, because removing ours shifts all of them down
 * one and Codex keys trust by position. An event where nothing followed
 * ours shifts nothing and yields no key.
 *
 * Reads the settings value as it is BEFORE the removal — the keys name
 * positions the user already approved.
 */
export function shiftedCodexTrustKeys(file, settingsValue, { recognizedCommands } = {}) {
  const hooks = settingsValue?.hooks;
  const keys = [];
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return keys;
  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    const removedAt = groups.findIndex((group) => isTightbeamGroup(group, recognizedCommands));
    if (removedAt < 0 || removedAt === groups.length - 1) continue;
    for (let group = removedAt; group < groups.length; group += 1) {
      const entries = Array.isArray(groups[group]?.hooks) ? groups[group].hooks : [];
      for (let hook = 0; hook < entries.length; hook += 1) keys.push(`${file}:${codexEventKey(event)}:${group}:${hook}`);
    }
  }
  return keys;
}

function readSettings(file) {
  if (!existsSync(file)) return { exists: false, raw: null, value: {} };
  const raw = readFileSync(file, 'utf8');
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not a JSON object');
    return { exists: true, raw, value };
  } catch (err) {
    throw new Error(`failed to parse ${file}: ${err.message}`);
  }
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Temp-then-rename inside the destination directory, so the rename is
 * atomic on the same filesystem: a crash mid-install can leave a stray
 * temp file but never a truncated settings.json, which is the user's file
 * and breaks their whole runtime if corrupted.
 */
function atomicWrite(file, contents) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, contents, 'utf8');
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Computes the next settings value and a per-event change list. Pure: it
 * neither reads nor writes the filesystem, so every merge case is
 * reachable from a unit test.
 */
export function planChanges(settings, action, options = {}) {
  const next = structuredClone(settings.value ?? {});
  if (!next.hooks || typeof next.hooks !== 'object' || Array.isArray(next.hooks)) next.hooks = {};
  const changes = [];
  const isOwnedHook = (hook) => isTightbeamHook(hook, options.recognizedCommands);
  const isOwnedGroup = (group) => isTightbeamGroup(group, options.recognizedCommands);

  for (const event of HOOK_EVENTS) {
    const existing = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];

    if (action === 'install') {
      const desired = buildHookGroup(event, options);
      const ours = existing.filter(isOwnedGroup);
      if (ours.length === 0) {
        const compatibleIndex = options.composeCodexLifecycle
          ? existing.findIndex((group) => isCompatibleCodexLifecycleGroup(event, group))
          : -1;
        if (compatibleIndex >= 0) {
          next.hooks[event] = existing.map((group, index) =>
            index === compatibleIndex ? { ...group, hooks: [...group.hooks, desired.hooks[0]] } : group,
          );
          changes.push({ event, op: 'add', command: desired.hooks[0].command });
          continue;
        }
        // Append: every foreign group keeps its index.
        next.hooks[event] = [...existing, desired];
        changes.push({ event, op: 'add', command: desired.hooks[0].command });
        continue;
      }
      // Replace only our handler in place, preserving any foreign handlers
      // composed into the same Codex lifecycle group.
      let seen = false;
      const merged = existing
        .map((group) => {
          if (!Array.isArray(group.hooks)) return group;
          return {
            ...group,
            hooks: group.hooks.flatMap((hook) => {
              if (!isOwnedHook(hook)) return [hook];
              if (seen) return [];
              seen = true;
              return desired.hooks;
            }),
          };
        })
        .filter((group) => !Array.isArray(group.hooks) || group.hooks.length > 0);
      next.hooks[event] = merged;
      const previous = ours.flatMap((group) => group.hooks).find(isOwnedHook)?.command;
      const unchanged = ours.length === 1 && previous === desired.hooks[0].command;
      changes.push(
        unchanged
          ? { event, op: 'noop', command: desired.hooks[0].command }
          : { event, op: 'refresh', from: previous, to: desired.hooks[0].command },
      );
      continue;
    }

    const kept = existing
      .map((group) =>
        Array.isArray(group.hooks)
          ? { ...group, hooks: group.hooks.filter((hook) => !isOwnedHook(hook)) }
          : group,
      )
      .filter((group) => !Array.isArray(group.hooks) || group.hooks.length > 0);
    changes.push({ event, op: kept.length === existing.length ? 'absent' : 'remove' });
    if (kept.length === 0) delete next.hooks[event];
    else next.hooks[event] = kept;
  }

  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return { next, changes };
}

/**
 * Installs or removes Tightbeam's hook group for one runtime or every
 * runtime the registry holds. `registry` is a createRuntimeRegistry
 * instance; without one, only the builtins are visible. Fail-closed by
 * construction: every target is resolved through the registry, admitted
 * against the v1 hook contract, and checked for settings-path collisions
 * BEFORE any write, so a rejected admission leaves no settings file and no
 * partial state anywhere. Returns a report the CLI prints; writes nothing
 * when `dryRun` is set or when the resulting bytes are identical to what is
 * already on disk.
 *
 * `settingsFile` is the rollback escape for uninstall only: deleting the
 * manifest file is the documented registration rollback, which strands the
 * runtime's installed hook groups with no registry record left to name
 * them. With it, uninstall skips registry resolution entirely and removes
 * entries purely by TIGHTBEAM marker — tag-scoped removal cannot damage
 * foreign content — at exactly the path given.
 */
export function bootstrapHooks({ action, runtime = null, dryRun = false, home = homedir(), packageRoot = path.resolve(repoRoot(), '..'), registry, settingsFile, recognizedCommands } = {}) {
  if (action !== 'install' && action !== 'uninstall') {
    throw new Error(`action must be install or uninstall (got ${action})`);
  }
  if (settingsFile !== undefined) {
    if (action !== 'uninstall') {
      throw namedError('settings_file_requires_uninstall', '--settings-file removes tagged entries from an explicit file and is supported for uninstall only');
    }
    if (typeof settingsFile !== 'string' || settingsFile.length === 0) {
      throw namedError('invalid_settings_file', '--settings-file requires a non-empty path');
    }
    if (runtime === null) {
      throw namedError('settings_file_requires_runtime', '--settings-file requires --runtime <id> to name the stranded runtime');
    }
  }

  const activeRegistry = registry ?? builtinOnlyRegistry();
  const requestedIds = settingsFile !== undefined ? [runtime] : runtime === null ? activeRegistry.names() : [runtime];

  // Phase 1 — resolve and admit everything. Nothing below this loop writes.
  const targets = [];
  for (const id of requestedIds) {
    if (settingsFile !== undefined) {
      // Escape mode: no registry record exists to admit or collide with;
      // the marker tag is the only thing we match on.
      targets.push({ id, record: null, file: settingsFile });
      continue;
    }
    const record = activeRegistry.get(id);
    if (!record) {
      throw namedError('unknown_runtime', `unknown runtime: ${id} (registered runtimes: ${activeRegistry.names().join(', ')})`);
    }
    const admission = admitHookContract(record);
    if (!admission.ok) throw namedError(admission.code, admission.message);

    // Two runtimes writing one settings file would corrupt each other's
    // groups, so a declared path must be unique across everything we could
    // ever write to. Records that could not themselves be admitted never
    // receive our writes and therefore cannot collide with anyone.
    const file = recordSettingsPath(record, home);
    for (const other of activeRegistry.list()) {
      if (other.id === record.id || !admitHookContract(other).ok) continue;
      if (recordSettingsPath(other, home) === file) {
        throw namedError('settings_path_collision', `runtime "${record.id}" declares settings path ${file}, which runtime "${other.id}" already owns`);
      }
    }
    targets.push({ id: record.id, record, file });
  }

  const report = [];
  for (const { id, record, file } of targets) {
    const options = {
      packageRoot,
      runtimeBinding: record !== null && record.origin !== 'builtin' ? id : undefined,
      composeCodexLifecycle: id === 'codex',
      recognizedCommands,
    };
    const settings = readSettings(file);
    const { next, changes } = planChanges(settings, action, options);
    const contents = serialize(next);
    const entry = { runtime: id, file, settings_existed: settings.exists, changes };
    if (action === 'uninstall' && id === 'codex') {
      // Codex trust records live in config.toml keyed by index; that
      // machinery is a special case BY ID and belongs to no other runtime,
      // however Claude-shaped its settings file.
      const trustKeys = shiftedCodexTrustKeys(file, settings.value, { recognizedCommands });
      if (trustKeys.length > 0) entry.codex_trust_keys = trustKeys;
    }

    if (dryRun) {
      entry.status = 'dry_run';
      entry.preview = next;
    } else if (settings.exists && settings.raw === contents) {
      entry.status = 'unchanged';
    } else if (action === 'uninstall' && settings.exists && Object.keys(next).length === 0) {
      // A file that holds nothing but our hooks is one we created; leaving
      // an empty husk behind is not "removes only Tightbeam entries".
      rmSync(file, { force: true });
      entry.status = 'removed';
    } else if (!settings.exists && Object.keys(next).length === 0) {
      entry.status = 'absent';
    } else {
      atomicWrite(file, contents);
      entry.status = 'written';
    }
    report.push(entry);
  }

  return { ok: true, action, dry_run: dryRun, marker: TIGHTBEAM_MARKER, report };
}
