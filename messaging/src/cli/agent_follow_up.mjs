// `agent send --thread <handle> --body …` (UX F9, plan §2.4 SC12): a follow-up
// to the agent that owes the caller in one thread.
//
// The recipient is never chosen here. thread.history's header names it
// (`owed_by`): the custodian of the caller's root attempt, still the delegator
// after a delegation, the replacement after a resume-lineage replacement. The
// message is a `none` effect committed through the checked exact
// `recipient_endpoint_id` route, so only that endpoint gets a delivery or wake
// (never principal fan-out) and no work or obligation is created. Every
// refusal happens before the commit, so it writes nothing.

import { AgentCommandError, commitKey } from './agent_commands.mjs';
import { deriveSessionState, SESSION_LIST_LIMIT, sessionHandlesFor } from './agent_sessions.mjs';
import { confirmationWarning, routedRecipient } from './agent_address.mjs';
import { ambiguousThread, handleHex, MIN_HANDLE_LENGTH } from './agent_threads.mjs';
import { tightbeamRecipeCommand } from './package_context.mjs';

const shortId = (id) => String(id ?? '').replace(/^cnv_/, '').slice(0, 8);

function debugLog(fields) {
  if (!process.env.TIGHTBEAM_HOOK_DEBUG) return;
  try {
    process.stderr.write(`${JSON.stringify({ component: 'tightbeam-agent', ...fields })}\n`);
  } catch {
    // Diagnostics never change the result.
  }
}

// UX §9 refusals for a handle the caller cannot follow up in.
function threadRefusal(error, handle) {
  if (error?.code === 'thread_not_found') {
    return new AgentCommandError('thread_not_found', `No thread matches ${handle}.`, { next_action: `${tightbeamRecipeCommand()} agent threads` });
  }
  if (error?.code === 'not_a_participant') {
    return new AgentCommandError('not_a_participant', `You are not a participant in thread ${shortId(handle)}.`, { next_action: `${tightbeamRecipeCommand()} agent threads` });
  }
  return error;
}

const followUpCommand = (conversationId) => `${tightbeamRecipeCommand()} agent send --thread ${conversationId} --body …`;

// A short or ambiguous handle is answered from the caller's own threads, as
// `agent thread` answers it, with a ready follow-up per candidate.
async function threadHeader(client, session, handle) {
  if (handleHex(handle).length < MIN_HANDLE_LENGTH) throw await ambiguousThread(client, session, handle, { tooShort: true, command: followUpCommand });
  try {
    // Only the header is needed: no item, body, or recipient is read.
    const history = await client.request('thread.history', {
      principal_id: session.principal_id,
      endpoint_id: session.endpoint_id,
      process_generation: session.process_generation,
      thread: handle,
      header_only: true,
    });
    return history.thread;
  } catch (error) {
    if (error?.code === 'malformed_request' && error.details?.field === 'thread') {
      throw await ambiguousThread(client, session, handle, { tooShort: false, command: followUpCommand });
    }
    throw threadRefusal(error, handle);
  }
}

function nobodyOwesYou(thread) {
  return new AgentCommandError('no_counterpart', `Nobody owes you work in thread ${shortId(thread.conversation_id)}; a follow-up goes only to the agent handling your request.`, {
    details: { thread_id: thread.conversation_id },
    next_action: `${tightbeamRecipeCommand()} agent reply --message <message_id> --body "<reply>"`,
  });
}

// How the caller's own root ended, in UX §9 words. A root superseded by a
// cancel reads as the cancel it was; any other supersession just ended.
function closedLabel(owed) {
  switch (owed.root_resolution) {
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'failed';
    case 'superseded':
      return owed.root_superseded_by_resolution === 'cancelled' ? 'cancelled' : 'ended';
    default:
      return 'done';
  }
}

// UX §9 work_closed: show the thread so the caller can see how it ended.
// The label is the caller's own root's, the same root as root_status.
function workClosed(thread, owed) {
  const thread8 = shortId(thread.conversation_id);
  const label = closedLabel(owed);
  return new AgentCommandError('work_closed', `Work on ${thread8} is ${label}.`, {
    details: { root_id: owed.root_obligation_id, thread_id: thread.conversation_id, work_state: label },
    next_action: `${tightbeamRecipeCommand()} agent thread --thread ${thread8}`,
  });
}

// Display state of the resolved recipient, from the endpoint.list projection.
async function recipientState(client, owed) {
  if (!owed.provider_session_id) return 'unknown';
  const listed = await client.request('endpoint.list', { provider_session_id: owed.provider_session_id, include_closed: true, limit: SESSION_LIST_LIMIT });
  const row = (listed.endpoints ?? []).find((candidate) => candidate.endpoint_id === owed.endpoint_id);
  return row ? deriveSessionState(row).state : 'unknown';
}

// The handle the daemon computed to be unique among known sessions, else the
// first 8 characters (a daemon that predates the handle).
const handleOf = (session) => session.short_id ?? shortId(session.provider_session_id ?? session.endpoint_id);

// A replacement that took the follow-up over during the commit is disclosed.
// Its id is new to the header, so its handle and its predecessor's are looked
// up together: the two always read differently.
function followUpConfirmation(owed, thread, resolved, handleFor) {
  const recipient = resolved.replacement_for
    ? `${resolved.runtime ?? 'agent'} ${resolved.session_id ? handleFor(resolved.session_id) : resolved.degraded ? 'unconfirmed' : 'pending'} (replacement for ${handleFor(resolved.replacement_for)})`
    : `${owed.runtime ?? 'agent'} ${handleOf(owed)}`;
  const parts = ['Sent', `follow-up to ${recipient}`];
  if (typeof thread.subject === 'string' && thread.subject.trim().length > 0) parts.push(thread.subject);
  parts.push(shortId(thread.conversation_id));
  if (owed.delegated_to) parts.push(`delegated to ${handleOf(owed.delegated_to)}`);
  return parts.join(' · ');
}

// A retry of this action whose first commit raced an adoption named the
// predecessor (the header said B; the commit landed on B'). The daemon keys
// the replay on that requested recipient, so the retry, which now reads B',
// collides; naming the predecessor again replays the one message.
async function commitOnce(client, request, owed, log) {
  try {
    return await client.request('message.commit', request);
  } catch (error) {
    if (error?.code !== 'idempotency_collision' || !owed.replaced_endpoint_id) throw error;
    log({ event: 'agent_follow_up.replay_predecessor', params: { recipient: shortId(owed.endpoint_id), predecessor: shortId(owed.replaced_endpoint_id) }, status: 'retrying' });
    return client.request('message.commit', { ...request, recipient_endpoint_id: owed.replaced_endpoint_id });
  }
}

async function commitFollowUp(client, session, command, thread, owed, log) {
  const owedResolved = { session_id: owed.provider_session_id ?? null, runtime: owed.runtime ?? null, cwd: owed.authority_reference ?? null, state: await recipientState(client, owed) };
  const result = await commitOnce(client, {
    sender_principal_id: session.principal_id,
    conversation_id: thread.conversation_id,
    body: command.body,
    // Bound to the thread and the caller's root, never the endpoint: a replay
    // of this action is the same message even after a replacement adopted
    // the recipient in between.
    idempotency_key: commitKey('send', command, `follow-up:${thread.conversation_id}${owed.root_obligation_id ? `:${owed.root_obligation_id}` : ''}`),
    recipient_endpoint_id: owed.endpoint_id,
    obligation_effect: { type: 'none', sender_endpoint_id: session.endpoint_id, process_generation: session.process_generation },
  }, owed, log);
  // Landing where the header already pointed discloses nothing new.
  const resolved = result.routed_endpoint_id === owed.endpoint_id ? owedResolved : await routedRecipient(client, owedResolved, result);
  const handleFor = resolved.replacement_for ? await sessionHandlesFor(client, [resolved.session_id, resolved.replacement_for], { log }) : null;
  const warning = confirmationWarning(resolved);
  const confirmation = followUpConfirmation(owed, thread, resolved, handleFor);
  return {
    outcome: 'committed',
    message_id: result.message_id,
    conversation_id: result.conversation_id,
    reply_policy: 'no reply required',
    subject: thread.subject ?? null,
    thread_short_id: shortId(result.conversation_id),
    work_id: owed.root_obligation_id,
    resolved,
    thread_id: result.conversation_id,
    delegated_to: owed.delegated_to ?? null,
    routed_endpoint_id: result.routed_endpoint_id ?? owed.endpoint_id,
    replaced_endpoint_id: result.replaced_endpoint_id ?? owed.replaced_endpoint_id ?? null,
    ...(warning ? { confirmation_warning: warning } : {}),
    confirmation: warning ? `${confirmation}\nWarning: ${warning}` : confirmation,
  };
}

/**
 * Sends a follow-up to the agent that owes the caller in `command.thread`.
 * @param {{request: Function}} client
 * @param {object} session the loaded agent session tuple
 * @param {{thread: string, body: string, actionId: string}} command
 */
export async function sendFollowUp(client, session, command, { log = debugLog } = {}) {
  const started = Date.now();
  const params = { thread: shortId(command.thread) };
  let owedKind = null;
  try {
    const thread = await threadHeader(client, session, command.thread);
    const owed = thread.owed_by;
    if (!owed) throw nobodyOwesYou(thread);
    owedKind = owed.replaced_endpoint_id ? 'replacement' : 'custodian';
    if (owed.root_status !== 'open') throw workClosed(thread, owed);
    const sent = await commitFollowUp(client, session, command, thread, owed, log);
    log({ event: 'agent_follow_up', params, result: { owed_by: owedKind, delegated: Boolean(owed.delegated_to), recipient: shortId(owed.endpoint_id), outcome: 'committed' }, status: 'ok', latency_ms: Date.now() - started });
    return sent;
  } catch (error) {
    log({ event: 'agent_follow_up', params, result: { owed_by: owedKind, code: error?.code ?? 'error' }, status: 'refused', latency_ms: Date.now() - started });
    throw error;
  }
}
