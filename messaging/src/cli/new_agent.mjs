// `--to new:<runtime>:<cwd>` (plan §2.5 W5; UX F4, S3, §9). Only existing
// ops: validate before any write, get-or-create the `<runtime>:<cwd>`
// principal, and register a sessionless non_interactive placeholder (Case
// D(b)). The caller commits exactly to that placeholder, which routes a
// resume request; the daemon's resumer spawns the runtime in the cwd and its
// SessionStart adopts the placeholder.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AgentCommandError } from './agent_commands.mjs';
import { SESSION_LIST_LIMIT } from './agent_sessions.mjs';
import { resolveCommandOnPath } from './doctor_checks.mjs';
import { tightbeamRecipeCommand } from './package_context.mjs';
import { BUILTIN_RUNTIMES, LEGACY_RUNTIME_ALIASES } from '../runtimes/builtins.mjs';

function debugLog(fields) {
  if (!process.env.TIGHTBEAM_HOOK_DEBUG) return;
  try {
    process.stderr.write(`${JSON.stringify({ component: 'tightbeam-agent', ...fields })}\n`);
  } catch {
    // Diagnostics never change the result.
  }
}

function expandHome(cwd) {
  if (cwd === '~') return os.homedir();
  if (cwd.startsWith('~/')) return path.join(os.homedir(), cwd.slice(2));
  return cwd;
}

// The real path: the spawned runtime reports its cwd resolved, and the
// placeholder's principal ref must be the one its SessionStart registers.
// `.native` also returns the on-disk case on a case-insensitive volume, as
// getcwd does; the JS realpath keeps the typed case and adoption never matches.
function existingFolder(cwd) {
  const expanded = expandHome(cwd);
  if (!path.isAbsolute(expanded)) return null;
  try {
    return fs.statSync(expanded).isDirectory() ? fs.realpathSync.native(expanded) : null;
  } catch {
    return null;
  }
}

// The resumer launches BUILTIN_RUNTIMES[id].command by name through PATH, so
// that is the lookup that decides whether a launch could start at all.
function availableRuntime(runtime) {
  const id = LEGACY_RUNTIME_ALIASES[runtime] ?? runtime;
  const record = Object.hasOwn(BUILTIN_RUNTIMES, id) ? BUILTIN_RUNTIMES[id] : null;
  if (!record || !resolveCommandOnPath(record.command, process.env.PATH)) return null;
  return id;
}

function otherRuntime(runtime) {
  const id = LEGACY_RUNTIME_ALIASES[runtime] ?? runtime;
  return Object.keys(BUILTIN_RUNTIMES).find((candidate) => candidate !== id);
}

/** Validates a `new:` target before any write. @returns {{runtime: string, cwd: string}} */
export function validateNewAgent(target, { log = debugLog } = {}) {
  const cwd = existingFolder(target.cwd);
  if (cwd === null) {
    log({ event: 'agent_new.validate', params: { runtime: target.runtime }, result: { code: 'cwd_not_found' }, status: 'refused' });
    throw new AgentCommandError('cwd_not_found', `Folder ${target.cwd} does not exist.`, {
      details: { cwd: target.cwd },
      next_action: `Create the folder, or choose an existing one: ${tightbeamRecipeCommand()} agent sessions --all`,
    });
  }
  const runtime = availableRuntime(target.runtime);
  if (runtime === null) {
    log({ event: 'agent_new.validate', params: { runtime: target.runtime }, result: { code: 'runtime_unavailable' }, status: 'refused' });
    throw new AgentCommandError('runtime_unavailable', `${target.runtime} is not available on this machine.`, {
      details: { runtime: target.runtime },
      next_action: `${tightbeamRecipeCommand()} agent sessions --runtime ${otherRuntime(target.runtime)}`,
    });
  }
  log({ event: 'agent_new.validate', params: { runtime }, result: { cwd }, status: 'ok' });
  return { runtime, cwd };
}

function newAgentTarget({ principal_id, endpoint_id, runtime, cwd, registered_after }) {
  return {
    principal_id,
    endpoint_id,
    resolved: { session_id: null, runtime, cwd, state: 'starting' },
    placeholder: { endpoint_id, runtime, registered_after },
  };
}

/**
 * Validates, then gets or creates the `<runtime>:<cwd>` principal and
 * registers a sessionless placeholder endpoint for it. The returned target
 * carries the placeholder so the caller can wait for exactly that endpoint.
 * A replay of the same command (`replay.recall`) reuses the placeholder it
 * registered, so its commit replays byte-identically and no second
 * placeholder is ever left unlaunched.
 */
export async function prepareNewAgent(client, session, target, { log = debugLog, replay = null } = {}) {
  const { runtime, cwd } = validateNewAgent(target, { log });
  const remembered = replay?.recall() ?? null;
  if (remembered?.runtime === runtime && remembered.cwd === cwd) {
    log({ event: 'agent_new.register', params: { runtime }, result: { principal_id: remembered.principal_id, endpoint_id: remembered.endpoint_id }, status: 'replayed' });
    return newAgentTarget(remembered);
  }
  const started = Date.now();
  const principal = await client.request('principal.register', { authority_name: session.authority_name, external_principal_ref: `${runtime}:${cwd}` });
  const registeredAfter = new Date().toISOString();
  const endpoint = await client.request('endpoint.register', {
    authority_name: session.authority_name,
    principal_id: principal.principal_id,
    runtime,
    launch_mode: 'non_interactive',
    authority_reference: cwd,
  });
  log({ event: 'agent_new.register', params: { runtime }, result: { principal_id: principal.principal_id, endpoint_id: endpoint.endpoint_id }, status: 'ok', latency_ms: Date.now() - started });
  const prepared = { principal_id: principal.principal_id, endpoint_id: endpoint.endpoint_id, runtime, cwd, registered_after: registeredAfter };
  replay?.remember(prepared);
  return newAgentTarget(prepared);
}

// Measured commit -> adoption: Claude Code 2.1.293 7.0 s, Codex 0.160.1 9.1 s.
export const NEW_AGENT_WAIT_MS = 20_000;
const NEW_AGENT_POLL_MS = 500;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls endpoint.list until the known placeholder is adopted, at most
 * NEW_AGENT_WAIT_MS. A sessionless row cannot be looked up by session id, so
 * it is selected by endpoint id; an incomplete list is never searched past.
 * @returns {Promise<{outcome: 'started'|'pending', reason: string|null, session_id: string|null}>}
 */
export async function awaitNewAgent(client, placeholder, { waitMs = NEW_AGENT_WAIT_MS, pollMs = NEW_AGENT_POLL_MS, now = Date.now, sleep = pause } = {}) {
  const deadline = now() + waitMs;
  for (;;) {
    const listed = await client.request('endpoint.list', {
      runtime: placeholder.runtime, created_after: placeholder.registered_after, include_closed: true, limit: SESSION_LIST_LIMIT,
    });
    const row = (listed.endpoints ?? []).find((candidate) => candidate.endpoint_id === placeholder.endpoint_id);
    if (typeof row?.provider_session_id === 'string' && row.provider_session_id.length > 0) {
      return { outcome: 'started', reason: null, session_id: row.provider_session_id };
    }
    if (listed.truncated) return { outcome: 'pending', reason: 'truncated', session_id: null };
    const remaining = deadline - now();
    if (remaining <= 0) return { outcome: 'pending', reason: 'timeout', session_id: null };
    await sleep(Math.min(pollMs, remaining));
  }
}

/**
 * After the commit: for a `new:` target, waits for its placeholder's adoption
 * and returns the resolved recipient as started or still starting; any other
 * target's resolution is returned unchanged.
 */
export async function settleNewAgent(client, target, { messageId, log = debugLog } = {}) {
  if (!target.placeholder) return target.resolved;
  const { endpoint_id: endpointId, runtime } = target.placeholder;
  log({ event: 'agent_new.commit', params: { runtime, endpoint_id: endpointId }, result: { message_id: messageId }, status: 'ok' });
  const started = Date.now();
  const waited = await awaitNewAgent(client, target.placeholder);
  log({
    event: 'agent_new.wait',
    params: { runtime, endpoint_id: endpointId },
    result: { outcome: waited.outcome, reason: waited.reason, session: waited.session_id?.slice(0, 8) ?? null },
    status: waited.outcome === 'started' ? 'ok' : 'pending',
    latency_ms: Date.now() - started,
  });
  return { ...target.resolved, session_id: waited.session_id, state: waited.outcome === 'started' ? 'started' : 'starting' };
}
