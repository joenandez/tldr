// `agent sessions` (UX S1) and the session-row helper later verbs reuse.
//
// Everything comes from the endpoint.list projection: the CLI never reads
// raw tables. The listing shows only sessions worth messaging now (live, or
// active in the last day; `--all`: the most recently active), newest
// activity first, and says so when more exist rather than refusing. Address
// resolution never relies on it: it reads the daemon exactly.

import { execFile as nodeExecFile } from 'node:child_process';

import { shortId as protocolShortId, uniqueShortIds } from '../protocol/ids.mjs';

export const SESSION_STATES = Object.freeze(['busy', 'idle', 'stopped', 'ended', 'unknown']);
export const SESSION_LIST_LIMIT = 1000;
const SESSION_ALL_LIMIT = 200;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const STOPPED_FOLDER_LIMIT = 10;
const BRANCH_TIMEOUT_MS = 1000;

/**
 * Derived display state for one endpoint.list row (plan §2.1 table).
 * @param {object} endpoint an endpoint.list row
 * @returns {{state: 'ended'|'stopped'|'busy'|'idle'|'unknown', resumable: boolean}}
 */
export function deriveSessionState(endpoint) {
  if (endpoint.state === 'closed' || endpoint.superseded_by_endpoint_id) return { state: 'ended', resumable: false };
  if (endpoint.state === 'dead' || endpoint.owner_process_exited_at) return { state: 'stopped', resumable: true };
  // Headless or not, only a recorded owner process proves the session is still running.
  const livenessKnown = (endpoint.owner_process_pid ?? null) !== null;
  if (livenessKnown && (endpoint.state === 'busy' || endpoint.state === 'idle')) return { state: endpoint.state, resumable: false };
  return { state: 'unknown', resumable: false };
}

/**
 * One session row as agents see it, from an endpoint.list row.
 * `topic` is always null: nothing derives it in this scope. `you` mirrors
 * `is_self` for callers that predate the UX field names.
 */
export function sessionRow(endpoint, { callerEndpointId = null, callerCwd = null, branch = null } = {}) {
  const { state, resumable } = deriveSessionState(endpoint);
  const cwd = endpoint.authority_reference ?? null;
  const isSelf = endpoint.endpoint_id === callerEndpointId;
  return {
    session_id: endpoint.provider_session_id,
    short_id: protocolShortId(endpoint.provider_session_id),
    endpoint_id: endpoint.endpoint_id,
    runtime: endpoint.runtime ?? null,
    mode: endpoint.launch_mode === 'interactive' ? 'interactive' : endpoint.launch_mode === 'non_interactive' ? 'headless' : 'unknown',
    state,
    resumable,
    cwd,
    topic: null,
    ...(branch ? { branch } : {}),
    last_active_at: endpoint.updated_at,
    created_at: endpoint.created_at,
    tachyon_armed: endpoint.tachyon_armed === true,
    is_self: isSelf,
    you: isSelf,
    group: callerCwd !== null && cwd === callerCwd ? 'this_folder' : 'elsewhere',
  };
}

/**
 * The current git branch of a folder, or null on any failure, timeout, or
 * detached HEAD. It is decoration; it must never fail or slow the listing.
 */
export function readGitBranch(cwd, { execFile = nodeExecFile, timeoutMs = BRANCH_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    try {
      execFile('git', ['-C', cwd, 'branch', '--show-current'], { timeout: timeoutMs, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (error, stdout) => {
        const branch = error ? '' : String(stdout ?? '').trim();
        resolve(branch.length > 0 ? branch : null);
      });
    } catch {
      resolve(null);
    }
  });
}

function debugLog(fields) {
  if (!process.env.TIGHTBEAM_HOOK_DEBUG) return;
  try {
    process.stderr.write(`${JSON.stringify({ component: 'tightbeam-agent', ...fields })}\n`);
  } catch {
    // Diagnostics never change the result.
  }
}

function byNewestActivity(a, b) {
  return b.last_active_at.localeCompare(a.last_active_at) || b.created_at.localeCompare(a.created_at) || a.endpoint_id.localeCompare(b.endpoint_id);
}

async function branchesByCwd(cwds, readBranch) {
  const branches = new Map();
  await Promise.all([...cwds].map(async (cwd) => {
    try {
      const branch = await readBranch(cwd);
      if (branch) branches.set(cwd, branch);
    } catch {
      // Branch is optional decoration.
    }
  }));
  return branches;
}

/**
 * Lists the caller's sessions that are live or were active in the last 24
 * hours; with `all`, the 200 most recently active, ended ones included.
 * @param {{request: Function}} client
 * @param {object} session the loaded agent session (endpoint_id, authority_reference, runtime, session_id)
 * @param {{here?: boolean, cwd?: string|null, runtime?: string|null, state?: string|null, all?: boolean}} filters
 * @returns {Promise<{outcome: 'committed', complete: boolean, truncated: boolean, count: number, you: object, here_cwd: string|null, sessions: object[], rendered: string}>}
 */
export async function listAgentSessions(client, session, filters = {}, { readBranch = readGitBranch, now = Date.now(), log = debugLog } = {}) {
  const started = Date.now();
  const showEnded = filters.all === true || filters.state === 'ended';
  const window = filters.all === true
    ? { order_by: 'updated_at', limit: SESSION_ALL_LIMIT }
    : { active_after: new Date(now - RECENT_WINDOW_MS).toISOString(), order_by: 'updated_at', limit: SESSION_LIST_LIMIT };
  const payload = { include_closed: showEnded, ...window, ...(filters.runtime ? { runtime: filters.runtime } : {}) };
  const listed = await client.request('endpoint.list', payload);
  const truncated = listed.truncated === true;

  const callerCwd = session.authority_reference ?? null;
  const wantedCwd = filters.cwd ?? null;
  const candidates = (listed.endpoints ?? [])
    .filter((endpoint) => typeof endpoint.provider_session_id === 'string' && endpoint.provider_session_id.length > 0)
    .map((endpoint) => ({ endpoint, derived: deriveSessionState(endpoint) }))
    .filter(({ derived }) => showEnded || derived.state !== 'ended')
    .filter(({ derived }) => !filters.state || derived.state === filters.state)
    .filter(({ endpoint }) => wantedCwd === null || endpoint.authority_reference === wantedCwd)
    .filter(({ endpoint }) => !filters.here || (callerCwd !== null && endpoint.authority_reference === callerCwd));

  const branches = await branchesByCwd(new Set(candidates.map(({ endpoint }) => endpoint.authority_reference).filter(Boolean)), readBranch);
  const rows = candidates
    .map(({ endpoint }) => sessionRow(endpoint, { callerEndpointId: session.endpoint_id, callerCwd, branch: branches.get(endpoint.authority_reference) ?? null }))
    .sort((a, b) => (a.group === b.group ? byNewestActivity(a, b) : a.group === 'this_folder' ? -1 : 1));
  // The header names the caller beside the rows, so its id is in the set too.
  const handles = uniqueShortIds([...rows.map((row) => row.session_id), session.session_id ?? '']);
  const sessions = rows.map((row, index) => ({ ...row, short_id: handles[index] }));

  const result = {
    outcome: 'committed',
    complete: !truncated,
    truncated,
    count: sessions.length,
    you: { session_id: session.session_id ?? null, endpoint_id: session.endpoint_id, runtime: session.runtime ?? null, cwd: callerCwd },
    here_cwd: callerCwd,
    ...(showEnded ? { includes_ended: true } : {}),
    sessions,
  };
  log({ event: 'agent_sessions', params: { ...payload, state: filters.state ?? null, here: filters.here === true }, result: { count: sessions.length, truncated }, status: 'ok', latency_ms: Date.now() - started });
  // A narrowed list (--all, --cwd, --here, --state) shows every session; the default view collapses stopped ones by folder.
  const collapse = !filters.all && !filters.cwd && !filters.here && !filters.state;
  return { ...result, rendered: renderSessions(result, { now, youShortId: handles.at(-1), collapse }) };
}

const shortId = (id) => String(id ?? '').slice(0, 8);

/**
 * How one-session confirmations and notices name sessions: each id's handle is
 * its shortest prefix of at least 8 characters that no other known session
 * (ended ones included) shares, so a session and its replacement never read
 * alike. endpoint.list is newest-first and capped, so a truncated read cannot
 * prove a handle unique: same-prefix rivals are then read through a complete
 * prefix lookup, and where that cannot be proven either (or the read itself
 * failed) the session is named by its full id rather than a handle that may
 * be shared. An id the lookup was not asked about falls back to its first 8
 * characters.
 * @param {{request: Function}} client
 * @param {Array<string|null|undefined>} ids the sessions the output will name
 */
export async function sessionHandlesFor(client, ids, { log = debugLog } = {}) {
  const named = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];
  const prefixes = [...new Set(named.map(shortId))];
  let known = [];
  let unproven = new Set();
  try {
    const listed = await client.request('endpoint.list', { include_closed: true, limit: SESSION_LIST_LIMIT });
    known = (listed.endpoints ?? []).map((row) => row.provider_session_id);
    if (listed.truncated) {
      const rivals = await prefixRivals(client, prefixes);
      known = [...known, ...rivals.known];
      unproven = rivals.unproven;
      log({ event: 'agent_sessions.handles', params: { named: named.length }, result: { limit: SESSION_LIST_LIMIT, truncated: true, unproven: unproven.size }, status: unproven.size > 0 ? 'degraded' : 'prefix_lookup' });
    }
  } catch (error) {
    unproven = new Set(prefixes);
    log({ event: 'agent_sessions.handles', params: { named: named.length }, result: { code: error?.code ?? 'error', message: error?.message }, status: 'degraded' });
  }
  return sessionHandleLookup(named, known, { unproven });
}

// Every known session sharing each prefix, read exactly. A prefix whose read
// failed or was itself cut off is unproven.
async function prefixRivals(client, prefixes) {
  const known = [];
  const unproven = new Set();
  await Promise.all(prefixes.map(async (prefix) => {
    try {
      const listed = await client.request('endpoint.list', { provider_session_id_prefix: prefix, include_closed: true, limit: SESSION_LIST_LIMIT });
      if (listed.truncated) unproven.add(prefix);
      else known.push(...(listed.endpoints ?? []).map((row) => row.provider_session_id));
    } catch {
      unproven.add(prefix);
    }
  }));
  return { known, unproven };
}

/**
 * The same lookup when the known sessions are already in hand (an
 * endpoint.list the caller read for another reason, and found complete).
 * @param {string[]} named the sessions the output will name
 * @param {Array<string|null|undefined>} known every session id known to the daemon
 * @param {{unproven?: Set<string>}} [options] 8-character prefixes whose rivals could not be proven; their sessions keep their full id
 * @returns {(id: string) => string}
 */
export function sessionHandleLookup(named, known, { unproven = new Set() } = {}) {
  // Only a session sharing its first 8 characters with a named one can lengthen its handle.
  const prefixes = new Set(named.map(shortId));
  const rivals = known.filter((id) => typeof id === 'string' && id.length > 0 && prefixes.has(shortId(id)));
  const all = [...new Set([...named, ...rivals])];
  const unique = uniqueShortIds(all);
  const handles = new Map(all.map((id, index) => [id, unproven.has(shortId(id)) ? id : unique[index]]));
  return (id) => handles.get(id) ?? shortId(id);
}

function age(iso, now) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (!Number.isFinite(minutes) || minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / (60 * 24))}d ago`;
}

function rowLine(row, now) {
  const state = row.state === 'stopped' ? 'stopped · resumable' : row.state;
  const parts = [`${row.short_id}${row.you ? ' (you)' : ''}`, row.runtime, row.mode, state, row.cwd, row.branch, `active ${age(row.last_active_at, now)}`];
  return `  ${parts.filter(Boolean).join(' · ')}`;
}

// Sessions not proven running (stopped or unknown) only by folder, so a busy machine's list stays short.
const notRunning = (row) => row.state === 'stopped' || row.state === 'unknown';

// A folder's not-running sessions as one line: the newest names the folder and the session to resume.
function folderLine(rows, now) {
  if (rows.length === 1) return rowLine(rows[0], now);
  // Point at the newest resumable session when there is one.
  const newest = rows.find((row) => row.state === 'stopped') ?? rows[0];
  const runtimes = Object.entries(Object.groupBy(rows, (row) => row.runtime ?? 'unknown')).map(([runtime, list]) => `${list.length} ${runtime}`).join(', ');
  const stopped = rows.filter((row) => row.state === 'stopped').length;
  const states = [stopped > 0 ? `${stopped} stopped · resumable` : null, rows.length > stopped ? `${rows.length - stopped} unknown` : null].filter(Boolean).join(', ');
  const parts = [newest.cwd, newest.branch, `${states} (${runtimes})`, `newest ${newest.short_id}`, `active ${age(newest.last_active_at, now)}`];
  return `  ${parts.filter(Boolean).join(' · ')}`;
}

// Running sessions one row each, then the rest one line per folder, newest first.
function collapsedLines(rows, now, folderLimit) {
  const folders = Object.values(Object.groupBy(rows.filter(notRunning), (row) => row.cwd ?? ''));
  const shown = folders.slice(0, folderLimit);
  const older = folders.length - shown.length;
  return {
    lines: [...rows.filter((row) => !notRunning(row)).map((row) => rowLine(row, now)), ...shown.map((list) => folderLine(list, now)), ...(older > 0 ? [`  +${older} older folders`] : [])],
    collapsed: older > 0 || shown.some((list) => list.length > 1),
  };
}

/**
 * UX §9 S1 text: header, This folder, Elsewhere, footer; empty state when nobody else is around.
 * With `collapse`, sessions not proven running show one line per folder and Elsewhere shows the newest STOPPED_FOLDER_LIMIT folders.
 */
export function renderSessions(result, { now = Date.now(), youShortId = null, collapse = false } = {}) {
  const sessions = result.sessions ?? [];
  const more = result.truncated ? ['More sessions exist than shown; narrow with --runtime.'] : [];
  if (!sessions.some((row) => !row.you)) return ['No other agent sessions. Start one with --to new:<runtime>:<cwd>.', ...more].join('\n');
  const you = result.you ?? {};
  const label = result.includes_ended ? 'live, resumable, or ended' : 'live or resumable';
  const lines = [`Sessions · ${sessions.length} ${label} · you are ${you.runtime ?? 'agent'} ${youShortId ?? shortId(you.session_id)}`.trimEnd()];
  const groups = [[`This folder (${result.here_cwd ?? 'unknown'})`, 'this_folder'], ['Elsewhere', 'elsewhere']];
  let collapsed = false;
  for (const [heading, group] of groups) {
    lines.push(heading);
    const rows = sessions.filter((row) => row.group === group);
    if (rows.length === 0) lines.push('  (none)');
    else if (!collapse) lines.push(...rows.map((row) => rowLine(row, now)));
    else {
      const view = collapsedLines(rows, now, group === 'elsewhere' ? STOPPED_FOLDER_LIMIT : Infinity);
      lines.push(...view.lines);
      collapsed ||= view.collapsed;
    }
  }
  if (collapsed) lines.push("List one folder's sessions with --cwd <folder>; --all lists every session.");
  lines.push(...more, 'Address one with --to session:<id>. Start a new agent with --to new:<runtime>:<cwd>.');
  return lines.join('\n');
}
