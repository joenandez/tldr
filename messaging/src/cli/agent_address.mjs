// Agent recipient addresses (plan §2.1 Addresses): `session:<id|prefix>`,
// `agent:<runtime>:<cwd>`, `new:<runtime>:<cwd>`, and `user`.
//
// Resolution reads only the endpoint.list projection (and principal.resolve
// for `agent:`), and only against a complete candidate set. Every refusal is
// raised here, before the caller writes anything, so a wrong or ambiguous
// address can never deliver to — or wake — a sibling session.

import { AgentCommandError } from './agent_commands.mjs';
import { deriveSessionState, SESSION_LIST_LIMIT, sessionHandlesFor, sessionRow } from './agent_sessions.mjs';
import { prepareNewAgent } from './new_agent.mjs';
import { tightbeamRecipeCommand } from './package_context.mjs';
import { uniqueShortIds } from '../protocol/ids.mjs';

const MIN_SESSION_PREFIX = 4;
const shortId = (id) => String(id ?? '').slice(0, 8);

// parseAgentCommand narrows this to the verb's own help.
function usage(message) {
  throw new AgentCommandError('usage_error', message, { next_action: `${tightbeamRecipeCommand()} agent --help` });
}

function runtimeAndCwd(rest, form) {
  const separator = rest.indexOf(':');
  const runtime = separator > 0 ? rest.slice(0, separator) : '';
  const cwd = separator > 0 ? rest.slice(separator + 1) : '';
  if (runtime.length === 0 || cwd.length === 0) {
    if (form === 'agent') usage(`agent:${rest} is reserved; address a session as session:<id> or agent:<runtime>:<cwd>`);
    usage('--to new: requires new:<runtime>:<cwd>');
  }
  return { runtime, cwd };
}

/**
 * Parses the `session:`, `agent:`, and `new:` forms; any other value is null.
 * `agent:` keeps its stable principal ref (`<runtime>:<cwd>`) as the parsed
 * shape so invocation fingerprints of existing callers do not move.
 */
export function parseAgentAddress(value) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('session:')) {
    const id = value.slice('session:'.length);
    if (id.length < MIN_SESSION_PREFIX) usage(`session:<id> needs the full session id or a prefix of at least ${MIN_SESSION_PREFIX} characters`);
    return { kind: 'session', id };
  }
  if (value.startsWith('agent:')) {
    const ref = value.slice('agent:'.length);
    runtimeAndCwd(ref, 'agent');
    return { kind: 'agent', ref };
  }
  if (value.startsWith('new:')) return { kind: 'new', ...runtimeAndCwd(value.slice('new:'.length), 'new') };
  return null;
}

export function formatAddress(target) {
  if (target.kind === 'session') return `session:${target.id}`;
  if (target.kind === 'agent') return `agent:${target.ref}`;
  if (target.kind === 'new') return `new:${target.runtime}:${target.cwd}`;
  return target.kind;
}

function debugLog(fields) {
  if (!process.env.TIGHTBEAM_HOOK_DEBUG) return;
  try {
    process.stderr.write(`${JSON.stringify({ component: 'tightbeam-agent', ...fields })}\n`);
  } catch {
    // Diagnostics never change the result.
  }
}

async function completeEndpointRows(client, payload) {
  const listed = await client.request('endpoint.list', { ...payload, limit: SESSION_LIST_LIMIT });
  if (listed.truncated) {
    throw new AgentCommandError('session_list_truncated', `More than ${SESSION_LIST_LIMIT} sessions matched, so the address cannot be resolved exactly.`, {
      details: { limit: SESSION_LIST_LIMIT, truncated: true },
      next_action: `${tightbeamRecipeCommand()} agent sessions --runtime <runtime>`,
    });
  }
  return listed.endpoints ?? [];
}

async function completeEndpointList(client, payload) {
  // A sessionless placeholder is not a session anyone can address.
  return (await completeEndpointRows(client, payload)).filter((row) => typeof row.provider_session_id === 'string' && row.provider_session_id.length > 0);
}

const isLive = (row) => deriveSessionState(row).state !== 'ended';

function candidateLine(row, handle) {
  const { state } = deriveSessionState(row);
  return `  ${handle} · ${row.runtime ?? 'agent'} · ${state} · ${row.authority_reference ?? 'unknown cwd'}`;
}

function sessionAmbiguous(address, rows, verb) {
  const runtimes = [...new Set(rows.map((row) => row.runtime ?? 'agent'))];
  const label = runtimes.length === 1 ? `${runtimes[0]} sessions` : 'sessions';
  const handles = uniqueShortIds(rows.map((row) => row.provider_session_id));
  const commands = rows.map((row) => `${tightbeamRecipeCommand()} agent ${verb} --to session:${row.provider_session_id} …`);
  const lines = rows.map((row, index) => candidateLine(row, handles[index]));
  return new AgentCommandError('session_ambiguous', [`${rows.length} ${label} match ${address}. Choose one:`, ...lines].join('\n'), {
    details: {
      address,
      candidates: rows.map((row, index) => ({ ...sessionRow(row), short_id: handles[index], command: commands[index] })),
    },
    next_action: commands.join('\n'),
  });
}

function sessionNotFound(address, next = `${tightbeamRecipeCommand()} agent sessions`) {
  return new AgentCommandError('session_not_found', `No session matches ${address}.`, { details: { address }, next_action: next });
}

// The ended session is named by the handle that tells it from a same-prefix
// sibling (F25), the one `agent sessions` shows; the full id stays in the details.
async function sessionEnded(client, address, row) {
  const handle = (await sessionHandlesFor(client, [row.provider_session_id]))(row.provider_session_id);
  return new AgentCommandError('session_ended', `Session ${handle} has ended and cannot be resumed.`, {
    details: { address, session: { ...sessionRow(row), short_id: handle } },
    next_action: `${tightbeamRecipeCommand()} agent request --to new:${row.runtime}:${row.authority_reference} …`,
  });
}

// A full id is looked up through the exact provider_session_id filter, which
// stays small however many sessions exist; only a prefix needs every session.
async function sessionMatches(client, id) {
  const exact = (await completeEndpointList(client, { provider_session_id: id, include_closed: true })).filter((row) => row.provider_session_id === id);
  if (exact.length > 0) return exact;
  return completeEndpointList(client, { provider_session_id_prefix: id, include_closed: true });
}

async function resolveSessionId(client, target, verb) {
  const address = formatAddress(target);
  const matches = await sessionMatches(client, target.id);
  const live = matches.filter(isLive);
  if (live.length === 1) return live[0];
  if (live.length > 1) throw sessionAmbiguous(address, live, verb);
  if (matches.length > 0) throw await sessionEnded(client, address, matches[0]);
  throw sessionNotFound(address);
}

// principal.resolve's endpoint_ambiguous also counts superseded and
// sessionless endpoints, so the addressable sessions in the folder decide:
// exactly one live session resolves to it, as session:<id> would; several
// are session_ambiguous with one command each; none is ended or not found.
async function liveSessionInCwd(client, { address, runtime, cwd, verb }) {
  const here = await completeEndpointList(client, { runtime, authority_reference: cwd });
  const live = here.filter(isLive);
  if (live.length === 1) return live[0];
  if (live.length > 1) throw sessionAmbiguous(address, live, verb);
  if (here.length > 0) throw await sessionEnded(client, address, here[0]);
  throw sessionNotFound(address, `${tightbeamRecipeCommand()} agent sessions --cwd ${cwd}`);
}

async function resolveAgentRef(client, session, target, verb) {
  const address = formatAddress(target);
  const { runtime, cwd } = runtimeAndCwd(target.ref, 'agent');
  let resolved;
  try {
    resolved = await client.request('principal.resolve', { authority_name: session.authority_name, external_principal_ref: target.ref, require_endpoint: true });
  } catch (error) {
    if (error?.code === 'principal_not_found' || error?.code === 'endpoint_not_found') {
      throw sessionNotFound(address, `${tightbeamRecipeCommand()} agent sessions --cwd ${cwd}`);
    }
    if (error?.code !== 'endpoint_ambiguous') throw error;
    return liveSessionInCwd(client, { address, runtime, cwd, verb });
  }
  const row = (await completeEndpointList(client, { runtime, endpoint_id: resolved.endpoint_id })).find((candidate) => candidate.principal_id === resolved.principal_id);
  if (!row || !isLive(row)) throw sessionNotFound(address, `${tightbeamRecipeCommand()} agent sessions --cwd ${cwd}`);
  return row;
}

const CONFIRMATION_WARNINGS = {
  routed_recipient_unavailable: 'The message was already sent to a replacement session whose identity could not be read; do not resend.',
  new_agent_status_unavailable: "The message was already sent; the new agent's start could not be confirmed; do not resend.",
};

/**
 * The warning a degraded recipient confirmation carries (additive
 * `confirmation_warning`): the commit succeeded, only its enrichment did not.
 * @param {{degraded?: string}} resolved a recipient from routedRecipient or settleNewAgent
 * @returns {string|null}
 */
export function confirmationWarning(resolved) {
  const message = CONFIRMATION_WARNINGS[resolved?.degraded];
  return message ? `${message} Check it with ${tightbeamRecipeCommand()} agent threads.` : null;
}

/**
 * The recipient a commit actually reached. It is the resolved one unless
 * resume lineage moved the resolved endpoint to a replacement between
 * resolution and commit (the commit result's `replaced_endpoint_id`); then it
 * is the replacement, with `replacement_for` naming the session it replaced.
 * @param {{request: Function}} client
 * @param {{session_id: string|null, runtime: string|null, cwd: string|null, state: string}} resolved
 * @param {{routed_endpoint_id?: string, replaced_endpoint_id?: string}} committed the message.commit result
 */
export async function routedRecipient(client, resolved, committed, { log = debugLog } = {}) {
  if (!committed?.replaced_endpoint_id || !committed.routed_endpoint_id) return resolved;
  // The commit is already durable, so nothing here may fail the command. The
  // replacement is read by its exact endpoint id (one row, never truncated); a
  // just-admitted replacement may still be a sessionless placeholder, which is
  // why it is read as an endpoint rather than searched among addressable
  // sessions. If it cannot be read, the confirmation is degraded, not lost.
  let row = null;
  let failure = null;
  try {
    const listed = await client.request('endpoint.list', { endpoint_id: committed.routed_endpoint_id, include_closed: true, limit: 1 });
    row = (listed.endpoints ?? []).find((candidate) => candidate.endpoint_id === committed.routed_endpoint_id) ?? null;
  } catch (error) {
    failure = error;
  }
  log({
    event: 'agent_address.routed',
    params: { resolved: shortId(resolved.session_id) },
    result: { route: 'replacement', session: shortId(row?.provider_session_id), found: Boolean(row), ...(failure ? { code: failure?.code ?? 'error', message: failure?.message } : {}) },
    status: row ? 'remapped' : 'degraded',
  });
  return {
    session_id: row?.provider_session_id ?? null,
    runtime: row?.runtime ?? resolved.runtime,
    cwd: row?.authority_reference ?? resolved.cwd,
    state: row ? deriveSessionState(row).state : 'unknown',
    replacement_for: resolved.session_id,
    ...(row ? {} : { degraded: 'routed_recipient_unavailable' }),
  };
}

/**
 * Resolves a `session:` or `agent:` address to exactly one open endpoint.
 * @returns {Promise<{principal_id: string, endpoint_id: string, resolved: {session_id: string, runtime: string|null, cwd: string|null, state: string}}>}
 */
export async function resolveAgentAddress(client, session, target, { verb, log = debugLog, replay = null } = {}) {
  const started = Date.now();
  const params = { form: target.kind, verb };
  try {
    if (target.kind === 'new') return await prepareNewAgent(client, session, target, { log, replay });
    const row = target.kind === 'session' ? await resolveSessionId(client, target, verb) : await resolveAgentRef(client, session, target, verb);
    const { state } = deriveSessionState(row);
    log({ event: 'agent_address.resolve', params, result: { session: shortId(row.provider_session_id), state, candidates: 1 }, status: 'resolved', latency_ms: Date.now() - started });
    return {
      principal_id: row.principal_id,
      endpoint_id: row.endpoint_id,
      resolved: { session_id: row.provider_session_id, runtime: row.runtime ?? null, cwd: row.authority_reference ?? null, state },
    };
  } catch (error) {
    const candidates = error?.details?.candidates?.length ?? 0;
    log({ event: 'agent_address.resolve', params, result: { code: error?.code ?? 'error', candidates }, status: 'refused', latency_ms: Date.now() - started });
    throw error;
  }
}
