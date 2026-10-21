// `agent threads` (UX S5) and `agent thread` (UX S6): thin renderers over the
// thread.list and thread.history daemon ops.
//
// Both reads pass only the caller's loaded session tuple; there is no way to
// name another session. Neither ever marks anything read: the ops are
// read-only and this module only renders what they return. A truncated list
// is reported as partial, never as the whole set.

import { AgentCommandError } from './agent_commands.mjs';
import { offerActionCommands, tightbeamRecipeCommand, workActionCommands, workActionLines } from './package_context.mjs';
import { uniqueShortIds } from '../protocol/ids.mjs';

export const THREAD_LIST_LIMIT = 100;

function debugLog(fields) {
  if (!process.env.TIGHTBEAM_HOOK_DEBUG) return;
  try {
    process.stderr.write(`${JSON.stringify({ component: 'tightbeam-agent', ...fields })}\n`);
  } catch {
    // Diagnostics never change the result.
  }
}

function sessionTuple(session) {
  return { principal_id: session.principal_id, endpoint_id: session.endpoint_id, process_generation: session.process_generation };
}

export const shortThreadId = (conversationId) => String(conversationId ?? '').replace(/^cnv_/, '').slice(0, 8);
const shortId = (id) => String(id ?? '').slice(0, 8);

// The daemon names each session with a handle that is unique among known
// sessions (`short_id`, at least 8 characters). A session with no provider id
// is a `new:` placeholder that never started, not a resumable session.
const neverStarted = (participant) => participant.kind === 'session' && !participant.provider_session_id;
const handleOf = (participant) => participant.short_id ?? shortId(participant.provider_session_id ?? participant.endpoint_id);
const runtimeOf = (participant) => participant.runtime ?? 'agent';
const sessionLabel = (participant) => (neverStarted(participant) ? `${runtimeOf(participant)} (never started)` : `${runtimeOf(participant)} ${handleOf(participant)}`);

// F19: the delegate's own answer to a pending offer. `indent` nests the lines
// under a thread row.
function offerLines(delegationId, indent = '') {
  const offer = offerActionCommands(delegationId);
  return [
    `${indent}Delegation: ${delegationId} · offered to you; receive it, then accept or decline`,
    `${indent}Accept: ${offer.accept}`,
    `${indent}Decline: ${offer.decline}`,
  ];
}

// The commands one held work offers, as JSON fields.
function workCommandFields(work) {
  const commands = workActionCommands(work.work_id);
  return {
    update_command: commands.update,
    complete_command: commands.complete,
    delegate_command: commands.delegate,
    ...(work.ack_pending === true ? { ack_command: commands.ack } : {}),
  };
}

// Every delegation offered to the caller, newest root first: the daemon's
// `pending_offers`, else its single `pending_offer`.
function offerIdsOf(thread) {
  const offers = Array.isArray(thread.pending_offers) ? thread.pending_offers : thread.pending_offer ? [thread.pending_offer] : [];
  return offers.map((offer) => offer?.delegation_id).filter((id) => typeof id === 'string');
}

// Every open root the caller holds, newest first: the daemon's `held_works`,
// else its single `held_work`.
function heldWorksOf(thread) {
  const works = Array.isArray(thread.held_works) ? thread.held_works : thread.held_work ? [thread.held_work] : [];
  return works.filter((work) => typeof work?.work_id === 'string');
}

// Additive JSON: the same commands, as fields, beside the daemon's `pending_offer`
// and (F23) `held_work`, the tracked work the caller holds. `held_works` lists
// every held root, each with its own commands; the flat fields stay the newest.
function withOfferCommands(thread) {
  const delegationId = thread.pending_offer?.delegation_id;
  const offer = typeof delegationId === 'string' ? offerActionCommands(delegationId) : null;
  const works = heldWorksOf(thread);
  if (!offer && works.length === 0) return thread;
  return {
    ...thread,
    ...(offer ? { accept_command: offer.accept, decline_command: offer.decline } : {}),
    ...(Array.isArray(thread.pending_offers) ? { pending_offers: thread.pending_offers.map((found) => ({ ...found, ...offerCommandFields(found.delegation_id) })) } : {}),
    ...(works.length > 0 ? workCommandFields(works[0]) : {}),
    ...(Array.isArray(thread.held_works) ? { held_works: works.map((work) => ({ ...work, ...workCommandFields(work) })) } : {}),
  };
}

function offerCommandFields(delegationId) {
  const commands = offerActionCommands(delegationId);
  return { accept_command: commands.accept, decline_command: commands.decline };
}

// F23: each work id the holder acts on, with the commands that use it.
function heldWorkLines(thread, options) {
  return heldWorksOf(thread).flatMap((work) => workActionLines(work, options));
}

function age(iso, now) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (!Number.isFinite(minutes) || minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / (60 * 24))}d ago`;
}

/** How one thread participant reads to an agent: `you`, `<runtime> <id8>`, or `user (<label>)`. */
export function participantLabel(participant) {
  if (!participant) return 'unknown';
  if (participant.kind === 'user') return `user (${participant.label ?? 'user'})`;
  if (participant.kind === 'session') {
    if (participant.is_self) return 'you';
    return sessionLabel(participant);
  }
  return 'another agent';
}

const workLabel = (state) => (state ? state.replaceAll('_', ' ') : null);

/**
 * UX §9 agent_launch_failed for a daemon `launch_failure` projection. Tracked
 * work stays open as needs attention; an untracked message was not delivered.
 * @returns {{code: 'agent_launch_failed', runtime: string, cwd: string, reason: string, message: string}|null}
 */
// F34: a resume the daemon ended on purpose because another app holds the
// session. The session is fine and the message is unread, so the copy says
// where the message is and what to do, instead of "not delivered".
const HOSTED_FAILURE_COPY = {
  codex_host_unknown: { reason: 'could not tell whether the session is open in another app', next: 'Send again to retry.' },
  codex_queue_refused: { reason: 'the session is open in another app that cannot take the message', next: 'Close it there, then send again.' },
  codex_queue_failed: { reason: 'the session is open in another app and the message could not be queued to it', next: 'Send again to retry.' },
};

const failureReasonText = (failure) => HOSTED_FAILURE_COPY[failure.reason]?.reason ?? failure.reason.replaceAll('_', ' ');

const launchFailureHead = (failure) => (failure.session_id
  ? `${failure.runtime} ${failure.short_id ?? shortId(failure.session_id)} could not resume in ${failure.cwd}: ${failureReasonText(failure)}`
  : `${failure.runtime} could not start in ${failure.cwd}: ${failureReasonText(failure)}`);

export function launchFailureNotice(failure, { tracked }) {
  if (!failure) return null;
  const hosted = HOSTED_FAILURE_COPY[failure.reason];
  const tail = hosted
    ? `${tracked ? 'The request is tracked as needs attention. ' : ''}The message stays unread until that session next runs. ${hosted.next}`
    : tracked ? 'The request is tracked as needs attention.' : 'The message was not delivered.';
  const resumed = failure.session_id ? { session_id: failure.session_id, ...(failure.short_id ? { short_id: failure.short_id } : {}), attention_source: failure.attention_source } : {};
  return { code: 'agent_launch_failed', runtime: failure.runtime, cwd: failure.cwd, reason: failure.reason, ...resumed, message: `${launchFailureHead(failure)}. ${tail}` };
}

function threadLine(row, now) {
  const others = (row.participants ?? []).filter((participant) => !participant.is_self).map(participantLabel);
  const parts = [
    row.thread_short_id,
    row.subject ?? '(no subject)',
    row.role,
    row.work_state ? `work ${workLabel(row.work_state)}` : 'no tracked work',
    row.delivery_step ? `delivery ${row.delivery_step}` : null,
    row.launch_failure ? `${row.launch_failure.code}: ${launchFailureHead(row.launch_failure)}` : null,
    row.unread_count > 0 ? `${row.unread_count} unread` : null,
    `waiting on ${row.waiting_on}`,
    `active ${age(row.last_activity_at, now)}`,
    others.length > 0 ? `with ${others.join(', ')}` : null,
  ];
  return `  ${parts.filter(Boolean).join(' · ')}`;
}

/** UX §9 S5 text: header with counts, one row per thread, footer; the empty state when there are none. */
export function renderThreads(result, { now = Date.now() } = {}) {
  const threads = result.threads ?? [];
  if (threads.length === 0) return result.filters?.all ? 'No threads.' : 'No open threads.';
  const lines = [`Threads · ${result.open_count} open · ${result.waiting_on_you_count} waiting on you`];
  for (const row of threads) {
    lines.push(threadLine(row, now));
    for (const delegationId of offerIdsOf(row)) lines.push(...offerLines(delegationId, '    '));
    lines.push(...heldWorkLines(row, { indent: '    ' }));
  }
  if (result.truncated) {
    lines.push(`Partial list: only the ${threads.length} most recent threads are shown; more matched. Narrow with --waiting-on me|them.`);
  }
  lines.push('Read one with agent thread --thread <handle>.');
  return lines.join('\n');
}

/**
 * Lists the threads the caller started or takes part in (thread.list).
 * @param {{request: Function}} client
 * @param {object} session the loaded agent session tuple
 * @param {{all?: boolean, waitingOn?: 'me'|'them'|null}} filters
 */
export async function listAgentThreads(client, session, filters = {}, { now = Date.now(), log = debugLog } = {}) {
  const started = Date.now();
  const all = filters.all === true;
  const waitingOn = filters.waitingOn ?? null;
  const payload = { ...sessionTuple(session), ...(all ? { all: true } : {}), ...(waitingOn ? { waiting_on: waitingOn } : {}), limit: THREAD_LIST_LIMIT };
  const params = { all, waiting_on: waitingOn, limit: THREAD_LIST_LIMIT };
  let listed;
  try {
    listed = await client.request('thread.list', payload);
  } catch (error) {
    log({ event: 'agent_threads', params, result: { error_code: error?.code ?? null }, status: 'error', latency_ms: Date.now() - started });
    throw error;
  }
  const threads = (listed.threads ?? []).map((row) => withOfferCommands({
    ...row,
    thread_short_id: shortThreadId(row.conversation_id),
    launch_failure: launchFailureNotice(row.launch_failure, { tracked: row.root_obligation_id !== null }),
  }));
  const truncated = listed.truncated === true;
  const result = {
    outcome: 'committed',
    complete: !truncated,
    truncated,
    count: threads.length,
    open_count: threads.filter((row) => row.open).length,
    waiting_on_you_count: threads.filter((row) => row.waiting_on === 'you').length,
    filters: { all, waiting_on: waitingOn },
    threads,
  };
  log({ event: 'agent_threads', params, result: { count: result.count, open: result.open_count, waiting_on_you: result.waiting_on_you_count, truncated }, status: 'ok', latency_ms: Date.now() - started });
  return { ...result, rendered: renderThreads(result, { now }) };
}

// --- agent thread --thread <handle> (S6) ------------------------------------

export const MIN_HANDLE_LENGTH = 8;
const CANDIDATE_LIST_LIMIT = 1000;
const UNREAD_TAG = '(unread · receive or reply to clear)';

const MESSAGE_KINDS = {
  open: 'request',
  update: 'update',
  'handoff.offer': 'delegation offer',
  'handoff.accept': 'delegation accepted',
  'handoff.decline': 'delegation declined',
  'close.fulfilled': 'result',
  'close.cancelled': 'cancellation',
};

export const handleHex = (handle) => String(handle).replace(/^cnv_/, '');
const threadsNext = () => `${tightbeamRecipeCommand()} agent threads`;

function threadNotFound(handle) {
  return new AgentCommandError('thread_not_found', `No thread matches ${handle}.`, { details: { thread: handle }, next_action: threadsNext() });
}

function notAParticipant(handle) {
  return new AgentCommandError('not_a_participant', `You are not a participant in thread ${handleHex(handle).slice(0, MIN_HANDLE_LENGTH)}.`, {
    details: { thread: handle },
    next_action: threadsNext(),
  });
}

const readThreadCommand = (conversationId) => `${tightbeamRecipeCommand()} agent thread --thread ${conversationId}`;

/**
 * The daemon only says a handle is ambiguous; the candidates come from the
 * caller's own thread.list, so nothing outside the caller's threads is named.
 * `command` is the ready next action for one candidate's full id.
 */
export async function ambiguousThread(client, session, handle, { tooShort, command = readThreadCommand }) {
  const listed = await client.request('thread.list', { ...sessionTuple(session), all: true, limit: CANDIDATE_LIST_LIMIT });
  const hex = handleHex(handle);
  const matches = (listed.threads ?? []).filter((row) => handleHex(row.conversation_id).startsWith(hex));
  const handles = uniqueShortIds(matches.map((row) => handleHex(row.conversation_id)));
  const candidates = matches.map((row, index) => ({ conversation_id: row.conversation_id, thread_short_id: handles[index], subject: row.subject ?? null, last_activity_at: row.last_activity_at }));
  if (candidates.length === 0) return threadNotFound(handle);
  const ask = tooShort ? 'Use at least 8 characters, or choose one:' : 'Choose one:';
  const rows = candidates.map((row) => `  ${row.conversation_id} · ${row.subject ?? '(no subject)'}`);
  return new AgentCommandError('thread_ambiguous', [`${candidates.length} of your threads match ${handle}. ${ask}`, ...rows].join('\n'), {
    details: { thread: handle, candidates, truncated: listed.truncated === true },
    next_action: candidates.map((row) => command(row.conversation_id)).join('\n'),
  });
}

function refusalFor(error, handle) {
  if (error?.code === 'thread_not_found') return threadNotFound(handle);
  if (error?.code === 'not_a_participant') return notAParticipant(handle);
  return null;
}

function shortHolder(session) {
  if (!session) return null;
  if (session.is_self) return 'you';
  return neverStarted(session) ? sessionLabel(session) : handleOf(session);
}

function workLine(thread) {
  const parts = [thread.work_state ? workLabel(thread.work_state) : 'no tracked work'];
  const holder = shortHolder(thread.holder);
  if (holder) parts.push(`held by ${holder}`);
  const owedBy = thread.owed_by;
  if (owedBy && owedBy.endpoint_id !== thread.holder?.endpoint_id) parts.push(`owes you: ${shortHolder(owedBy)}`);
  parts.push(`waiting on ${thread.waiting_on}`);
  return `Work: ${parts.join(' · ')}`;
}

function sessionWho(participant) {
  return sessionLabel(participant);
}

// UX §9 S6: the caller leads as `you`. A replacement that has not spoken in an
// adopted thread is absent from the daemon's participants, so it is built from
// its own session, and the predecessors named by adopted_from read as replaced.
function participantsLine(thread, session) {
  const predecessorIds = new Set((thread.adopted_from ?? []).map((from) => from.endpoint_id));
  const participants = thread.participants ?? [];
  const self = participants.find((participant) => participant.is_self);
  // A replacement that has not spoken in the thread is absent from the
  // participants: its handle must still differ from every session named here.
  const callerHandle = () => uniqueShortIds([session?.session_id ?? '', ...participants.map((participant) => participant.provider_session_id ?? '')])[0];
  const you = self || predecessorIds.size > 0
    ? `you (${self ? sessionWho(self) : `${session?.runtime ?? 'agent'} ${callerHandle()}`}, ${self?.role ?? thread.role})`
    : null;
  const others = participants.filter((participant) => !participant.is_self).map((participant) => {
    if (participant.kind !== 'session') return participantLabel(participant);
    const role = predecessorIds.has(participant.endpoint_id) ? 'replaced' : participant.role;
    return neverStarted(participant) ? `${runtimeOf(participant)} (never started, ${role})` : `${sessionWho(participant)} (${role})`;
  });
  return `Participants: ${[you, ...others].filter(Boolean).join(' · ')}`;
}

function recipientLabel(recipient) {
  return recipient.step ? `${participantLabel(recipient)} (${recipient.step})` : participantLabel(recipient);
}

function messageLines(item) {
  const recipients = (item.recipients ?? []).map(recipientLabel);
  const head = [
    item.at,
    item.message_id,
    recipients.length > 0 ? `${participantLabel(item.sender)} to ${recipients.join(', ')}` : `from ${participantLabel(item.sender)}`,
    MESSAGE_KINDS[item.kind] ?? 'message',
    item.unread ? UNREAD_TAG : null,
  ];
  const body = String(item.body ?? '').split('\n').map((line) => `    ${line}`);
  // An unread wake that returns offered work to its offerer: say what it is above the offer text it re-delivers.
  const notice = typeof item.notice?.text === 'string' ? [`    Notice: ${item.notice.text}`] : [];
  return [`  ${head.filter(Boolean).join(' · ')}`, ...notice, ...body];
}

function eventText(item) {
  const actor = participantLabel(item.actor);
  switch (item.event) {
    case 'opened': return `work opened by ${actor}${item.holder ? ` · held by ${participantLabel(item.holder)}` : ''}`;
    case 'delegated': return `delegation offered by ${actor}`;
    case 'accepted': return `delegation accepted by ${actor}${item.holder ? ` · now held by ${participantLabel(item.holder)}` : ''}`;
    case 'declined': return `delegation declined by ${actor}`;
    case 'completed': return `work completed by ${actor}`;
    case 'cancelled': return `work cancelled by ${actor}`;
    case 'replaced': return `${participantLabel(item.replaced)} could not be resumed · replaced by ${participantLabel(item.replacement)}`;
    default: return `${item.event} by ${actor}`;
  }
}

/** UX §9 S6 text: subject, participants, work, the hidden-count line when paged, then items oldest first. */
export function renderThreadHistory(result, session) {
  const thread = result.thread;
  const lines = [`Thread ${thread.thread_short_id} · ${thread.subject ?? '(no subject)'}`, participantsLine(thread, session), workLine(thread)];
  for (const delegationId of offerIdsOf(thread)) lines.push(...offerLines(delegationId));
  lines.push(...heldWorkLines(thread, { workLabel: 'Work id' }));
  if (result.hidden_count > 0) lines.push(`${result.hidden_count} earlier items hidden; use --since or --limit`);
  lines.push('');
  for (const item of result.items ?? []) {
    if (item.type === 'message') lines.push(...messageLines(item));
    else lines.push(`  ${item.at} · ${eventText(item)}`);
  }
  return lines.join('\n').trimEnd();
}

/**
 * The read-only history of one thread the caller takes part in (thread.history).
 * The handle goes to the daemon as typed; it never marks anything read.
 * @param {{request: Function}} client
 * @param {object} session the loaded agent session tuple
 * @param {{thread: string, limit?: number|null, since?: string|null}} query
 */
export async function readAgentThread(client, session, query, { log = debugLog } = {}) {
  const started = Date.now();
  const handle = query.thread;
  const params = { handle_length: handleHex(handle).length, limit: query.limit ?? null, since: query.since ?? null };
  const refuse = (error) => {
    log({ event: 'agent_thread', params, result: { error_code: error?.code ?? null }, status: 'refused', latency_ms: Date.now() - started });
    return error;
  };
  const hex = handleHex(handle);
  if (!/^[0-9a-f]+$/.test(hex)) throw refuse(threadNotFound(handle));
  if (hex.length < MIN_HANDLE_LENGTH) throw refuse(await ambiguousThread(client, session, handle, { tooShort: true }));

  const payload = { ...sessionTuple(session), thread: handle, ...(query.limit ? { limit: query.limit } : {}), ...(query.since ? { since: query.since } : {}) };
  let history;
  try {
    history = await client.request('thread.history', payload);
  } catch (error) {
    const refusal = refusalFor(error, handle);
    if (refusal) throw refuse(refusal);
    if (error?.code === 'malformed_request' && error.details?.field === 'thread') throw refuse(await ambiguousThread(client, session, handle, { tooShort: false }));
    log({ event: 'agent_thread', params, result: { error_code: error?.code ?? null }, status: 'error', latency_ms: Date.now() - started });
    throw error;
  }
  const items = history.items ?? [];
  const result = {
    outcome: 'committed',
    thread: withOfferCommands({ ...history.thread, thread_short_id: shortThreadId(history.thread?.conversation_id) }),
    items,
    hidden_count: history.hidden_count ?? 0,
  };
  log({
    event: 'agent_thread',
    params,
    result: { thread: result.thread.thread_short_id, items: items.length, hidden: result.hidden_count, unread: items.filter((item) => item.unread).length },
    status: 'ok',
    latency_ms: Date.now() - started,
  });
  return { ...result, rendered: renderThreadHistory(result, session) };
}
