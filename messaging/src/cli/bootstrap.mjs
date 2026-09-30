// Install-time bootstrap: everything a fresh install needs before the
// first SessionStart hook can register an endpoint.
//
// The plugin manifests (.claude-plugin/hooks/hooks.json,
// .codex-plugin/hooks/hooks.json) wire the five runtime hooks at install
// time, but nothing in the plugin model runs a script. So the four
// remaining facts — a running daemon, a registered application, a
// registered authority, and the scoped grants those two need — had no
// owner, and `tightbeam hook session-start` failed on every fresh install
// with "no authority to register under".
//
// This module is that owner, and it has two entry points sharing one
// implementation:
//
//   tightbeam bootstrap        an explicit operator/agent command
//   tightbeam hook session-start   lazily, when credentials are absent
//
// It adds no trust. The state root is already 0700 owner-only and already
// holds the database and the admin nonce, so a process that can run this
// can already read every message directly (docs/security-model.md,
// src/cli/hook_credentials.mjs). What it removes is a manual step nobody
// was told to perform.

// Layering (the architecture contract §5): src/cli/ may not import src/daemon/.
// The state paths and the runtime id list are therefore injected by the
// caller, exactly as doctor_checks.mjs and hooks_install.mjs already take
// theirs. Nothing here reads a daemon internal.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { connect, writeAdminNonce } from '../client/client.mjs';
import { hookCredentialsPath, readHookCredentials } from './hook_credentials.mjs';
import { tightbeamCommandName } from './package_context.mjs';
import { assertStateRootCreatable } from '../protocol/state_root_location.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_BIN = path.resolve(HERE, '..', '..', 'bin', 'tightbeam-daemon');

export const DEFAULT_APP_NAME = 'tightbeam-local';
export const DEFAULT_AUTHORITY_NAME = 'local-agents';

const SOCKET_PROBE_TIMEOUT_MS = 1500;
const DAEMON_START_TIMEOUT_MS = 10000;
const DAEMON_POLL_INTERVAL_MS = 100;
const BOOTSTRAP_LOCK_TIMEOUT_MS = 15000;
const BOOTSTRAP_LOCK_POLL_INTERVAL_MS = 50;
const OWNERLESS_LOCK_STALE_MS = 5000;
const HANDOVER_STOP_TIMEOUT_MS = 10_000;
const RECONCILIATION_DEBUG_PREFIX = '[🪳 TEMP tldr-enrollment-tightbeam-channel-admission]';

export class BootstrapError extends Error {}

function reconciliationDebug(fields) {
  if (!process.env.TIGHTBEAM_BOOTSTRAP_DEBUG) return;
  process.stderr.write(`${RECONCILIATION_DEBUG_PREFIX} ${JSON.stringify(fields)}\n`);
}

/**
 * The grant set a hook-driven agent session actually needs, derived from
 * the op table (src/daemon/ops/registry.mjs) rather than guessed:
 *
 *   register_endpoints        principal.register, endpoint.register,
 *                             endpoint.state.set, session.stop  (hooks)
 *   read_inbox                inbox.list, message.read          (hooks)
 *   send_as_principal         conversation.create, message.commit
 *   acknowledge_delivery      message.acknowledge
 *   manage_obligations        lifecycle.view, recovery.*
 *   read_health               daemon.status, capabilities.list, migration.status
 *
 * The two authority-scoped grants carry an explicit allow-list because a
 * null list denies every authority (src/daemon/ops/authority_scope.mjs).
 * That fail-closed rule is correct and stays; this just stops it from
 * being a trap nobody was warned about.
 */
export function agentPermissionGrants(authorityName, runtimeTypes) {
  return [
    { permission: 'register_endpoints', allowed_authorities: [authorityName], allowed_runtime_types: [...runtimeTypes] },
    { permission: 'send_as_principal', allowed_authorities: [authorityName] },
    { permission: 'read_inbox' },
    { permission: 'acknowledge_delivery' },
    { permission: 'manage_obligations' },
    { permission: 'read_health' },
  ];
}

function normalizedValues(value) {
  return Array.isArray(value) ? [...new Set(value)].sort() : null;
}

function normalizedGrant(grant) {
  return {
    permission: grant.permission,
    allowed_authorities: normalizedValues(grant.allowed_authorities),
    allowed_runtime_types: normalizedValues(grant.allowed_runtime_types),
  };
}

function mergeValues(existing, required) {
  if (!Array.isArray(required)) return normalizedValues(existing);
  return [...new Set([...(Array.isArray(existing) ? existing : []), ...required])].sort();
}

function mergeAgentPermissionGrants(existing, required) {
  const byPermission = new Map(existing.map((grant) => [grant.permission, normalizedGrant(grant)]));
  for (const grant of required) {
    const current = byPermission.get(grant.permission);
    if (!current) {
      byPermission.set(grant.permission, normalizedGrant(grant));
      continue;
    }
    byPermission.set(grant.permission, {
      permission: grant.permission,
      allowed_authorities: mergeValues(current.allowed_authorities, grant.allowed_authorities),
      allowed_runtime_types: mergeValues(current.allowed_runtime_types, grant.allowed_runtime_types),
    });
  }
  return [...byPermission.values()].sort((left, right) => left.permission.localeCompare(right.permission));
}

function samePermissionGrants(left, right) {
  const normalize = (grants) => grants.map(normalizedGrant).sort((a, b) => a.permission.localeCompare(b.permission));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

// ---------------------------------------------------------------------
// Daemon lifecycle
// ---------------------------------------------------------------------

export function probeSocket(socketPath) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const socket = net.connect({ path: socketPath });
    const timer = setTimeout(() => done(false), SOCKET_PROBE_TIMEOUT_MS);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Returns 'running' if a daemon already answers on the socket, or
 * 'started' after spawning one and seeing it answer.
 *
 * The child is detached and its stdio discarded so it outlives the hook
 * or CLI process that started it — a SessionStart hook exits in
 * milliseconds and must not take the daemon down with it. A lock conflict
 * is not an error here: it means another daemon won the race for this
 * state root, which is the outcome we wanted anyway, so the poll below
 * decides, not the exit code.
 */
export async function ensureDaemon(stateRoot, socketPath, { timeoutMs = DAEMON_START_TIMEOUT_MS, daemonBin = DAEMON_BIN, nodePath = process.execPath } = {}) {
  if (await probeSocket(socketPath)) return 'running';

  // The daemon creates and locks down the state root itself
  // (ensureStateRoot, 0700 owner-only on the root, admin/, and runtimes/),
  // so nothing is created here: the poll below waits for that to have
  // happened, which is also what makes writeAdminNonce safe afterwards.
  // The daemon's own refusal to create a root (a pending state-root
  // migration) would be lost with its discarded stderr and surface only as
  // a timeout, so the same check runs here first and fails by name.
  assertStateRootCreatable(stateRoot, { site: 'cli.ensure_daemon' });
  const child = spawn(nodePath, [daemonBin, '--state-root', stateRoot], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(DAEMON_POLL_INTERVAL_MS);
    if (await probeSocket(socketPath)) return 'started';
  }
  throw new BootstrapError(
    `started a daemon for "${stateRoot}" but nothing answered on ${socketPath} within ${timeoutMs}ms; ` +
      `run "${tightbeamCommandName()} doctor" for the state-root, database, and socket checks`,
  );
}

export function daemonLockPid(stateRoot) {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(stateRoot, 'daemon.lock'), 'utf8'));
    return Number.isInteger(lock?.pid) && lock.pid > 0 ? lock.pid : null;
  } catch {
    return null;
  }
}

/**
 * Replace a responding daemon only after its authenticated coordinates and
 * lock ownership agree with the currently selected release. When `target`
 * is supplied, a matching current daemon is ready to stop even when the
 * target declares a monotonic forward schema/capability transition; deciding
 * whether that transition is allowed belongs to the activation layer. This
 * function neither selects a release nor opens product state.
 */
export async function prepareSelectedDaemonHandover({ stateRoot, appId, appSecret, selected, target, forceTargetRestart = false } = {}) {
  if (!selected) return { status: 'handover_not_selected' };
  let client;
  let report;
  let capabilities;
  try {
    client = await connect(stateRoot);
    await client.handshake({ appId, credential: { kind: 'app', app_secret: appSecret } });
    capabilities = Array.isArray(client.capabilities) ? [...client.capabilities].sort() : null;
    report = await client.request('daemon.status', {});
  } catch (error) {
    return { status: 'handover_unresponsive', code: error.code || 'connect_failed' };
  } finally {
    if (client) await client.close();
  }
  const matches = (release) => {
    const releaseCapabilities = Array.isArray(release?.compatibility?.capabilities) ? [...release.compatibility.capabilities].sort() : null;
    return report.daemon_version === release?.version
      && report.protocol_version === release?.compatibility?.protocol_version
      && report.state_schema_version === release?.compatibility?.state_schema_version
      && capabilities
      && releaseCapabilities
      && capabilities.length === releaseCapabilities.length
      && capabilities.every((capability, index) => capability === releaseCapabilities[index]);
  };
  if (target && matches(target) && !forceTargetRestart) return { status: 'handover_current' };
  if (!matches(selected)) {
    return { status: 'handover_incompatible', daemon_version: report.daemon_version };
  }
  if (!target) return { status: 'handover_current' };
  const pid = daemonLockPid(stateRoot);
  if (!pid || !isPidAlive(pid)) return { status: 'handover_pid_mismatch' };
  return { status: 'handover_ready', pid, daemon_version: report.daemon_version };
}

/** Stop only the authenticated PID proven by prepareSelectedDaemonHandover. */
export async function stopPreparedDaemon({ stateRoot, socketPath, pid, timeoutMs = HANDOVER_STOP_TIMEOUT_MS } = {}) {
  if (!Number.isInteger(pid) || pid <= 0 || daemonLockPid(stateRoot) !== pid || !isPidAlive(pid)) {
    return { status: 'handover_pid_mismatch' };
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    return { status: 'handover_stop_failed', code: error.code || 'signal_failed' };
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const socketGone = !(await probeSocket(socketPath));
    if (socketGone && !fs.existsSync(path.join(stateRoot, 'daemon.lock'))) {
      return { status: 'handover_stopped' };
    }
    await sleep(DAEMON_POLL_INTERVAL_MS);
  }
  return { status: 'handover_timeout', pid };
}

// ---------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------

/**
 * True when this state root already carries a usable hook credential.
 * A malformed or loosely-permissioned file is not usable. The explicit
 * bootstrap path may first narrow an existing file to 0600; all ordinary
 * readers still refuse loose credentials rather than consuming them.
 */
export function hasUsableCredentials(stateRoot) {
  const credentials = readHookCredentials(stateRoot);
  return Boolean(
    credentials &&
      typeof credentials.app_id === 'string' &&
      credentials.app_id.length > 0 &&
      typeof credentials.app_secret === 'string' &&
      credentials.app_secret.length > 0 &&
      typeof credentials.authority_name === 'string' &&
      credentials.authority_name.length > 0,
  );
}

function repairCredentialMode(stateRoot) {
  const file = hookCredentialsPath(stateRoot);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  if (stat.isFile() && stat.mode & 0o077) fs.chmodSync(file, 0o600);
}

function writeCredentials(stateRoot, credentials) {
  const file = hookCredentialsPath(stateRoot);
  const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(credentials, null, 2)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
    return file;
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the publication failure below.
      }
    }
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

// ---------------------------------------------------------------------
// Per-state-root singleflight
// ---------------------------------------------------------------------

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function readBootstrapLockOwner(lockDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'));
  } catch {
    return null;
  }
}

function bootstrapLockIsStale(lockDir) {
  const owner = readBootstrapLockOwner(lockDir);
  if (owner) return !isPidAlive(owner.pid);
  try {
    return Date.now() - fs.statSync(lockDir).mtimeMs > OWNERLESS_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function reclaimStaleBootstrapLock(lockDir) {
  const tombstone = `${lockDir}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    fs.renameSync(lockDir, tombstone);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  fs.rmSync(tombstone, { recursive: true, force: true });
}

async function acquireBootstrapLock(stateRoot, { timeoutMs = BOOTSTRAP_LOCK_TIMEOUT_MS } = {}) {
  // Bootstrap is the first writer on a new machine: it creates the root
  // before any daemon does, so it refuses a pending migration the same way.
  assertStateRootCreatable(stateRoot, { site: 'cli.bootstrap_lock' });
  const adminDir = path.join(stateRoot, 'admin');
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateRoot, 0o700);
  fs.mkdirSync(adminDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(adminDir, 0o700);

  const lockDir = path.join(adminDir, 'bootstrap.lock');
  const token = randomBytes(16).toString('hex');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (bootstrapLockIsStale(lockDir)) {
        reclaimStaleBootstrapLock(lockDir);
        continue;
      }
      await sleep(BOOTSTRAP_LOCK_POLL_INTERVAL_MS);
      continue;
    }

    try {
      fs.writeFileSync(
        path.join(lockDir, 'owner.json'),
        `${JSON.stringify({ pid: process.pid, token, started_at: new Date().toISOString() })}\n`,
        { mode: 0o600, flag: 'wx' },
      );
    } catch (err) {
      fs.rmSync(lockDir, { recursive: true, force: true });
      throw err;
    }
    return {
      release() {
        const owner = readBootstrapLockOwner(lockDir);
        if (owner?.token === token) fs.rmSync(lockDir, { recursive: true, force: true });
      },
    };
  }
  throw new BootstrapError(
    `timed out waiting for another bootstrap process to finish for "${stateRoot}"; run "${tightbeamCommandName()} doctor"`,
  );
}

// ---------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------

function isAlreadyRegistered(err, name) {
  // authority.register answers malformed_request on a duplicate name;
  // application.register answers identity_conflict (docs/protocol.md).
  // Both mean "this already exists", which for a re-run is success.
  if (!err || typeof err.code !== 'string') return false;
  if (err.code !== 'malformed_request' && err.code !== 'identity_conflict') return false;
  return typeof err.message === 'string' && err.message.includes(`"${name}"`) && err.message.includes('already registered');
}

async function registerAuthority(client, name) {
  try {
    await client.request('authority.register', { name, description: 'Local agent sessions, created by tightbeam bootstrap' });
    return 'created';
  } catch (err) {
    if (isAlreadyRegistered(err, name)) return 'existing';
    throw err;
  }
}

/**
 * Registers an application and returns its one-time secret.
 *
 * A secret is shown exactly once and only its scrypt hash is stored, so an
 * existing application of the same name is unusable to us — we cannot
 * recover its secret. Rather than strand the install, fall back to a
 * suffixed name. This only happens when a prior bootstrap wrote an app and
 * its credential file was later removed.
 */
async function registerApplication(client, preferredName) {
  try {
    const result = await client.request('application.register', { name: preferredName });
    return { ...result, name: preferredName };
  } catch (err) {
    if (!isAlreadyRegistered(err, preferredName)) throw err;
    const fallback = `${preferredName}-${randomBytes(4).toString('hex')}`;
    const result = await client.request('application.register', { name: fallback });
    return { ...result, name: fallback };
  }
}

async function existingApplicationGrants(stateRoot, credentials) {
  const client = await connect(stateRoot);
  try {
    const handshake = await client.handshake({
      appId: credentials.app_id,
      credential: { kind: 'app', app_secret: credentials.app_secret },
    });
    return Array.isArray(handshake.permissions) ? handshake.permissions : [];
  } finally {
    await client.close();
  }
}

async function replaceApplicationGrants(stateRoot, appId, grants) {
  const client = await connect(stateRoot);
  try {
    const nonce = writeAdminNonce(stateRoot);
    await client.handshake({ credential: { kind: 'admin', nonce } });
    return client.request('application.permissions.set', { app_id: appId, permissions: grants });
  } finally {
    await client.close();
  }
}

// ---------------------------------------------------------------------
// The bootstrap itself
// ---------------------------------------------------------------------

/**
 * Makes one state root ready for hook-driven agent sessions.
 *
 * Idempotent by design: a state root that already has usable credentials
 * keeps that exact application and reconciles its grants with the current
 * hook contract. This lets upgrades add newly required permissions without
 * minting a second application or orphaning the first. Pass `force: true`
 * to re-register anyway (this writes a NEW application; the old one keeps
 * its grants until an admin removes them).
 *
 * @returns {Promise<{status:string, app_id?:string, app_name?:string,
 *   authority_name?:string, credentials_file?:string, daemon:string,
 *   permissions?:string[], runtime_types?:string[]}>}
 */
export async function bootstrap({
  stateRoot,
  socketPath,
  runtimeTypes,
  appName = DEFAULT_APP_NAME,
  authorityName = DEFAULT_AUTHORITY_NAME,
  force = false,
} = {}) {
  if (typeof stateRoot !== 'string' || stateRoot.length === 0) {
    throw new BootstrapError('stateRoot is required');
  }
  if (typeof socketPath !== 'string' || socketPath.length === 0) {
    throw new BootstrapError('socketPath is required');
  }
  if (!Array.isArray(runtimeTypes) || runtimeTypes.length === 0) {
    throw new BootstrapError('runtimeTypes is required and must name at least one registered runtime');
  }

  const lock = await acquireBootstrapLock(stateRoot);
  try {
    // The check belongs inside the lock: every contender either becomes
    // the one writer or consumes the credential that writer published.
    if (!force) repairCredentialMode(stateRoot);
    if (!force && hasUsableCredentials(stateRoot)) {
      const credentials = readHookCredentials(stateRoot);
      const daemon = await ensureDaemon(stateRoot, socketPath);
      const existingGrants = await existingApplicationGrants(stateRoot, credentials);
      const requiredGrants = agentPermissionGrants(credentials.authority_name, runtimeTypes);
      const reconciledGrants = mergeAgentPermissionGrants(existingGrants, requiredGrants);
      const drift = !samePermissionGrants(existingGrants, reconciledGrants);
      reconciliationDebug({ event: 'grant_drift_checked', app_id: credentials.app_id, drift });
      if (drift) {
        const applied = await replaceApplicationGrants(stateRoot, credentials.app_id, reconciledGrants);
        if (!samePermissionGrants(applied.permissions ?? [], reconciledGrants)) {
          throw new BootstrapError('application grant reconciliation did not persist the requested contract');
        }
        reconciliationDebug({
          event: 'grants_reconciled',
          app_id: credentials.app_id,
          permissions: reconciledGrants.map((grant) => grant.permission),
        });
      }
      return {
        status: drift ? 'reconciled' : 'already_configured',
        daemon,
        app_id: credentials.app_id,
        authority_name: credentials.authority_name,
        credentials_file: hookCredentialsPath(stateRoot),
        ...(drift ? {
          permissions: reconciledGrants.map((grant) => grant.permission),
          runtime_types: [...runtimeTypes],
        } : {}),
      };
    }

    const daemon = await ensureDaemon(stateRoot, socketPath);
    const client = await connect(stateRoot);
    try {
      const nonce = writeAdminNonce(stateRoot);
      await client.handshake({ credential: { kind: 'admin', nonce } });

      const authorityState = await registerAuthority(client, authorityName);
      const application = await registerApplication(client, appName);
      const grants = agentPermissionGrants(authorityName, runtimeTypes);
      await client.request('application.permissions.set', { app_id: application.app_id, permissions: grants });

      const credentialsFile = writeCredentials(stateRoot, {
        app_id: application.app_id,
        app_secret: application.app_secret,
        authority_name: authorityName,
      });

      return {
        status: 'configured',
        daemon,
        app_id: application.app_id,
        app_name: application.name,
        authority_name: authorityName,
        authority: authorityState,
        credentials_file: credentialsFile,
        permissions: grants.map((grant) => grant.permission),
        runtime_types: runtimeTypes,
      };
    } finally {
      await client.close();
    }
  } finally {
    lock.release();
  }
}
