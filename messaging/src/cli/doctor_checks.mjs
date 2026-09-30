// `tightbeam doctor` — an ordered set of local checks over one state root
// (plan standalone-agent-messaging W3). Doctor reports; it never repairs.
//
// Read-only by construction, because a diagnostic that writes to the
// broken installation it is inspecting is a trap: opening the database
// through the daemon's helpers would flip journal modes and write WAL
// state — and even a direct readOnly attach performs wal-index recovery,
// which materializes -shm/-wal sidecars beside a checkpointed database.
// So SQLite never touches the original at all: this file byte-copies the
// database into a private (0700, via mkdtemp) directory in the OS temp
// area, chmods every copied file to owner-only, opens THE COPY with the
// readOnly option (confirmed on Node v24.19.0 in
// the runtime selection record §1.1), queries
// sqlite_master/schema_migrations there, and deletes the directory and
// anything SQLite placed beside it. The state root cannot gain a single
// file, and the copied bytes are never readable beyond their owner — the
// same posture as hook-app.json (src/cli/hook_credentials.mjs), whose
// rationale covers these exact bytes. Every other check is
// lstat/access/readFile or a raw connect-then-destroy socket probe: no
// mkdir IN THE STATE ROOT, no daemon contact beyond connectability, and
// no authenticated operation (`status` owns that surface).
//
// This module lives in cli/ and therefore imports nothing from daemon/
// (the architecture contract §5): paths and the expected schema version arrive as
// parameters from bin/tightbeam, runtime truth comes from the runtimes
// leaf registry, and manifest registrations flow through registry.list()
// without change once task 1.3 lands persistence.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';

import { TIGHTBEAM_MARKER, recordSettingsPath } from './hooks_install.mjs';
import { HOOK_CREDENTIALS_FILENAME } from './hook_credentials.mjs';
import { tightbeamCommandName } from './package_context.mjs';
import { createRuntimeRegistry } from '../runtimes/registry.mjs';
import { pendingStateRootMigration, STATE_ROOT_MIGRATION_PENDING } from '../protocol/state_root_location.mjs';

const SOCKET_PROBE_TIMEOUT_MS = 1500;

function pass(check, detail) {
  return { check, status: 'pass', detail };
}

function fail(check, code, detail, fix) {
  return { check, status: 'fail', code, detail, fix };
}

function isRegularFile(file) {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * A private scratch directory for the database copy: mkdtemp creates it
 * mode 0700 regardless of umask, so full database bytes (messages,
 * principals, secret hashes) copied inside are never readable beyond the
 * owner on a multi-user host — the hook-app.json posture.
 */
export function createDoctorScratchDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tb-doctor-'));
}

/**
 * Copies one database file into the scratch dir owner-only. Streams rather
 * than using a plain whole-file copy: that would materialize its
 * destination at the source's mode first and need a chmod afterwards — a
 * window in which growing database bytes are world-readable.
 * createWriteStream creates the file at 0600 from the first byte.
 */
async function copyFilePrivate(src, dest) {
  await pipeline(fs.createReadStream(src), fs.createWriteStream(dest, { mode: 0o600 }));
}

/**
 * Whether `command` would resolve for an exec: absolute/relative paths are
 * probed directly, bare names are searched across `pathEnv`. Existence plus
 * the executable bit only — doctor never runs the command.
 */
export function resolveCommandOnPath(command, pathEnv) {
  if (typeof command !== 'string' || command.length === 0) return false;
  if (command.includes('/')) {
    try {
      fs.accessSync(command, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  for (const dir of String(pathEnv ?? '').split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, command), fs.constants.X_OK);
      return true;
    } catch {
      // keep scanning
    }
  }
  return false;
}

/**
 * Raw connectability probe: connect, then destroy immediately. Nothing is
 * written to the socket — no frame, no handshake — so the daemon learns
 * nothing and logs nothing, and the probe creates no local state.
 */
function probeSocket(socketPath) {
  return new Promise((resolve) => {
    const socket = net.connect({ path: socketPath });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done('ETIMEDOUT'), SOCKET_PROBE_TIMEOUT_MS);
    socket.once('connect', () => done(null));
    socket.once('error', (err) => done(err.code ?? 'ECONNFAILED'));
  });
}

/**
 * Recursively true if any object inside `value` carries Tightbeam's
 * install marker — the same tag `hooks_install.mjs` embeds on every group
 * it writes, scanned structurally rather than by string search so foreign
 * JSON containing our marker as data cannot false-positive.
 */
function containsHookMarker(value, seen = new Set()) {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (!Array.isArray(value) && value._tightbeam === TIGHTBEAM_MARKER) return true;
  return Object.values(value).some((child) => containsHookMarker(child, seen));
}

function vendorConfigRoot(runtimeId, home) {
  if (runtimeId === 'claude-code') return process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  if (runtimeId === 'codex') return process.env.CODEX_HOME || path.join(home, '.codex');
  return null;
}

function findPluginHookFiles(cacheRoot, wrapperDir) {
  const found = [];
  const visit = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Claude Code marks a superseded plugin version with .orphaned_at and keeps
    // it only for sessions that already loaded it; it is not the installed wiring.
    if (entries.some((entry) => entry.isFile() && entry.name === '.orphaned_at')) return;
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(child, depth + 1);
      } else if (entry.isFile() && entry.name === 'hooks.json' && path.basename(path.dirname(child)) === 'hooks' && path.basename(path.dirname(path.dirname(child))) === wrapperDir) {
        try {
          if (containsHookMarker(JSON.parse(fs.readFileSync(child, 'utf8')))) found.push(child);
        } catch {
          // A foreign or incomplete cache entry is not Tightbeam wiring.
        }
      }
    }
  };
  visit(cacheRoot, 0);
  return found;
}

const CODEX_HOOK_EVENT_KEYS = Object.freeze({
  PreToolUse: 'pre_tool_use',
  PermissionRequest: 'permission_request',
  PostToolUse: 'post_tool_use',
  PreCompact: 'pre_compact',
  PostCompact: 'post_compact',
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  UserPromptSubmit: 'user_prompt_submit',
  SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop',
  Stop: 'stop',
  Interrupt: 'interrupt',
});

const CODEX_MATCHER_EVENTS = new Set([
  'pre_tool_use',
  'permission_request',
  'post_tool_use',
  'pre_compact',
  'post_compact',
  'session_start',
  'session_end',
  'subagent_start',
  'subagent_stop',
]);

const CODEX_ADDITIONAL_CONTEXT_EVENTS = new Set([
  'pre_tool_use',
  'post_tool_use',
  'session_start',
  'user_prompt_submit',
  'subagent_start',
]);

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
}

function normalizedCodexCommandHandler(eventKey, handler) {
  if (!handler || handler.type !== 'command') return null;
  const platformCommand = process.platform === 'win32'
    ? (handler.commandWindows ?? handler.command_windows ?? handler.command)
    : handler.command;
  if (typeof platformCommand !== 'string' || platformCommand.trim().length === 0) return null;
  const requestedTimeout = handler.timeout;
  if (requestedTimeout !== undefined && (!Number.isSafeInteger(requestedTimeout) || requestedTimeout < 0)) return null;
  const timeout = eventKey === 'session_end' || eventKey === 'interrupt'
    ? Math.min(3, Math.max(1, requestedTimeout ?? 1))
    : Math.max(1, requestedTimeout ?? 600);
  const normalized = {
    type: 'command',
    command: platformCommand,
    timeout,
    async: handler.async === true,
  };
  if (typeof handler.statusMessage === 'string') normalized.statusMessage = handler.statusMessage;
  if (
    CODEX_ADDITIONAL_CONTEXT_EVENTS.has(eventKey)
    && Number.isSafeInteger(handler.additionalContextLimit)
    && handler.additionalContextLimit >= 0
    && handler.additionalContextLimit !== 2500
  ) {
    normalized.additionalContextLimit = handler.additionalContextLimit;
  }
  return normalized;
}

function codexHookHash(eventKey, group, handler) {
  const normalizedHandler = normalizedCodexCommandHandler(eventKey, handler);
  if (!normalizedHandler) return null;
  const identity = { event_name: eventKey };
  if (CODEX_MATCHER_EVENTS.has(eventKey) && typeof group.matcher === 'string') identity.matcher = group.matcher;
  identity.hooks = [normalizedHandler];
  const serialized = JSON.stringify(canonicalJson(identity));
  return `sha256:${createHash('sha256').update(serialized).digest('hex')}`;
}

function codexPluginIdentity(codexHome, hookFile) {
  const cacheRoot = path.join(codexHome, 'plugins', 'cache');
  const relative = path.relative(cacheRoot, hookFile);
  const parts = relative.split(path.sep);
  if (relative.startsWith('..') || path.isAbsolute(relative) || parts.length < 5) return null;
  const [marketplace, plugin, , ...sourceParts] = parts;
  if (!marketplace || !plugin || sourceParts.length === 0) return null;
  return {
    pluginId: `${plugin}@${marketplace}`,
    sourceRelativePath: sourceParts.join('/'),
  };
}

function codexHookStates(config) {
  const states = new Map();
  let current = null;
  for (const line of config.split(/\r?\n/)) {
    const header = line.match(/^\s*\[hooks\.state\."((?:\\.|[^"\\])*)"\]\s*(?:#.*)?$/);
    if (header) {
      try {
        current = JSON.parse(`"${header[1]}"`);
      } catch {
        current = null;
      }
      if (current !== null && !states.has(current)) states.set(current, {});
      continue;
    }
    if (/^\s*\[/.test(line)) {
      current = null;
      continue;
    }
    if (current === null) continue;
    const trustedHash = line.match(/^\s*trusted_hash\s*=\s*"([^"]+)"\s*(?:#.*)?$/);
    if (trustedHash) {
      states.get(current).trustedHash = trustedHash[1];
      continue;
    }
    const enabled = line.match(/^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/);
    if (enabled) states.get(current).enabled = enabled[1] === 'true';
  }
  return states;
}

function expectedCodexPluginTrust(codexHome, hookFile) {
  const identity = codexPluginIdentity(codexHome, hookFile);
  if (!identity) return null;
  let hooks;
  try {
    hooks = JSON.parse(fs.readFileSync(hookFile, 'utf8')).hooks;
  } catch {
    return null;
  }
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return null;
  const expected = [];
  for (const [eventName, groups] of Object.entries(hooks)) {
    const eventKey = CODEX_HOOK_EVENT_KEYS[eventName];
    if (!eventKey || !Array.isArray(groups)) continue;
    for (const [groupIndex, group] of groups.entries()) {
      if (!group || !Array.isArray(group.hooks)) continue;
      for (const [handlerIndex, handler] of group.hooks.entries()) {
        if (handler?._tightbeam !== TIGHTBEAM_MARKER) continue;
        const trustedHash = codexHookHash(eventKey, group, handler);
        if (!trustedHash) return null;
        expected.push({
          key: `${identity.pluginId}:${identity.sourceRelativePath}:${eventKey}:${groupIndex}:${handlerIndex}`,
          trustedHash,
        });
      }
    }
  }
  return expected.length > 0 ? expected : null;
}

function codexPluginTrustPresent(codexHome, hookFile) {
  let config;
  try {
    config = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
  } catch {
    return false;
  }
  if (/^\s*bypass_hook_trust\s*=\s*true\s*$/m.test(config)) return true;
  const expected = expectedCodexPluginTrust(codexHome, hookFile);
  if (!expected) return false;
  const states = codexHookStates(config);
  return expected.every(({ key, trustedHash }) => {
    const state = states.get(key);
    return state?.enabled !== false && state?.trustedHash === trustedHash;
  });
}

function pluginWiring(record, home) {
  const configRoot = vendorConfigRoot(record.id, home);
  if (!configRoot) return null;
  const wrapperDir = record.id === 'claude-code' ? '.claude-plugin' : '.codex-plugin';
  const files = findPluginHookFiles(path.join(configRoot, 'plugins', 'cache'), wrapperDir);
  if (files.length === 0) return null;
  const file = files[0];
  if (record.id === 'codex' && !codexPluginTrustPresent(configRoot, file)) {
    return { status: 'trust-missing', file };
  }
  return { status: 'ready', file };
}

/**
 * Runs every doctor check in plan order and returns their results. Never
 * throws for an unhealthy install — failures are results — but unexpected
 * internal errors surface as a thrown error, not a fake "failure".
 *
 * @param {object} options
 * @param {object} options.paths - statePaths(root): { root, db, socket }
 * @param {string} options.home - operator home (hook settings resolution)
 * @param {string} [options.pathEnv] - PATH to resolve runtime commands against
 * @param {number} options.schemaVersion - the schema version this build ships
 * @param {Array} [options.manifestRecords] - registered manifest runtime
 *   records, loaded read-only by the caller (bin) from the state root
 * @param {Error|null} [options.runtimeManifestError] - a persisted-manifest
 *   load failure to report instead of silently skipping those runtimes
 * @returns {Promise<{state_root: string, checks: Array<object>, healthy: boolean}>}
 */
/**
 * The state-root check, read-only. A symlinked root (the ~/.tightbeam
 * compatibility link kept until item 36, or any link a user sets) is
 * accepted when it resolves to a directory, and the detail names the
 * target. A missing default root while the legacy ~/.tightbeam is still a
 * real directory is the pending Phase E migration, reported by name so the
 * fix is the migration, not "start the daemon" (which refuses anyway).
 */
function checkStateRoot({ paths, home }) {
  let rootStat;
  try {
    rootStat = fs.lstatSync(paths.root);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      return fail('state-root', 'STATE_ROOT_INACCESSIBLE', `cannot stat ${paths.root} (${err.code ?? err.message})`, `fix permissions on ${path.dirname(paths.root)} first`);
    }
    let pending = null;
    try {
      pending = pendingStateRootMigration(paths.root, { home });
    } catch {
      // An unreadable legacy path is not evidence of a pending migration.
    }
    if (pending !== null) {
      return fail(
        'state-root',
        STATE_ROOT_MIGRATION_PENDING,
        `no state root at ${paths.root}, and the legacy root ${pending.legacy} is still a real directory; the daemon refuses to create a fresh root`,
        `move the legacy root (npm run local:migrate-state-root), or set TIGHTBEAM_STATE_ROOT=${pending.legacy}`,
      );
    }
    return fail('state-root', 'STATE_ROOT_MISSING', `no state root at ${paths.root}`, `start the daemon once to create ${paths.root}`);
  }

  let described = paths.root;
  if (rootStat.isSymbolicLink()) {
    let target;
    try {
      target = fs.realpathSync(paths.root);
      rootStat = fs.statSync(target);
    } catch (err) {
      return err.code === 'ENOENT' || err.code === 'ENOTDIR'
        ? fail('state-root', 'STATE_ROOT_MISSING', `${paths.root} is a symlink to a missing directory`, `restore the link target, or replace ${paths.root} with the state root directory`)
        : fail('state-root', 'STATE_ROOT_INACCESSIBLE', `cannot resolve the symlink at ${paths.root} (${err.code ?? err.message})`, `fix permissions on the link target of ${paths.root} first`);
    }
    described = `${paths.root} (symlink to ${target})`;
  }
  if (!rootStat.isDirectory()) {
    return fail('state-root', 'STATE_ROOT_NOT_A_DIRECTORY', `${described} exists but is not a directory`, `move or remove ${paths.root}; the daemon needs to create the directory itself`);
  }
  try {
    fs.accessSync(paths.root, fs.constants.W_OK);
    return pass('state-root', `${described} exists and is writable`);
  } catch {
    return fail('state-root', 'STATE_ROOT_NOT_WRITABLE', `${described} is not writable by this user`, `chown/chmod ${paths.root} so the daemon can write its state`);
  }
}

export async function runDoctorChecks({
  paths,
  home,
  pathEnv = process.env.PATH ?? '',
  schemaVersion,
  manifestRecords = [],
  runtimeManifestError = null,
}) {
  const checks = [];

  // 1. State root exists / writable.
  checks.push(checkStateRoot({ paths, home }));

  // 2. Database present + schema current, read straight off the file.
  await checkDatabase(checks, { paths, schemaVersion });

  // 3. Socket reachable — connectability only, no handshake, no op.
  await checkSocket(checks, { paths });

  // Registered runtimes, in registry order (builtins plus any persisted
  // manifests the caller loaded read-only). Two passes so output groups
  // follow plan order: every command check before every hook-marker check.
  if (runtimeManifestError) {
    checks.push(
      fail(
        'runtime-manifests',
        'RUNTIME_MANIFESTS_INVALID',
        runtimeManifestError.message,
        'repair or remove the file named above; the daemon refuses to start while it is invalid',
      ),
    );
  }
  const registry = createRuntimeRegistry({ stateRoot: paths.root, manifestRecords });
  const records = registry.list();

  // 4. Each registered runtime's command resolvable on PATH — daemon
  // strategies only, mirroring the resumer's selection rule: external
  // records manage their own sessions and carry no execution vector (the
  // manifest parser forbids one), so there is nothing to resolve.
  for (const record of records) {
    if (record.resumeStrategy !== 'daemon') {
      checks.push(pass('runtime-command', `${record.id} uses resume strategy "${record.resumeStrategy}"; nothing to resolve on PATH`));
      continue;
    }
    if (resolveCommandOnPath(record.command, pathEnv)) {
      checks.push(pass('runtime-command', `${record.id} command "${record.command}" resolves on PATH`));
    } else {
      checks.push(
        fail(
          'runtime-command',
          'RUNTIME_COMMAND_UNRESOLVED',
          `${record.id} command "${record.command}" does not resolve on PATH`,
          `install ${record.command}, or extend PATH so ${record.id} sessions can be resumed`,
        ),
      );
    }
  }

  // 5. Hook-config marker scan per registered runtime. Every record in the
  // loaded snapshot is scanned — builtins and registered manifests alike —
  // at the settings file its record actually declares, resolved by the same
  // semantics the installer writes with (recordSettingsPath: '~'/'~/'
  // expand, absolute paths stand, relative joins home, '~user' refuses).
  // The fix token is always the canonical id: registry-derived hook install
  // accepts exactly that spelling for every runtime it holds.
  for (const record of records) {
    if (!record.hooksInstall?.settingsPath) continue;
    let file;
    try {
      file = recordSettingsPath(record, home);
    } catch (err) {
      checks.push(fail('hook-marker', 'HOOK_CONFIG_INVALID', err.message, `declare an absolute or home-relative hooksInstall.settingsPath in the "${record.id}" manifest`));
      continue;
    }
    let value;
    try {
      value = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') {
        const plugin = pluginWiring(record, home);
        if (plugin?.status === 'ready') {
          checks.push(pass('hook-marker', `${record.id} plugin wiring present in ${plugin.file}`));
        } else if (plugin?.status === 'trust-missing') {
          checks.push(
            fail(
              'hook-marker',
              'HOOK_PLUGIN_TRUST_MISSING',
              `${record.id} plugin wiring is installed at ${plugin.file}, but Codex hook trust is not approved`,
              `approve the Tightbeam plugin hooks in Codex, then rerun ${tightbeamCommandName()} doctor`,
            ),
          );
        } else {
          checks.push(fail('hook-marker', 'HOOK_MARKER_MISSING', `${record.id} has no hook config at ${file}`, `${tightbeamCommandName()} hooks install --runtime ${record.id}`));
        }
      } else {
        checks.push(
          fail(
            'hook-marker',
            'HOOK_CONFIG_INVALID',
            `${file} exists but is not readable JSON (${err.message})`,
            `repair ${file} by hand; ${tightbeamCommandName()} hooks install --runtime ${record.id} rewrites only after it parses`,
          ),
        );
      }
      continue;
    }
    if (containsHookMarker(value)) {
      checks.push(pass('hook-marker', `${record.id} marker present in ${file}`));
    } else {
      const plugin = pluginWiring(record, home);
      if (plugin?.status === 'ready') {
        checks.push(pass('hook-marker', `${record.id} plugin wiring present in ${plugin.file}`));
      } else if (plugin?.status === 'trust-missing') {
        checks.push(
          fail(
            'hook-marker',
            'HOOK_PLUGIN_TRUST_MISSING',
            `${record.id} plugin wiring is installed at ${plugin.file}, but Codex hook trust is not approved`,
            `approve the Tightbeam plugin hooks in Codex, then rerun ${tightbeamCommandName()} doctor`,
          ),
        );
      } else {
        checks.push(fail('hook-marker', 'HOOK_MARKER_MISSING', `${record.id} config at ${file} carries no ${TIGHTBEAM_MARKER} marker`, `${tightbeamCommandName()} hooks install --runtime ${record.id}`));
      }
    }
  }

  // 6. Credentials file present. Presence only: whether the secret still
  // authenticates is the daemon's verdict, and doctor performs no
  // authenticated operation.
  const credentialsFile = path.join(paths.root, HOOK_CREDENTIALS_FILENAME);
  if (isRegularFile(credentialsFile)) {
    checks.push(pass('credentials', `app credential present at ${credentialsFile}`));
  } else {
    const existsButNotAFile = fs.existsSync(credentialsFile);
    checks.push(
      fail(
        'credentials',
        'CREDENTIALS_MISSING',
        `credentials unavailable: ${existsButNotAFile ? `${credentialsFile} is not a regular file` : `no app credential at ${credentialsFile}`}`,
        `register an app (${tightbeamCommandName()} --admin app register <name>) and write its app_id/app_secret to ${credentialsFile} at mode 0600`,
      ),
    );
  }

  return {
    state_root: paths.root,
    checks,
    healthy: checks.every((check) => check.status === 'pass'),
  };
}

async function checkDatabase(checks, { paths, schemaVersion }) {
  if (!isRegularFile(paths.db)) {
    const exists = fs.existsSync(paths.db);
    checks.push(
      fail(
        'database',
        'DB_MISSING',
        exists ? `${paths.db} exists but is not a regular file` : `no database at ${paths.db}`,
        `start the daemon once to create ${paths.db}`,
      ),
    );
    return;
  }

  // The original files are never handed to SQLite. A readOnly attach still
  // runs wal-index recovery, which creates -shm/-wal beside a checkpointed
  // database — writing to the very installation under diagnosis. Diagnose
  // a byte-copy in a private temp directory instead; every message below
  // keeps naming the ORIGINAL path, which is what the operator cares about.
  //
  // The main file is copied FIRST, then its -wal when one exists (a live
  // daemon keeps recent commits, schema included, in the WAL). A commit or
  // checkpoint landing mid-copy then leaves an older db paired with a newer
  // wal — which SQLite replays as a valid checksum-chained prefix — while
  // the reverse order could pair stale frames with newer pages. No -shm
  // copy: that is process-local bookkeeping, rebuilt inside the private
  // directory, where writes belong.
  let scratchDir;
  try {
    scratchDir = createDoctorScratchDir();
  } catch (err) {
    checks.push(fail('database', 'DB_UNREADABLE', `cannot stage a private copy of ${paths.db}: ${err.code ?? err.message}`, `free space in the system temp directory, then rerun ${tightbeamCommandName()} doctor`));
    return;
  }
  const scratch = path.join(scratchDir, 'tightbeam.db');
  try {
    let db;
    try {
      await copyFilePrivate(paths.db, scratch);
      const walSource = `${paths.db}-wal`;
      if (fs.existsSync(walSource)) {
        await copyFilePrivate(walSource, `${scratch}-wal`);
      }
      db = new DatabaseSync(scratch, { readOnly: true });
    } catch (err) {
      const why = err.code && !err.message.includes(err.code) ? err.code : err.message.split('\n')[0];
      checks.push(fail('database', 'DB_UNREADABLE', `SQLite cannot read ${paths.db}: ${why}`, `inspect ${paths.db}: it may be corrupt or truncated; restore from backup or delete it and start over`));
      return;
    }
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
      if (!tables.includes('schema_migrations')) {
        checks.push(fail('database', 'DB_NO_SCHEMA', `${paths.db} has no schema_migrations table (${tables.length} tables)`, `start the daemon once to initialize ${paths.db}`));
        return;
      }
      const row = db.prepare('SELECT MAX(schema_version) AS version FROM schema_migrations').get();
      const version = row && typeof row.version === 'number' ? row.version : 0;
      if (version === schemaVersion) {
        checks.push(pass('database', `schema v${version} current in ${paths.db} (${tables.length} tables)`));
      } else if (version < schemaVersion) {
        checks.push(fail('database', 'SCHEMA_OUTDATED', `database at schema v${version}, this build expects v${schemaVersion}`, `start the daemon once to migrate ${paths.db} to schema v${schemaVersion}`));
      } else {
        checks.push(fail('database', 'SCHEMA_INCOMPATIBLE', `database at schema v${version}, newer than this build's v${schemaVersion}`, `upgrade tightbeam: ${paths.db} was written by a newer daemon`));
      }
    } catch (err) {
      // SQLite opens some damaged files eagerly and fails on first read; both
      // shapes are the same finding.
      checks.push(fail('database', 'DB_UNREADABLE', `SQLite cannot read ${paths.db}: ${err.message.split('\n')[0]}`, `inspect ${paths.db}: it may be corrupt or truncated; restore from backup or delete it and start over`));
    } finally {
      db.close();
    }
  } finally {
    // Remove the whole private directory — the copy plus anything SQLite
    // materialized beside it. The temp area must keep no litter and no
    // readable database bytes either.
    try {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; a leftover private temp file beats any excuse
      // to skip the diagnosis
    }
  }
}

async function checkSocket(checks, { paths }) {
  let stat;
  try {
    stat = fs.lstatSync(paths.socket);
  } catch {
    checks.push(fail('socket', 'DAEMON_NOT_RUNNING', `no socket at ${paths.socket}: the daemon is not running`, `start the daemon (${tightbeamCommandName()} bootstrap) to serve ${paths.root}`));
    return;
  }
  if (!stat.isSocket()) {
    checks.push(fail('socket', 'SOCKET_UNREACHABLE', `${paths.socket} exists but is not a Unix domain socket`, `stop any tightbeam-daemon process for this state root, remove ${paths.socket}, and start the daemon again (${tightbeamCommandName()} bootstrap)`));
    return;
  }
  const errorCode = await probeSocket(paths.socket);
  if (errorCode === null) {
    checks.push(pass('socket', `connectable at ${paths.socket}`));
  } else {
    checks.push(fail('socket', 'SOCKET_UNREACHABLE', `nothing accepts connections on ${paths.socket} (${errorCode}): a stale socket left by a dead daemon`, `stop any tightbeam-daemon process for this state root, remove ${paths.socket}, and start the daemon again (${tightbeamCommandName()} bootstrap)`));
  }
}
