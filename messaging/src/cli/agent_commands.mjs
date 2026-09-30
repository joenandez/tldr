// Intent-facing adapter for routine Tightbeam messaging. It only reads the
// current hook session and composes existing daemon operations; canonical
// message, lifecycle, custody, and delivery truth remain daemon-owned.

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import { resolveSessionId } from './hook_identity.mjs';
import { localTightbeamAction, tightbeamCommandHint, tightbeamRecipeCommand } from './package_context.mjs';
import { sessionPaths } from '../protocol/session_paths.mjs';

export class AgentCommandError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const RAW_FLAGS = new Set(['from', 'sender-endpoint', 'process-generation', 'key', 'conversation', 'target-principal', 'target-endpoint', 'obligation', 'generation', 'idempotency-key']);
const COMMANDS = new Set(['send', 'request', 'reply', 'ack', 'update', 'delegate', 'accept', 'decline', 'complete', 'cancel', 'inbox', 'receive', 'status']);

function usage(message) {
  throw new AgentCommandError('usage_error', message);
}

function takeFlag(args, name, { boolean = false } = {}) {
  const prefix = `--${name}=`;
  const index = args.findIndex((value) => value === `--${name}` || value.startsWith(prefix));
  if (index === -1) return undefined;
  const token = args[index];
  args.splice(index, 1);
  if (token.startsWith(prefix)) return token.slice(prefix.length);
  if (boolean) return true;
  const value = args[index];
  if (value === undefined) usage(`--${name} requires a value`);
  args.splice(index, 1);
  return value;
}

function takeMany(args, name) {
  const values = [];
  for (;;) {
    const value = takeFlag(args, name);
    if (value === undefined) return values;
    values.push(value);
  }
}

function required(args, name) {
  const value = takeFlag(args, name);
  if (!value) usage(`--${name} is required`);
  return value;
}

function requiredNonblank(args, name) {
  const value = required(args, name);
  if (value.trim().length === 0) usage(`--${name} must be nonblank`);
  return value;
}

function resolveBodyInput(args) {
  const body = takeFlag(args, 'body');
  const bodyFile = takeFlag(args, 'body-file');
  if (body !== undefined && bodyFile !== undefined) usage('--body and --body-file cannot be combined');
  if (body !== undefined) {
    if (!body) usage('--body is required');
    return body;
  }
  if (bodyFile === undefined) usage('exactly one of --body or --body-file is required');

  let encoded;
  try {
    if (!fs.statSync(bodyFile).isFile()) usage('--body-file must name a readable file');
    encoded = fs.readFileSync(bodyFile);
  } catch (error) {
    if (error instanceof AgentCommandError) throw error;
    usage('--body-file must name a readable file');
  }

  let decoded;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(encoded);
  } catch {
    usage('--body-file must contain valid UTF-8');
  }
  if (decoded.length === 0) usage('--body-file must not be empty');
  return decoded;
}

function recipient(value, { self = false } = {}) {
  if (value === 'self' && self) return { kind: 'self' };
  if (value === 'user') return { kind: 'user' };
  if (typeof value === 'string' && value.startsWith('agent:') && value.length > 'agent:'.length) return { kind: 'agent', ref: value.slice('agent:'.length) };
  usage(self ? '--to must be self or agent:<stable-ref>' : '--to must be user or agent:<stable-ref>');
}

function commitKey(command, commandArgs, stage) {
  const canonical = JSON.stringify({ command, actionId: commandArgs.actionId, stage, invocation: invocationFingerprint(commandArgs) });
  return `agent:${command}:${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`;
}

function invocationFingerprint(commandArgs) {
  const { actionId: _actionId, waitDeliveryMs: _waitDeliveryMs, ...invocation } = commandArgs;
  return createHash('sha256').update(JSON.stringify(invocation)).digest('hex');
}

function actionId(value) {
  if (typeof value === 'string' && value.length > 0) return value;
  return randomUUID();
}

function actionStoreKey(command) {
  return createHash('sha256').update(`${command.command}:${command.actionId}:${invocationFingerprint(command)}`).digest('hex');
}

function readActionStore(session) {
  if (!session.agent_action_store_path) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(session.agent_action_store_path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.envelopes || typeof parsed.envelopes !== 'object' || Array.isArray(parsed.envelopes)) {
      throw new Error('malformed action store');
    }
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return { envelopes: {} };
    throw new AgentCommandError('action_identity_unavailable', 'the current session action identity store is unreadable; refusing to risk a duplicate send');
  }
}

function writeActionStore(session, store) {
  if (!session.agent_action_store_path) return;
  const directory = path.dirname(session.agent_action_store_path);
  const temporary = `${session.agent_action_store_path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, JSON.stringify(store), { mode: 0o600 });
    fs.renameSync(temporary, session.agent_action_store_path);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Preserve the durable-publication failure below.
    }
    throw new AgentCommandError('action_identity_unavailable', `could not persist the current action identity: ${error.message}`);
  }
}

export function parseAgentCommand(argv, { actionId: suppliedActionId } = {}) {
  const args = [...argv];
  const command = args.shift();
  if (!COMMANDS.has(command)) usage(`unknown agent command: ${command ?? '(missing)'}`);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { command, help: true };
  for (const flag of RAW_FLAGS) {
    if (args.some((token) => token === `--${flag}` || token.startsWith(`--${flag}=`))) usage(`--${flag} is not accepted by tightbeam agent commands`);
  }

  // The installed tool hook supplies its trusted action id through the exact
  // session cache. A direct CLI invocation gets a local UUID later, so an
  // intentional repeat cannot collide with an earlier command.
  const parsed = { command, actionId: typeof suppliedActionId === 'string' && suppliedActionId.length > 0 ? suppliedActionId : null };
  if (command === 'send') {
    parsed.to = recipient(required(args, 'to'));
    parsed.subject = requiredNonblank(args, 'subject');
    parsed.reason = requiredNonblank(args, 'reason');
    parsed.body = resolveBodyInput(args);
    parsed.channels = takeMany(args, 'channel');
    parsed.awaitReply = takeFlag(args, 'await-reply', { boolean: true });
    parsed.noReply = takeFlag(args, 'no-reply', { boolean: true });
    if (parsed.to.kind !== 'user' && parsed.channels.length > 0) usage('--channel is only available for send --to user');
    if (parsed.awaitReply !== undefined && parsed.awaitReply !== true) usage('--await-reply does not take a value');
    if (parsed.noReply !== undefined && parsed.noReply !== true) usage('--no-reply does not take a value');
    if (parsed.awaitReply !== undefined) usage('--await-reply is now the default; omit it or use --no-reply');
    validateChannelSelection(parsed.channels);
  } else if (command === 'request') {
    parsed.to = recipient(required(args, 'to'), { self: true });
    if (parsed.to.kind === 'user') usage('--to must be self or agent:<stable-ref>');
    parsed.subject = requiredNonblank(args, 'subject');
    parsed.reason = requiredNonblank(args, 'reason');
    parsed.body = resolveBodyInput(args);
    parsed.completionMode = required(args, 'completion-mode');
    parsed.notify = takeFlag(args, 'notify');
    parsed.channels = takeMany(args, 'channel');
    if (parsed.notify !== undefined && parsed.notify !== 'user') usage('--notify only accepts user');
    if (parsed.notify && parsed.to.kind !== 'self') usage('--notify user is only available for --to self');
    if (parsed.channels.length > 0 && !parsed.notify) usage('--channel is only available with --notify user');
    if (parsed.notify && parsed.completionMode !== 'delivery_confirmed') usage('--notify user requires --completion-mode delivery_confirmed');
    validateChannelSelection(parsed.channels);
  } else if (command === 'reply') {
    parsed.messageId = required(args, 'message');
    parsed.body = resolveBodyInput(args);
    parsed.channels = takeMany(args, 'channel');
    parsed.noReply = takeFlag(args, 'no-reply', { boolean: true });
    if (parsed.noReply !== undefined && parsed.noReply !== true) usage('--no-reply does not take a value');
  } else if (command === 'ack') {
    parsed.workId = required(args, 'work');
    parsed.body = resolveBodyInput(args);
  } else if (command === 'update' || command === 'complete') {
    parsed.workId = required(args, 'work');
    parsed.body = resolveBodyInput(args);
    if (command === 'complete') {
      parsed.notify = takeFlag(args, 'notify');
      parsed.channels = takeMany(args, 'channel');
      if (parsed.notify !== undefined && parsed.notify !== 'user') usage('--notify only accepts user');
      if (parsed.channels.length > 0 && !parsed.notify) usage('--channel is only available with --notify user');
      if (parsed.channels.length > 0) usage('--channel is selected when opening --notify user work, not when completing it');
    }
  } else if (command === 'delegate') {
    parsed.workId = required(args, 'work');
    parsed.to = recipient(required(args, 'to'));
    if (parsed.to.kind !== 'agent') usage('--to must be agent:<stable-ref>');
    parsed.body = resolveBodyInput(args);
  } else if (command === 'accept' || command === 'decline') {
    parsed.workId = required(args, 'work');
    parsed.body = resolveBodyInput(args);
  } else if (command === 'cancel') {
    parsed.workId = required(args, 'work');
    parsed.reason = required(args, 'reason');
  } else if (command === 'inbox') {
    parsed.unread = Boolean(takeFlag(args, 'unread', { boolean: true }));
  } else if (command === 'receive') {
    parsed.messageId = required(args, 'message');
  } else if (command === 'status') {
    parsed.workId = takeFlag(args, 'work');
    parsed.messageId = takeFlag(args, 'message');
    if (Boolean(parsed.workId) === Boolean(parsed.messageId)) usage('status requires exactly one of --work or --message');
  }
  if (['reply', 'complete', 'status'].includes(command)) {
    const wait = takeFlag(args, 'wait-delivery');
    if (wait !== undefined) {
      if (!/^\d+(?:ms|s)$/.test(wait)) usage('--wait-delivery requires a duration such as 30s (maximum 60s)');
      parsed.waitDeliveryMs = Number.parseInt(wait, 10) * (wait.endsWith('ms') ? 1 : 1000);
      if (parsed.waitDeliveryMs < 1 || parsed.waitDeliveryMs > 60_000) usage('--wait-delivery must be between 1ms and 60s');
    }
  }
  if (args.length > 0) usage(`unknown agent argument: ${args.join(' ')}`);
  return parsed;
}

function validateChannelSelection(channels) {
  if (channels.includes('all') && channels.length !== 1) usage('--channel all cannot be combined with another channel');
}

export function loadAgentSession(stateRoot, { env = process.env } = {}) {
  const sessionId = resolveSessionId({ env });
  if (!sessionId) throw new AgentCommandError('session_unavailable', 'no current Tightbeam session; start a supported runtime session first');
  const paths = sessionPaths(stateRoot, sessionId);
  let cached;
  try {
    cached = JSON.parse(fs.readFileSync(paths.endpoint, 'utf8'));
  } catch {
    throw new AgentCommandError('session_unavailable', 'current session is not registered; run the supported SessionStart hook and retry');
  }
  if (!cached || typeof cached.principal_id !== 'string' || typeof cached.endpoint_id !== 'string' || !Number.isInteger(cached.process_generation)) {
    throw new AgentCommandError('session_unavailable', 'current session identity is incomplete; refresh the supported SessionStart hook and retry');
  }
  let runtimeActionId = null;
  try {
    const value = fs.readFileSync(paths.action, 'utf8').trim();
    if (value.length > 0) runtimeActionId = value;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new AgentCommandError('action_identity_unavailable', 'the current runtime action identity is unreadable; refusing to risk a duplicate send');
  }
  return { ...cached, runtime_action_id: runtimeActionId, agent_action_store_path: `${paths.dir}/agent-actions.json` };
}

async function resolveAgent(client, session, target, { requireEndpoint }) {
  if (target.kind === 'self') return { principal_id: session.principal_id, endpoint_id: session.endpoint_id };
  if (target.kind === 'user') throw new AgentCommandError('usage_error', 'user routes are resolved through configured channels, not a principal lookup');
  return client.request('principal.resolve', {
    authority_name: session.authority_name,
    external_principal_ref: target.ref,
    require_endpoint: requireEndpoint,
  });
}

async function selectedOutboundChannels(client, channels) {
  validateChannelSelection(channels);
  const catalog = await client.request('channel.route.list', { available_only: true, required_capability: 'send' });
  const available = (catalog.routes ?? []).map((route) => route.selector).filter((selector) => typeof selector === 'string' && selector.length > 0);
  const requested = channels.length === 0 || channels.includes('all') ? available : [...new Set(channels)].sort();
  if (requested.length === 0) {
    throw new AgentCommandError('no_outbound_channels', 'no active send-capable channel routes are available');
  }
  const unavailable = requested.find((selector) => !available.includes(selector));
  if (unavailable) {
    throw new AgentCommandError('channel_unavailable', `channel selector "${unavailable}" is unavailable`);
  }
  return requested;
}

async function conversationFor(client, session, targetPrincipalId, command = null) {
  // conversation.create is the canonical conversation writer. The adapter
  // neither stores nor synthesizes a conversation identifier locally.
  const store = command?.command === 'send' || command?.command === 'request' ? readActionStore(session) : null;
  const key = store ? actionStoreKey(command) : null;
  const existing = key ? store.envelopes[key] : null;
  if (existing?.target_principal_id === targetPrincipalId && typeof existing.conversation_id === 'string' && existing.conversation_id.length > 0) {
    return { conversation_id: existing.conversation_id };
  }
  const conversation = await client.request('conversation.create', {
    participant_principal_ids: [...new Set([session.principal_id, targetPrincipalId])],
    metadata: { subject: command.subject, reason: command.reason },
  });
  if (key) {
    store.envelopes[key] = { target_principal_id: targetPrincipalId, conversation_id: conversation.conversation_id };
    writeActionStore(session, store);
  }
  return conversation;
}

function baseNone(session) {
  return { type: 'none', sender_endpoint_id: session.endpoint_id, process_generation: session.process_generation };
}

function intentResult(result) {
  return { outcome: 'committed', message_id: result.message_id, conversation_id: result.conversation_id };
}

function shortThreadId(conversationId) {
  const unprefixed = String(conversationId).replace(/^[^_]+_/, '');
  return unprefixed.length <= 8 ? unprefixed : unprefixed.slice(0, 8);
}

function confirmation(verb, { subject, conversationId, replyPolicy }) {
  const parts = [verb];
  if (typeof subject === 'string' && subject.trim().length > 0) parts.push(subject);
  parts.push(shortThreadId(conversationId), replyPolicy);
  return parts.join(' · ');
}

function correspondenceResult(result, { subject, noReply, workId = null, verb = 'Sent' }) {
  const replyPolicy = result.await_reply || (result.effect && result.effect.type !== 'none') || !noReply ? 'reply required' : 'no reply required';
  const response = {
    ...intentResult(result),
    reply_policy: replyPolicy,
    subject,
    thread_short_id: shortThreadId(result.conversation_id),
    confirmation: confirmation(verb, { subject, conversationId: result.conversation_id, replyPolicy }),
  };
  if (workId) response.work_id = workId;
  if (!noReply && Array.isArray(result.reply_wait_ids) && result.reply_wait_ids.length > 0) response.reply_wait_id = result.reply_wait_ids[0];
  return response;
}

function deliveryOutcome(deliveries) {
  const states = new Set(deliveries.map((delivery) => delivery.state));
  if (states.size === 0) return 'committed';
  if (states.size === 1) return states.has('delivered') ? 'delivered' : [...states][0];
  return 'partial';
}

function staleGenerationConflict(error) {
  if (error?.code !== 'obligation_conflict') return false;
  if (error?.details?.reason === 'process_generation_stale') return true;
  return /process generation|generation.*stale|stale.*generation/i.test(String(error?.message ?? ''));
}

function unreadAdmissionError(error) {
  if (error?.code !== 'blocked_unread') return null;
  const subject = typeof error.details?.subject === 'string' && error.details.subject.length > 0 ? error.details.subject : 'this thread';
  const sender = typeof error.details?.sender_display_name === 'string' && error.details.sender_display_name.length > 0 ? error.details.sender_display_name : 'the sender';
  const action = typeof error.details?.safe_action === 'string' && error.details.safe_action.length > 0 ? localTightbeamAction(error.details.safe_action) : `${tightbeamRecipeCommand()} agent inbox --unread`;
  return new AgentCommandError('blocked_unread', `Send paused · unread message on “${subject}” from ${sender}. Read it before replying.\nNext: ${action}`);
}

function consumeInboundWarning(session, command) {
  if (!['send', 'request', 'reply', 'ack', 'update', 'delegate', 'accept', 'decline', 'complete', 'cancel', 'inbox'].includes(command.command) || !session.agent_action_store_path) return null;
  const file = path.join(path.dirname(session.agent_action_store_path), 'unread-warning.json');
  try {
    fs.unlinkSync(file);
    return `An inbound message is still unread because injection previously failed. Run ${tightbeamRecipeCommand()} agent inbox --unread before sending.`;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return null;
  }
}

function workNodes(chain) {
  return [
    ...(chain.attempts ?? []).map((node) => ({ ...node, role: 'attempt' })),
    ...(chain.delegations ?? []).map((node) => ({ ...node, role: 'delegation' })),
  ];
}

function selectCustodiedWork(chain, session, requestedWorkId) {
  const nodes = workNodes(chain);
  const named = nodes.find((node) => node.obligation_id === requestedWorkId);
  const matches = named
    ? [named]
    : nodes.filter((node) => node.status === 'open' && node.custodian_endpoint_id === session.endpoint_id);
  if (matches.length !== 1 || matches[0].status !== 'open' || matches[0].custodian_endpoint_id !== session.endpoint_id) {
    // lifecycle.view does not grant an adapter the missing action intent:
    // retry refuses a healthy owner while switch deliberately displaces one.
    // Choosing between them on behalf of an agent would invent recovery
    // authority, so this presentation layer refuses rather than guessing.
    throw new AgentCommandError(
      'recovery_authority_required',
      'this work is not in the current session’s exact custody; an explicit recovery retry or switch decision is required before updating it',
    );
  }
  return matches[0];
}

function selectOfferedDelegation(chain, session, requestedWorkId) {
  const delegation = (chain.delegations ?? []).find((node) => node.obligation_id === requestedWorkId);
  if (
    !delegation
    || delegation.status !== 'open'
    || delegation.custodian_endpoint_id !== null
    || delegation.accountable_principal_id !== session.principal_id
    || delegation.watch_state !== 'awaiting_acceptance'
  ) {
    throw new AgentCommandError('handoff_unavailable', 'this work is not an offered delegation awaiting acceptance by the current session');
  }
  return delegation;
}

function handoffDeadline(session, command) {
  const store = readActionStore(session);
  if (!store) return new Date(Date.now() + 5 * 60_000).toISOString();
  const key = actionStoreKey(command);
  const existing = store.envelopes[key];
  if (typeof existing?.acceptance_deadline_at === 'string' && !Number.isNaN(Date.parse(existing.acceptance_deadline_at))) {
    return existing.acceptance_deadline_at;
  }
  const acceptanceDeadlineAt = new Date(Date.now() + 5 * 60_000).toISOString();
  store.envelopes[key] = { acceptance_deadline_at: acceptanceDeadlineAt };
  writeActionStore(session, store);
  return acceptanceDeadlineAt;
}

function shortSessionId(session) {
  return shortThreadId(session.session_id ?? session.provider_session_id ?? session.endpoint_id);
}

async function workChain(client, workId) {
  const view = await client.request('lifecycle.view', { root_obligation_id: workId });
  if (Array.isArray(view.chains) && view.chains.length === 1) return view.chains[0];
  const all = await client.request('lifecycle.view', {});
  const chain = (all.chains ?? []).find((candidate) => candidate.root_obligation_id === workId || workNodes(candidate).some((node) => node.obligation_id === workId));
  if (!chain) throw new AgentCommandError('work_not_found', 'no visible work matches that handle');
  return chain;
}

async function runWorkCommand(client, session, command, chain, operation = command.command) {
  const node = selectCustodiedWork(chain, session, command.workId);
  const terminalOriginMessageId = (operation === 'complete' || operation === 'cancel') && typeof chain.user_origin_message_id === 'string'
    ? chain.user_origin_message_id
    : null;
  const notificationChannels =
    operation === 'complete' && chain.notification?.channel_selectors
      ? chain.notification.channel_selectors
      : terminalOriginMessageId
        ? ['origin']
        : null;
  if (operation === 'complete' && command.notify === 'user' && !chain.notification?.channel_selectors) {
    throw new AgentCommandError('notification_not_registered', 'this work was not opened with --notify user');
  }
  const effect =
    operation === 'update'
      ? { type: 'update', obligation_id: node.obligation_id, generation: node.generation, sender_endpoint_id: session.endpoint_id, process_generation: session.process_generation }
      : operation === 'complete'
        ? { type: 'close.fulfilled', obligation_id: node.role === 'delegation' ? node.obligation_id : chain.root_obligation_id, generation: node.role === 'delegation' ? node.generation : chain.generation, sender_endpoint_id: session.endpoint_id, process_generation: session.process_generation, outcome: 'success' }
        : { type: 'close.cancelled', obligation_id: chain.root_obligation_id, generation: chain.generation, reason: command.reason, source: 'agent', sender_endpoint_id: session.endpoint_id, process_generation: session.process_generation };
  const result = await client.request('message.commit', {
    sender_principal_id: session.principal_id,
    conversation_id: chain.conversation_id,
    ...(terminalOriginMessageId ? { in_reply_to_message_id: terminalOriginMessageId } : {}),
    body: command.body ?? command.reason,
    idempotency_key: commitKey(command.command, command, 'message'),
    ...(notificationChannels ? { channel_selectors: notificationChannels } : {}),
    obligation_effect: effect,
  });
  if (notificationChannels) {
    if (command.waitDeliveryMs) return correspondenceResult(result, { subject: chain.subject ?? null, noReply: false, workId: command.workId });
    const deliveries = await client.request('message.delivery.list', { message_id: result.message_id });
    const channelDeliveries = deliveries.channel_deliveries ?? [];
    return {
      ...correspondenceResult(result, { subject: chain.subject ?? null, noReply: false, workId: command.workId, verb: operation === 'complete' ? 'Completed' : operation === 'cancel' ? 'Cancelled' : 'Updated' }),
      outcome: deliveryOutcome(channelDeliveries),
      channel_deliveries: channelDeliveries,
    };
  }
  return correspondenceResult(result, {
    subject: chain.subject ?? null,
    noReply: false,
    workId: command.workId,
    verb: operation === 'complete' ? 'Completed' : operation === 'cancel' ? 'Cancelled' : 'Updated',
  });
}

async function runAgentCommandOnce(client, session, command) {
  if (command.command === 'send') {
    if (command.to.kind === 'user') {
      const selectors = await selectedOutboundChannels(client, command.channels);
      const conversation = await conversationFor(client, session, session.principal_id, command);
      const result = await client.request('message.commit', {
        sender_principal_id: session.principal_id,
        conversation_id: conversation.conversation_id,
        body: command.body,
        idempotency_key: commitKey('send', command, 'message'),
        await_reply: !command.noReply,
        channel_selectors: selectors,
        obligation_effect: baseNone(session),
      });
      const deliveries = await client.request('message.delivery.list', { message_id: result.message_id });
      const channelDeliveries = deliveries.channel_deliveries ?? [];
      return {
        ...correspondenceResult(result, { subject: command.subject, noReply: command.noReply }),
        outcome: deliveryOutcome(channelDeliveries),
        channel_deliveries: channelDeliveries,
      };
    }
    const target = await resolveAgent(client, session, command.to, { requireEndpoint: !command.noReply });
    const conversation = await conversationFor(client, session, target.principal_id, command);
    const result = await client.request('message.commit', {
      sender_principal_id: session.principal_id,
      conversation_id: conversation.conversation_id,
      body: command.body,
      idempotency_key: commitKey('send', command, 'message'),
      obligation_effect: command.noReply
        ? baseNone(session)
        : {
            type: 'open',
            target_principal_id: target.principal_id,
            target_endpoint_id: target.endpoint_id,
            completion_mode: 'message_committed',
            sender_endpoint_id: session.endpoint_id,
            process_generation: session.process_generation,
          },
    });
    return correspondenceResult(result, { subject: command.subject, noReply: command.noReply, workId: command.noReply ? null : result.root_id });
  }
  if (command.command === 'request') {
    const notificationChannels = command.notify === 'user' ? await selectedOutboundChannels(client, command.channels) : null;
    const target = await resolveAgent(client, session, command.to, { requireEndpoint: true });
    const conversation = await conversationFor(client, session, target.principal_id, command);
    const result = await client.request('message.commit', {
      sender_principal_id: session.principal_id,
      conversation_id: conversation.conversation_id,
      body: command.body,
      idempotency_key: commitKey('request', command, 'open'),
      ...(notificationChannels ? { metadata: { tightbeam_agent: { notification_channels: notificationChannels } } } : {}),
      obligation_effect: {
        type: 'open',
        target_principal_id: target.principal_id,
        target_endpoint_id: target.endpoint_id,
        completion_mode: notificationChannels ? 'delivery_confirmed' : command.completionMode,
        sender_endpoint_id: session.endpoint_id,
        process_generation: session.process_generation,
      },
    });
    return { ...intentResult(result), work_id: result.root_id };
  }
  if (command.command === 'reply') {
    const message = await client.request('message.read', { message_id: command.messageId, principal_id: session.principal_id, endpoint_id: session.endpoint_id });
    if (message.origin_channel_selector && message.root_obligation_id) {
      const chain = await workChain(client, message.root_obligation_id);
      if (chain.conversation_id !== message.conversation_id || chain.user_origin_message_id !== command.messageId) {
        throw new AgentCommandError('reply_target_mismatch', 'this message is not the canonical user request for this work; reply to its original message or use agent complete --work with the notification work ID');
      }
      if (command.noReply || command.channels.some((selector) => selector !== 'origin')) {
        throw new AgentCommandError('reply_policy_unavailable', `Reply to this user request without --no-reply or --channel. For a progress acknowledgement use agent ack --work ${chain.root_obligation_id} --body "<progress>"; for the final result use agent complete --work ${chain.root_obligation_id} --body "<result>".`);
      }
      return runWorkCommand(client, session, { ...command, workId: chain.root_obligation_id }, chain, 'complete');
    }
    const selectors = command.channels.length > 0 ? command.channels : message.origin_channel_selector ? ['origin'] : [];
    let effect;
    let awaitReply = false;
    let workId = null;
    if (command.noReply) {
      effect = baseNone(session);
    } else if (selectors.length > 0) {
      effect = baseNone(session);
      awaitReply = true;
    } else if (typeof message.root_obligation_id === 'string' && message.root_obligation_id.length > 0) {
      const chain = await workChain(client, message.root_obligation_id);
      if (chain.conversation_id !== message.conversation_id) {
        throw new AgentCommandError('work_not_found', 'the message work does not belong to its canonical conversation');
      }
      const attempt = selectCustodiedWork(chain, session, message.root_obligation_id);
      effect = { type: 'update', obligation_id: attempt.obligation_id, generation: attempt.generation, sender_endpoint_id: session.endpoint_id, process_generation: session.process_generation };
      workId = chain.root_obligation_id;
    } else {
      throw new AgentCommandError('reply_policy_unavailable', 'this agent reply has no canonical open work; use --no-reply only when an explicit informational reply is intended');
    }
    const result = await client.request('message.commit', {
      sender_principal_id: session.principal_id,
      conversation_id: message.conversation_id,
      in_reply_to_message_id: command.messageId,
      body: command.body,
      idempotency_key: commitKey('reply', command, 'message'),
      channel_selectors: selectors,
      ...(awaitReply ? { await_reply: true } : {}),
      obligation_effect: effect,
    });
    if (selectors.length > 0) {
      if (command.waitDeliveryMs) return correspondenceResult(result, { subject: message.conversation_subject ?? null, noReply: command.noReply, workId });
      const deliveries = await client.request('message.delivery.list', { message_id: result.message_id });
      const channelDeliveries = deliveries.channel_deliveries ?? [];
      return {
        ...correspondenceResult(result, { subject: message.conversation_subject ?? null, noReply: command.noReply, workId }),
        outcome: deliveryOutcome(channelDeliveries),
        channel_deliveries: channelDeliveries,
      };
    }
    return correspondenceResult(result, { subject: message.conversation_subject ?? null, noReply: command.noReply, workId });
  }
  if (command.command === 'receive') {
    if (typeof session.session_id !== 'string' || session.session_id.length === 0) {
      throw new AgentCommandError('session_unavailable', 'the current Tightbeam session lacks provider session identity; refresh the supported SessionStart hook before receiving');
    }
    const result = await client.request('message.receive', {
      message_id: command.messageId,
      endpoint_id: session.endpoint_id,
      process_generation: session.process_generation,
      provider_session_id: session.session_id,
    });
    return {
      outcome: 'committed',
      ...result,
      acknowledge_command: `${tightbeamRecipeCommand()} ack ${result.message_id} --endpoint ${session.endpoint_id} --generation ${session.process_generation}`,
    };
  }
  if (command.command === 'ack') {
    const chain = await workChain(client, command.workId);
    if (
      chain.status === 'done'
      || typeof chain.ack_due_at !== 'string'
      || chain.ack_due_at.length === 0
      || (chain.ack_accepted_at !== null && chain.ack_accepted_at !== undefined)
      || typeof chain.ack_message_id !== 'string'
      || chain.ack_message_id.length === 0
    ) {
      throw new AgentCommandError('ack_unavailable', 'this work has no pending user acknowledgement');
    }
    const attempt = selectCustodiedWork(chain, session, command.workId);
    const result = await client.request('message.commit', {
      sender_principal_id: session.principal_id,
      conversation_id: chain.conversation_id,
      in_reply_to_message_id: chain.ack_message_id,
      body: command.body,
      idempotency_key: commitKey('ack', command, 'message'),
      channel_selectors: ['origin'],
      obligation_effect: {
        type: 'update', obligation_id: attempt.obligation_id, generation: attempt.generation,
        sender_endpoint_id: session.endpoint_id, process_generation: session.process_generation, acknowledgement: true,
      },
    });
    const deliveries = await client.request('message.delivery.list', { message_id: result.message_id });
    const channelDeliveries = deliveries.channel_deliveries ?? [];
    return {
      ...intentResult(result),
      work_id: chain.root_obligation_id,
      outcome: deliveryOutcome(channelDeliveries),
      channel_deliveries: channelDeliveries,
      confirmation: 'Acknowledged · final response still required',
    };
  }
  if (command.command === 'delegate') {
    const chain = await workChain(client, command.workId);
    const node = selectCustodiedWork(chain, session, command.workId);
    const target = await resolveAgent(client, session, command.to, { requireEndpoint: false });
    const result = await client.request('message.commit', {
      sender_principal_id: session.principal_id,
      conversation_id: chain.conversation_id,
      body: command.body,
      idempotency_key: commitKey('delegate', command, 'message'),
      obligation_effect: {
        type: 'handoff.offer', obligation_id: node.obligation_id, generation: node.generation,
        sender_endpoint_id: session.endpoint_id, process_generation: session.process_generation,
        target_principal_id: target.principal_id, registration_key: commitKey('delegate', command, 'registration'),
        acceptance_deadline_at: handoffDeadline(session, command),
      },
    });
    return {
      ...correspondenceResult(result, { subject: chain.subject ?? null, noReply: false, workId: chain.root_obligation_id, verb: 'Delegated' }),
      delegation_id: result.delegation_id,
      watch_id: result.watch_id,
      delegate_label: `agent:${command.to.ref}`,
      return_session: shortSessionId(session),
      confirmation: `Delegated · agent:${command.to.ref} · return to ${shortSessionId(session)} · final response still required`,
    };
  }
  if (command.command === 'accept' || command.command === 'decline') {
    const chain = await workChain(client, command.workId);
    const delegation = selectOfferedDelegation(chain, session, command.workId);
    const result = await client.request('message.commit', {
      sender_principal_id: session.principal_id,
      conversation_id: chain.conversation_id,
      body: command.body,
      idempotency_key: commitKey(command.command, command, 'message'),
      obligation_effect: {
        type: `handoff.${command.command}`, obligation_id: delegation.obligation_id, generation: delegation.generation,
        sender_endpoint_id: session.endpoint_id, process_generation: session.process_generation,
      },
    });
    return correspondenceResult(result, { subject: chain.subject ?? null, noReply: false, workId: chain.root_obligation_id, verb: command.command === 'accept' ? 'Accepted' : 'Declined' });
  }
  if (command.command === 'update' || command.command === 'complete' || command.command === 'cancel') {
    return runWorkCommand(client, session, command, await workChain(client, command.workId));
  }
  if (command.command === 'inbox') {
    const result = await client.request('inbox.list', { principal_id: session.principal_id, endpoint_id: session.endpoint_id, unread_only: command.unread });
    return {
      outcome: 'committed',
      messages: (result.messages ?? []).map(({ body: _body, ...message }) => message),
    };
  }
  if (command.command === 'status') {
    if (command.waitDeliveryMs) return { outcome: 'committed', ...(command.workId ? { work_id: command.workId } : { message_id: command.messageId }) };
    if (command.workId) {
      const chain = await workChain(client, command.workId);
      const stagedResolution = chain.staged_resolution ?? null;
      const notificationMessageId = chain.notification?.message_id ?? null;
      const messageId = stagedResolution?.message_id ?? notificationMessageId;
      if (!messageId) {
        return { outcome: chain.status, work_id: chain.root_obligation_id, staged_resolution: stagedResolution, notification: chain.notification ?? null };
      }
      const deliveries = await client.request('message.delivery.list', { message_id: messageId });
      const channelDeliveries = deliveries.channel_deliveries ?? [];
      return {
        outcome: deliveryOutcome(channelDeliveries),
        work_id: chain.root_obligation_id,
        staged_resolution: stagedResolution,
        ...(chain.notification ? { notification: chain.notification } : {}),
        channel_deliveries: channelDeliveries,
      };
    }
    const deliveries = await client.request('message.delivery.list', { message_id: command.messageId });
    const channelDeliveries = deliveries.channel_deliveries ?? [];
    return { outcome: deliveryOutcome(channelDeliveries), message_id: command.messageId, channel_deliveries: channelDeliveries };
  }
  usage(`unknown agent command: ${command.command}`);
}

/**
 * The session cache is only a hint. A process-generation conflict is the one
 * daemon verdict that proves it stale, so callers may refresh it once through
 * the existing idempotent SessionStart registration path and replay the same
 * logical commit. Other conflicts remain canonical daemon errors.
 */
export async function runAgentCommand(client, session, command, { refreshSession } = {}) {
  const boundCommand = command.actionId ? command : { ...command, actionId: actionId(session.runtime_action_id) };
  let result;
  try {
    result = await runAgentCommandOnce(client, session, boundCommand);
  } catch (error) {
    const unread = unreadAdmissionError(error);
    if (unread) throw unread;
    if (error?.code === 'obligation_conflict' && error.details?.reason === 'open_work_requires_effect') {
      throw new AgentCommandError(error.code, `${error.message}. Use agent complete --work ${error.details.work_id ?? "<work-id from notification>"} --body "<result>" for a final reply, or agent update --work ${error.details.work_id ?? "<work-id from notification>"} --body "<progress>" to continue work.`);
    }
    if (error?.code === 'permission_denied' && command.command === 'status' && command.messageId) {
      throw new AgentCommandError(error.code, 'Delivery status is available for messages sent by this application. Use the outbound message_id returned by reply/complete, or agent status --work <work-id>; an inbound message ID is not a delivery receipt.');
    }
    if (!refreshSession || !staleGenerationConflict(error)) throw error;
    const refreshed = await refreshSession();
    result = await runAgentCommandOnce(client, refreshed, boundCommand);
  }
  // Waiting only reads the committed outbound message. A timeout or read error
  // must never re-enter the send/complete retry path.
  if (command.waitDeliveryMs) result = await waitForDelivery(client, result, command.waitDeliveryMs);
  result = deliveryConfirmation(result, command);
  const warning = consumeInboundWarning(session, boundCommand);
  return warning ? { ...result, warning } : result;
}

function deliveryConfirmation(result, command) {
  if (['ack', 'send', 'update'].includes(command.command)) return result;
  if ((!Array.isArray(result.channel_deliveries) && !command.waitDeliveryMs) || (!result.confirmation && !command.waitDeliveryMs)) return result;
  const delivered = result.outcome === 'delivered';
  const failed = result.channel_deliveries?.some((delivery) => ['failed', 'cancelled'].includes(delivery.state));
  const unavailable = result.delivery_check_error === 'permission_denied';
  const noRoutes = result.channel_deliveries?.length === 0;
  const label = delivered ? 'Delivery confirmed'
    : failed ? 'Delivery failed'
    : unavailable ? 'Delivery status unavailable'
    : noRoutes ? 'Message committed; no channel delivery to confirm'
    : command.command === 'status' ? 'Delivery not confirmed'
    : 'Reply queued; delivery not yet confirmed';
  const target = result.message_id ? `--message ${result.message_id}` : `--work ${result.work_id}`;
  return {
    ...result,
    confirmation: label,
    ...(!delivered ? {
      ...(!failed && !unavailable && !noRoutes ? { next_action: `${tightbeamCommandHint()} agent status ${target} --wait-delivery 30s` } : {}),
      guidance: result.guidance ?? (failed ? 'Report the delivery failure; do not resend automatically.' : 'Check this existing reply; do not resend it.'),
    } : {}),
  };
}

async function waitForDelivery(client, initial, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  let result = initial;
  let delayMs = 250;
  const read = async (op, payload) => {
    let timer;
    try {
      return await Promise.race([
        client.request(op, payload),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new AgentCommandError('delivery_wait_timeout', 'Delivery wait expired')), Math.max(0, deadline - performance.now())); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  try {
    // A status --work invocation can already be terminal with no staged row.
    if (!result.message_id && result.work_id) {
      const chain = await workChain({ request: read }, result.work_id);
      result = { ...result, work_id: chain.root_obligation_id, work_status: chain.status, message_id: chain.staged_resolution?.message_id ?? chain.notification?.message_id ?? chain.resolution?.message_id };
    }
    if (!result.message_id) return { ...result, delivery_wait: 'unavailable' };
    for (;;) {
      const routes = result.channel_deliveries;
      if (routes?.length && routes.every((delivery) => delivery.state === 'delivered')) {
        result = { ...result, delivery_wait: 'delivered' };
        if (result.work_id) {
          const view = await read('lifecycle.view', { root_obligation_id: result.work_id });
          result.work_status = view.chains?.find((entry) => entry.root_obligation_id === result.work_id)?.status;
        }
        return result;
      }
      if (routes?.some((delivery) => ['failed', 'cancelled'].includes(delivery.state))) return { ...result, delivery_wait: 'failed' };
      if (routes && routes.length === 0) return { ...result, delivery_wait: 'unavailable' };
      const remaining = deadline - performance.now();
      if (remaining <= 0) return { ...result, delivery_wait: 'timed_out' };
      if (routes) await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, remaining)));
      if (performance.now() >= deadline) return { ...result, delivery_wait: 'timed_out' };
      const deliveries = await read('message.delivery.list', { message_id: result.message_id });
      result = { ...result, outcome: deliveryOutcome(deliveries.channel_deliveries ?? []), channel_deliveries: deliveries.channel_deliveries ?? [] };
      delayMs = Math.min(delayMs * 2, 2000);
    }
  } catch (error) {
    if (error?.code === 'permission_denied') result = { ...result, guidance: 'Delivery status requires the outbound message_id returned by reply/complete, or the notification work ID. Do not use the inbound message ID.' };
    return { ...result, delivery_wait: error?.code === 'delivery_wait_timeout' ? 'timed_out' : 'unavailable', ...(error?.code ? { delivery_check_error: error.code } : {}) };
  }
}
