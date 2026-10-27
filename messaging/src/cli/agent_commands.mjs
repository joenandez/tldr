// Intent-facing adapter for routine Tightbeam messaging. It only reads the
// current hook session and composes existing daemon operations; canonical
// message, lifecycle, custody, and delivery truth remain daemon-owned.

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import { confirmationWarning, formatAddress, parseAgentAddress, resolveAgentAddress, routedRecipient } from './agent_address.mjs';
import { sendFollowUp } from './agent_follow_up.mjs';
import { deriveSessionState, listAgentSessions, SESSION_LIST_LIMIT, SESSION_STATES, sessionHandleLookup, sessionHandlesFor } from './agent_sessions.mjs';
import { launchFailureNotice, listAgentThreads, readAgentThread } from './agent_threads.mjs';
import { settleNewAgent } from './new_agent.mjs';
import { resolveAgentIdentity } from './hook_identity.mjs';
import { mutateActionStore } from './agent_action_store.mjs';
import { LEGACY_RUNTIME_ALIASES as BUILTIN_RUNTIME_ALIASES } from '../runtimes/builtins.mjs';
import { localTightbeamAction, offerActionCommands, tightbeamCommandHint, tightbeamRecipeCommand, workActionCommands } from './package_context.mjs';
import { sessionPaths } from '../protocol/session_paths.mjs';
import { deliveryStepFor } from '../protocol/delivery_step.mjs';
import { routeOpenTo } from '../protocol/session_env.mjs';
import { parseWaitTimeout, readActionStore, waitForAgent } from './agent_wait.mjs';

export class AgentCommandError extends Error {
  constructor(code, message, { details, next_action: nextAction } = {}) {
    super(message);
    this.code = code;
    if (details !== undefined) this.details = details;
    if (nextAction !== undefined) this.next_action = nextAction;
  }
}

const RAW_FLAGS = new Set(['from', 'sender-endpoint', 'process-generation', 'key', 'conversation', 'target-principal', 'target-endpoint', 'obligation', 'generation', 'idempotency-key']);
const COMMANDS = new Set(['send', 'request', 'reply', 'ack', 'update', 'delegate', 'accept', 'decline', 'complete', 'cancel', 'inbox', 'receive', 'status', 'sessions', 'threads', 'thread', 'wait']);

/** The help that explains a usage error: the verb's own when it is a known agent verb. */
function agentHelpCommand(verb) {
  return `${tightbeamRecipeCommand()} agent ${COMMANDS.has(verb) ? `${verb} ` : ''}--help`;
}

function usage(message, verb) {
  throw new AgentCommandError('usage_error', message, { next_action: agentHelpCommand(verb) });
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

const AGENT_ADDRESSES = 'session:<id>, agent:<runtime>:<cwd>, or new:<runtime>:<cwd>';

function recipient(value, { self = false } = {}) {
  if (value === 'self' && self) return { kind: 'self' };
  if (value === 'user') return { kind: 'user' };
  const address = parseAgentAddress(value);
  if (address) return address;
  usage(`--to must be ${self ? 'self' : 'user'}, ${AGENT_ADDRESSES}`);
}

export function commitKey(command, commandArgs, stage) {
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

export function bindAgentCommand(session, command) {
  return command.actionId ? command : { ...command, actionId: actionId(session.runtime_action_id) };
}

function actionStoreKey(command) {
  return createHash('sha256').update(`${command.command}:${command.actionId}:${invocationFingerprint(command)}`).digest('hex');
}

export function parseAgentCommand(argv, options = {}) {
  try {
    return parseAgentArguments(argv, options);
  } catch (error) {
    // Every parse-time usage error points at the help for the verb typed.
    if (error instanceof AgentCommandError && error.code === 'usage_error') error.next_action = agentHelpCommand(argv[0]);
    throw error;
  }
}

function parseAgentArguments(argv, { actionId: suppliedActionId } = {}) {
  const args = [...argv];
  const command = args.shift();
  if (!COMMANDS.has(command)) usage(`unknown agent command: ${command ?? '(missing)'}`);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { command, help: true };
  for (const flag of RAW_FLAGS) {
    if (args.some((token) => token === `--${flag}` || token.startsWith(`--${flag}=`))) usage(`--${flag} is not accepted by tightbeam agent commands`);
  }
  const parsed = { command, actionId: typeof suppliedActionId === 'string' && suppliedActionId.length > 0 ? suppliedActionId : null };
  if (command === 'send' && args.some((token) => token === '--thread' || token.startsWith('--thread='))) {
    parseFollowUp(args, parsed);
  } else if (command === 'send') {
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
    if (parsed.to.kind === 'user') usage(`--to must be self, ${AGENT_ADDRESSES}`);
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
    if (parsed.to.kind === 'user') usage(`--to must be ${AGENT_ADDRESSES}`);
    parsed.body = resolveBodyInput(args);
  } else if (command === 'accept' || command === 'decline') {
    parsed.workId = required(args, 'work');
    parsed.body = resolveBodyInput(args);
  } else if (command === 'cancel') {
    parsed.workId = required(args, 'work');
    parsed.reason = required(args, 'reason');
  } else if (command === 'inbox') {
    parsed.unread = Boolean(takeFlag(args, 'unread', { boolean: true }));
  } else if (command === 'sessions') {
    parsed.here = Boolean(takeFlag(args, 'here', { boolean: true }));
    parsed.cwd = takeFlag(args, 'cwd') ?? null;
    parsed.runtime = takeFlag(args, 'runtime') ?? null;
    parsed.state = takeFlag(args, 'state') ?? null;
    parsed.all = Boolean(takeFlag(args, 'all', { boolean: true }));
    if (parsed.here && parsed.cwd !== null) usage('--here and --cwd cannot be combined');
    if (parsed.state !== null && !SESSION_STATES.includes(parsed.state)) usage(`--state must be one of ${SESSION_STATES.join(', ')}`);
  } else if (command === 'threads') {
    parsed.all = Boolean(takeFlag(args, 'all', { boolean: true }));
    parsed.waitingOn = takeFlag(args, 'waiting-on') ?? null;
    if (parsed.waitingOn !== null && !['me', 'them'].includes(parsed.waitingOn)) usage('--waiting-on must be me or them');
  } else if (command === 'thread') {
    parsed.thread = required(args, 'thread');
    const limit = takeFlag(args, 'limit');
    parsed.limit = limit === undefined ? null : Number(limit);
    if (limit !== undefined && (!/^\d+$/.test(limit) || parsed.limit < 1 || parsed.limit > 1000)) usage('--limit must be a whole number from 1 to 1000');
    parsed.since = takeFlag(args, 'since') ?? null;
    if (parsed.since !== null && Number.isNaN(Date.parse(parsed.since))) usage('--since must be an ISO-8601 time such as 2026-10-07T12:00:00Z');
  } else if (command === 'receive') {
    parsed.messageId = required(args, 'message');
  } else if (command === 'wait') {
    try {
      parsed.timeoutMs = parseWaitTimeout(takeFlag(args, 'timeout'));
    } catch (error) {
      usage(error.message, command);
    }
  } else if (command === 'status') {
    parsed.workId = takeFlag(args, 'work');
    parsed.messageId = takeFlag(args, 'message');
    if (Boolean(parsed.workId) === Boolean(parsed.messageId)) usage('status requires exactly one of --work or --message');
  }
  if (['send', 'reply', 'complete', 'status'].includes(command)) {
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

// `send --thread`: the thread names the recipient, subject, and reply policy.
const NEW_THREAD_FLAGS = ['to', 'subject', 'reason', 'channel', 'no-reply', 'await-reply'];

function parseFollowUp(args, parsed) {
  parsed.thread = required(args, 'thread');
  const conflicting = NEW_THREAD_FLAGS.find((flag) => args.some((token) => token === `--${flag}` || token.startsWith(`--${flag}=`)));
  if (conflicting) usage(`--thread cannot be combined with --${conflicting}; a follow-up goes to the agent that owes you in that thread`);
  parsed.body = resolveBodyInput(args);
}

function validateChannelSelection(channels) {
  if (channels.includes('all') && channels.length !== 1) usage('--channel all cannot be combined with another channel');
}

/**
 * The current session's identity for an agent command: which provider
 * session this process acts for and, when it can be told, which runtime.
 * Refusals are named agent errors so they surface before any daemon I/O.
 */
export function resolveAgentSessionIdentity({ env = process.env, registry, parentProcessId, execFileSync, log } = {}) {
  try {
    return resolveAgentIdentity({ env, registry, parentProcessId, execFileSync, log });
  } catch (error) {
    if (error?.code === 'session_identity_ambiguous') {
      throw new AgentCommandError('session_identity_ambiguous', error.message, {
        next_action: 'Rerun the command with TIGHTBEAM_RUNTIME=<claude-code|codex> set to the runtime that is running it.',
      });
    }
    if (error?.code === 'unknown_runtime') throw new AgentCommandError('unknown_runtime', error.message);
    throw error;
  }
}

export function loadAgentSession(stateRoot, { env = process.env, registry, parentProcessId, execFileSync, log, identity: resolved } = {}) {
  const identity = resolved ?? resolveAgentSessionIdentity({ env, registry, parentProcessId, execFileSync, log });
  const sessionId = identity.sessionId;
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
  const cachedRuntime = typeof cached.runtime === 'string' ? (BUILTIN_RUNTIME_ALIASES[cached.runtime] ?? cached.runtime) : null;
  // The runtime is only compared when it was decided (pin or ancestry): a
  // manifest runtime may name its session through a builtin's variable.
  const runtimeDecided = identity.source === 'pin' || identity.source === 'ancestry';
  if ((typeof cached.session_id === 'string' && cached.session_id !== sessionId) || (runtimeDecided && cachedRuntime && cachedRuntime !== identity.runtime)) {
    throw new AgentCommandError('session_identity_mismatch', `the registered session record does not match this ${identity.runtime ?? 'runtime'} session; refusing to act as another agent`, {
      details: { session_id: sessionId, runtime: identity.runtime, registered_session_id: cached.session_id ?? null, registered_runtime: cached.runtime ?? null },
      next_action: 'Restart this agent session so its SessionStart hook re-registers it, or set TIGHTBEAM_RUNTIME to the runtime running this command.',
    });
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

// A `new:` placeholder is remembered in this command's action envelope, so a
// replay of the same command (same action id) reuses it instead of
// registering a second one that nothing would ever launch.
function newAgentReplay(session, command) {
  const store = readActionStore(session);
  if (!store) return null;
  const key = actionStoreKey(command);
  return {
    recall: () => store.envelopes[key]?.new_agent ?? null,
    remember: (placeholder) => mutateActionStore(session, (current) => {
      current.envelopes[key] = { ...current.envelopes[key], new_agent: placeholder };
    }),
  };
}

async function resolveAgent(client, session, target, { verb, command }) {
  if (target.kind === 'self') return { principal_id: session.principal_id, endpoint_id: session.endpoint_id };
  if (target.kind === 'user') usage('user routes are resolved through configured channels, not a principal lookup', verb);
  return resolveAgentAddress(client, session, target, { verb, replay: target.kind === 'new' ? newAgentReplay(session, command) : null });
}

async function selectedOutboundChannels(client, channels) {
  validateChannelSelection(channels);
  // ACADEMY_AGENT_NAME is the name the session's hook registered.
  const name = process.env.ACADEMY_AGENT_NAME;
  if (!routeOpenTo('slack', name) && channels.includes('slack')) {
    throw new AgentCommandError('slack_named_agents_only', 'Slack is for Academy agents. This session has no agent name.');
  }
  const catalog = await client.request('channel.route.list', { available_only: true, required_capability: 'send' });
  const available = (catalog.routes ?? []).map((route) => route.selector).filter((selector) => typeof selector === 'string' && selector.length > 0 && routeOpenTo(selector, name));
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
  if (key) mutateActionStore(session, (current) => {
    current.envelopes[key] = { ...current.envelopes[key], target_principal_id: targetPrincipalId, conversation_id: conversation.conversation_id };
  });
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

// UX §9: who exactly received it, as resolved at send time. A `new:` agent
// is `started` once its session id is known, else `starting`.
// A replacement that took the message over during the commit is disclosed.
// Sessions are named by handles unique among known sessions (`handle`).
function resolvedLabel({ runtime, session_id: sessionId, cwd, state, replacement_for: replacementFor, degraded }, handle) {
  if (state === 'starting') return `to new ${runtime} (${cwd}, starting; session id pending)`;
  // The commit succeeded but the replacement could not be read: say only what is known.
  if (degraded && !sessionId) return `to ${runtime ?? 'agent'} (${replacementFor ? `replacement for ${handle(replacementFor)}, ` : ''}${cwd ?? 'unknown cwd'}, state unknown)`;
  const label = state === 'started' ? `new ${runtime}` : runtime ?? 'agent';
  const replaced = replacementFor ? `replacement for ${handle(replacementFor)}, ` : '';
  return `to ${label} ${sessionId ? handle(sessionId) : 'pending'} (${replaced}${cwd ?? 'unknown cwd'}, ${state})`;
}

async function exactConfirmation(client, verb, resolved, { subject, conversationId, tail, handle = null }) {
  handle ??= await sessionHandlesFor(client, [resolved.session_id, resolved.replacement_for]);
  const parts = [verb, resolvedLabel(resolved, handle)];
  if (typeof subject === 'string' && subject.trim().length > 0) parts.push(subject);
  const line = [...parts, shortThreadId(conversationId), ...tail].join(' · ');
  const text = resolved.state === 'starting' ? `${line}\nNext: ${tightbeamRecipeCommand()} agent threads` : line;
  const warning = confirmationWarning(resolved);
  return warning ? `${text}\nWarning: ${warning}` : text;
}

// Where the commit actually routed, and the endpoint it replaced if lineage moved it.
function routeFields(result) {
  return {
    ...(result.routed_endpoint_id ? { routed_endpoint_id: result.routed_endpoint_id } : {}),
    ...(result.replaced_endpoint_id ? { replaced_endpoint_id: result.replaced_endpoint_id } : {}),
  };
}

// After the commit: a `new:` agent settles; a target replaced meanwhile becomes its replacement.
// The message is already durable, so neither read may fail the command: a wait
// that cannot be read reports the new agent as still starting, with a warning.
async function settledRecipient(client, target, result) {
  let settled;
  try {
    settled = await settleNewAgent(client, target, { messageId: result.message_id });
  } catch (error) {
    debugLog({ event: 'agent_new.wait', params: { message_id: result.message_id }, result: { code: error?.code ?? 'error', message: error?.message }, status: 'degraded' });
    settled = { ...target.resolved, session_id: null, state: 'starting', degraded: 'new_agent_status_unavailable' };
  }
  return routedRecipient(client, settled, result);
}

function debugLog(fields) {
  if (!process.env.TIGHTBEAM_HOOK_DEBUG) return;
  try {
    process.stderr.write(`${JSON.stringify({ component: 'tightbeam-agent', ...fields })}\n`);
  } catch {
    // Diagnostics never change the result.
  }
}

// Additive `--json` identity: existing fields stay; resolved, thread_id, and the route join them.
function withResolvedRecipient(response, target, confirmationText, result) {
  const warning = confirmationWarning(target.resolved);
  return { ...response, resolved: target.resolved, thread_id: response.conversation_id, ...routeFields(result), ...(warning ? { confirmation_warning: warning } : {}), confirmation: confirmationText };
}

// A delivery read after a durable commit never fails it: an unreadable status
// is reported beside the committed ids, with a warning not to resend.
async function readChannelDeliveries(client, messageId) {
  try {
    const deliveries = await client.request('message.delivery.list', { message_id: messageId });
    const channelDeliveries = deliveries.channel_deliveries ?? [];
    return { outcome: deliveryOutcome(channelDeliveries), channel_deliveries: channelDeliveries };
  } catch (error) {
    debugLog({ event: 'agent_delivery.read', params: { message_id: messageId }, result: { code: error?.code ?? 'error', message: error?.message }, status: 'degraded' });
    return {
      outcome: 'committed',
      delivery_check_error: error?.code ?? 'unavailable',
      confirmation_warning: `The message was already sent; its delivery status could not be read; do not resend. Check it with ${tightbeamRecipeCommand()} agent status --message ${messageId}.`,
    };
  }
}

function withDeliveryWarning(response) {
  if (!response.confirmation_warning || typeof response.confirmation !== 'string') return response;
  return { ...response, confirmation: `${response.confirmation}\nWarning: ${response.confirmation_warning}` };
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
  // The Next rides next_action (JSON and the text view's own Next line); the message does not repeat it.
  return new AgentCommandError('blocked_unread', `Send paused · unread message on “${subject}” from ${sender}. Read it before replying.`, { next_action: action });
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
    const custodian = named
      ?? nodes.findLast((node) => node.status === 'open' && node.custodian_endpoint_id)
      ?? nodes.findLast((node) => node.custodian_endpoint_id);
    const rootId = chain.root_obligation_id;
    throw new AgentCommandError(
      'recovery_authority_required',
      'this work is not in the current session’s exact custody; an explicit recovery retry or switch decision is required before updating it',
      {
        details: {
          root_id: rootId,
          custodian_endpoint_id: custodian?.custodian_endpoint_id ?? null,
          custodian_endpoint_state: custodian?.endpoint_state ?? null,
        },
        next_action: `Inspect the root with tldr-agents messaging lifecycle view --root ${rootId}; then an operator chooses tldr-agents messaging recovery retry or tldr-agents messaging recovery switch and supplies --root ${rootId} --generation ${chain.generation ?? '<root-generation>'} --target-endpoint <id> --target-process-generation <n> --key <idempotency-key>. The agent may send a new message instead of a reply.`,
      },
    );
  }
  return matches[0];
}

// Cancel authority mirrors the daemon (lifecycle_transition authorizeCancel):
// the root's requester (the exact opening endpoint or its lineage replacement)
// or the endpoint holding the open attempt. Nobody else; a downstream holder
// cannot cancel upward and keeps decline/complete instead. Refusals happen
// here, before any write, so they are zero-write by construction.
async function authorizeRequesterOrHolderCancel(client, chain, session) {
  const thread = shortThreadId(chain.conversation_id);
  if (chain.resolution) {
    const label = chain.resolution.resolution === 'cancelled' ? 'cancelled' : 'done';
    throw new AgentCommandError('work_closed', `Work on ${thread} is ${label}.`, {
      details: { root_id: chain.root_obligation_id, resolution: chain.resolution.resolution ?? null },
      next_action: `${tightbeamRecipeCommand()} agent thread --thread ${thread}`,
    });
  }
  const requester = chain.requester;
  if (requester && (requester.endpoint_id === session.endpoint_id || (requester.replacement_endpoint_ids ?? []).includes(session.endpoint_id))) return;
  const holdsOpenAttempt = (chain.attempts ?? []).some((node) => node.status === 'open' && node.custodian_endpoint_id === session.endpoint_id);
  if (holdsOpenAttempt) return;
  const handleFor = requester?.session_id ? await sessionHandlesFor(client, [requester.session_id]) : null;
  const who = requester?.runtime ? `${requester.runtime}${requester.session_id ? ` ${handleFor(requester.session_id)}` : ''}` : 'the session that opened it';
  // Decline works only for the session holding a pending offer; everyone else
  // is sent to read the thread (SC8: the Next must be a command that can succeed).
  const offer = pendingOfferFor(chain, session);
  throw new AgentCommandError('not_requester', `Only the requester (${who}) can cancel this work.`, {
    details: { root_id: chain.root_obligation_id, requester_endpoint_id: requester?.endpoint_id ?? null },
    next_action: offer ? offerActionCommands(offer.obligation_id).decline : `${tightbeamRecipeCommand()} agent thread --thread ${thread}`,
  });
}

// An offer is addressed to the recipient principal; an exact offer names the
// one session it was delivered to and that session's lineage successors
// (`offered_endpoint_ids`), so a same-principal sibling is not offered it.
// The daemon sends null for an offer addressed to the principal as a whole.
function offerAddressedTo(node, session) {
  if (node.accountable_principal_id !== session.principal_id) return false;
  return !Array.isArray(node.offered_endpoint_ids) || node.offered_endpoint_ids.includes(session.endpoint_id);
}

// The delegation offered to this session and still awaiting its answer.
function pendingOfferFor(chain, session) {
  return (chain.delegations ?? []).find(
    (node) => node.status === 'open' && node.custodian_endpoint_id === null && offerAddressedTo(node, session) && node.watch_state === 'awaiting_acceptance',
  ) ?? null;
}

function selectOfferedDelegation(chain, session, requestedWorkId) {
  const delegation = (chain.delegations ?? []).find((node) => node.obligation_id === requestedWorkId);
  if (
    !delegation
    || delegation.status !== 'open'
    || delegation.custodian_endpoint_id !== null
    || !offerAddressedTo(delegation, session)
    || delegation.watch_state !== 'awaiting_acceptance'
  ) {
    throw new AgentCommandError('handoff_unavailable', 'this work is not an offered delegation awaiting acceptance by the current session', {
      // A pending offer is listed with its delegation id among the threads waiting on the caller.
      next_action: `${tightbeamRecipeCommand()} agent threads --waiting-on me`,
    });
  }
  return delegation;
}

function handoffDeadline(session, command) {
  const key = actionStoreKey(command);
  return mutateActionStore(session, (store) => {
    const existing = store.envelopes[key];
    if (typeof existing?.acceptance_deadline_at === 'string' && !Number.isNaN(Date.parse(existing.acceptance_deadline_at))) {
      return existing.acceptance_deadline_at;
    }
    const acceptanceDeadlineAt = new Date(Date.now() + 5 * 60_000).toISOString();
    store.envelopes[key] = { ...existing, acceptance_deadline_at: acceptanceDeadlineAt };
    return acceptanceDeadlineAt;
  }) ?? new Date(Date.now() + 5 * 60_000).toISOString();
}

function shortSessionId(session) {
  return shortThreadId(session.session_id ?? session.provider_session_id ?? session.endpoint_id);
}

// A cancelled root closes its descendants as `superseded` (the stored audit),
// and lifecycle.view labels every closed root `done`. What an agent should see
// is the truth of how the work ended, derived from the root's own resolution.
function effectiveWorkStatus(chain) {
  return chain.resolution?.resolution === 'cancelled' ? 'cancelled' : chain.status;
}

// The deepest node in exact custody: the accepted delegation if one exists,
// else the attempt. After close it is the last holder, so a cancelled work
// still says who held it.
function currentHolder(chain) {
  const held = workNodes(chain).filter((node) => node.custodian_endpoint_id);
  const open = held.filter((node) => node.status === 'open');
  const node = (open.length > 0 ? open : held).at(-1);
  return node ? { endpoint_id: node.custodian_endpoint_id, role: node.role, endpoint_state: node.endpoint_state ?? null } : null;
}

function waitingOn(chain, session, holder) {
  if (chain.resolution) return 'nobody';
  const offered = (chain.delegations ?? []).find((node) => node.status === 'open' && node.custodian_endpoint_id === null && node.watch_state === 'awaiting_acceptance');
  if (offered) return offerAddressedTo(offered, session) ? 'you' : 'them';
  if (!holder) return 'nobody';
  return holder.endpoint_id === session.endpoint_id ? 'you' : 'them';
}

// Where the opening message stands on the delivery ladder at the endpoint that
// holds the work now. A lookup failure is reported, never hidden.
async function openingDeliveryStep(client, chain) {
  // The endpoint that holds the work now (a replacement took it over when an
  // earlier attempt failed), else the last one that did. thread.list reads the
  // step by the same rule (protocol/delivery_step.mjs), so both requester
  // views agree for a re-delivered held root.
  const held = (chain.attempts ?? []).filter((node) => node.custodian_endpoint_id);
  const target = (held.findLast((node) => node.status === 'open') ?? held.at(-1))?.custodian_endpoint_id;
  if (!chain.opening_message_id || !target) return { delivery_step: null };
  try {
    const deliveries = await client.request('message.delivery.list', { message_id: chain.opening_message_id });
    return { delivery_step: deliveryStepFor(deliveries.endpoint_deliveries ?? [], { holderEndpointId: target }) };
  } catch (error) {
    return { delivery_step: null, delivery_check_error: error?.code ?? 'unavailable' };
  }
}

// UX §9 agent_launch_failed: the open work's new agent never started.
function launchFailureFields(chain) {
  const notice = launchFailureNotice(chain.launch_failure, { tracked: true });
  if (!notice) return {};
  return { launch_failure: notice, next_action: `${tightbeamRecipeCommand()} agent thread --thread ${shortThreadId(chain.conversation_id)}` };
}

// The holder as S1 shows it (runtime, session id, derived state). A lookup
// failure keeps the bare holder and is reported, never hidden.
async function describedHolder(client, holder) {
  if (!holder) return { holder };
  try {
    const listed = await client.request('endpoint.list', { include_closed: true, limit: SESSION_LIST_LIMIT });
    const endpoint = (listed.endpoints ?? []).find((row) => row.endpoint_id === holder.endpoint_id);
    if (!endpoint) return { holder };
    const { state, resumable } = deriveSessionState(endpoint);
    const sessionId = endpoint.provider_session_id ?? null;
    // A `new:` placeholder with no session id yet is not a resumable session.
    // A truncated list cannot prove the handle unique, so it is looked up exactly.
    const handle = sessionId === null ? null : listed.truncated
      ? (await sessionHandlesFor(client, [sessionId]))(sessionId)
      : sessionHandleLookup([sessionId], (listed.endpoints ?? []).map((row) => row.provider_session_id))(sessionId);
    const named = sessionId === null ? { never_started: true } : { short_id: handle };
    return { holder: { ...holder, runtime: endpoint.runtime ?? null, session_id: sessionId, session_state: state, resumable, ...named } };
  } catch (error) {
    return { holder, holder_lookup_error: error?.code ?? 'unavailable' };
  }
}

// F19: an offer pending for this session names its delegation and the exact
// commands that answer it (additive JSON; the text view prints the same).
function pendingOfferFields(chain, session) {
  const offer = pendingOfferFor(chain, session);
  if (!offer) return {};
  const commands = offerActionCommands(offer.obligation_id);
  return { pending_offer: { delegation_id: offer.obligation_id }, accept_command: commands.accept, decline_command: commands.decline };
}

async function workStatusFields(client, session, chain) {
  const holder = currentHolder(chain);
  return {
    work_status: effectiveWorkStatus(chain),
    ...(await describedHolder(client, holder)),
    waiting_on: waitingOn(chain, session, holder),
    ...(await openingDeliveryStep(client, chain)),
    ...launchFailureFields(chain),
    ...pendingOfferFields(chain, session),
  };
}

// SC8: the work ids a session can act on are listed with the threads waiting on it.
function workNotFound(message = 'no visible work matches that handle') {
  return new AgentCommandError('work_not_found', message, { next_action: `${tightbeamRecipeCommand()} agent threads --waiting-on me` });
}

async function workChain(client, workId) {
  const view = await client.request('lifecycle.view', { root_obligation_id: workId });
  if (Array.isArray(view.chains) && view.chains.length === 1) return view.chains[0];
  const all = await client.request('lifecycle.view', {});
  const chain = (all.chains ?? []).find((candidate) => candidate.root_obligation_id === workId || workNodes(candidate).some((node) => node.obligation_id === workId));
  if (!chain) throw workNotFound();
  return chain;
}

async function runWorkCommand(client, session, command, chain, operation = command.command) {
  const node = operation === 'cancel' ? await authorizeRequesterOrHolderCancel(client, chain, session) : selectCustodiedWork(chain, session, command.workId);
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
  const verb = operation === 'complete' ? 'Completed' : operation === 'cancel' ? 'Cancelled' : 'Updated';
  if (notificationChannels) {
    if (command.waitDeliveryMs) {
      return withCancelNotice(operation, chain, result, correspondenceResult(result, { subject: chain.subject ?? null, noReply: false, workId: command.workId }));
    }
    return withDeliveryWarning({
      ...withCancelNotice(operation, chain, result, correspondenceResult(result, { subject: chain.subject ?? null, noReply: false, workId: command.workId, verb })),
      ...(await readChannelDeliveries(client, result.message_id)),
    });
  }
  return withCancelNotice(operation, chain, result, correspondenceResult(result, { subject: chain.subject ?? null, noReply: false, workId: command.workId, verb }));
}

// Every cancel, whatever route it replies through, says how many holders it notified.
function withCancelNotice(operation, chain, result, confirmed) {
  if (operation !== 'cancel') return confirmed;
  const notified = Number.isInteger(result.notified_holders) ? result.notified_holders : 0;
  const subject = typeof chain.subject === 'string' && chain.subject.trim().length > 0 ? [chain.subject] : [];
  return { ...confirmed, notified_holders: notified, confirmation: ['Cancelled', ...subject, shortThreadId(result.conversation_id), `notified ${notified} holder(s)`].join(' · ') };
}

// Receipt is oldest-first: the daemon's refusal names the older message, and
// receiving it is the next action.
function receiveOrderRefusal(error, messageId) {
  const oldest = error?.code === 'permission_denied' && error.details?.reason === 'older_message_first' ? error.details.oldest_message_id : null;
  if (!oldest) return null;
  return new AgentCommandError('permission_denied', `An older message must be received first: receive ${oldest} before ${messageId}.`, {
    details: { reason: 'older_message_first', message_id: messageId, oldest_message_id: oldest },
    next_action: `${tightbeamRecipeCommand()} agent receive --message ${oldest}`,
  });
}

// Any other receive the daemon refuses for this exact session (another
// session's message, nothing presented) keeps its verdict; the caller's own
// unread mail is the next action (SC8: every refusal has a Next).
function receiveRefusal(error) {
  if (error?.code !== 'permission_denied') return null;
  return new AgentCommandError('permission_denied', error.message, {
    ...(error.details ? { details: error.details } : {}),
    next_action: `${tightbeamRecipeCommand()} agent inbox --unread`,
  });
}

async function runAgentCommandOnce(client, session, command) {
  if (command.command === 'wait') return waitForAgent(client, session, { actionId: command.actionId, timeoutMs: command.timeoutMs });
  if (command.command === 'sessions') return listAgentSessions(client, session, command);
  if (command.command === 'send' && command.thread) return sendFollowUp(client, session, command);
  if (command.command === 'threads') return listAgentThreads(client, session, command);
  if (command.command === 'thread') return readAgentThread(client, session, command);
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
      return withDeliveryWarning({
        ...correspondenceResult(result, { subject: command.subject, noReply: command.noReply }),
        thread_id: result.conversation_id,
        ...(await readChannelDeliveries(client, result.message_id)),
      });
    }
    const target = await resolveAgent(client, session, command.to, { verb: 'send', command });
    const conversation = await conversationFor(client, session, target.principal_id, command);
    const result = await client.request('message.commit', {
      sender_principal_id: session.principal_id,
      conversation_id: conversation.conversation_id,
      body: command.body,
      idempotency_key: commitKey('send', command, 'message'),
      // `none` cannot name a target on the effect; the checked exact route does.
      ...(command.noReply ? { recipient_endpoint_id: target.endpoint_id } : {}),
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
    target.resolved = await settledRecipient(client, target, result);
    const sent = correspondenceResult(result, { subject: command.subject, noReply: command.noReply, workId: command.noReply ? null : result.root_id });
    return withResolvedRecipient(sent, target, await exactConfirmation(client, 'Sent', target.resolved, { subject: command.subject, conversationId: result.conversation_id, tail: [sent.reply_policy] }), result);
  }
  if (command.command === 'request') {
    const notificationChannels = command.notify === 'user' ? await selectedOutboundChannels(client, command.channels) : null;
    const target = await resolveAgent(client, session, command.to, { verb: 'request', command });
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
    const opened = { ...intentResult(result), work_id: result.root_id, thread_id: result.conversation_id };
    if (!target.resolved) return opened;
    target.resolved = await settledRecipient(client, target, result);
    return withResolvedRecipient(opened, target, await exactConfirmation(client, 'Sent', target.resolved, { subject: command.subject, conversationId: result.conversation_id, tail: ['reply required'] }), result);
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
        throw workNotFound('the message work does not belong to its canonical conversation');
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
      return withDeliveryWarning({
        ...correspondenceResult(result, { subject: message.conversation_subject ?? null, noReply: command.noReply, workId }),
        ...(await readChannelDeliveries(client, result.message_id)),
      });
    }
    return correspondenceResult(result, { subject: message.conversation_subject ?? null, noReply: command.noReply, workId });
  }
  if (command.command === 'receive') {
    if (typeof session.session_id !== 'string' || session.session_id.length === 0) {
      throw new AgentCommandError('session_unavailable', 'the current Tightbeam session lacks provider session identity; refresh the supported SessionStart hook before receiving');
    }
    let result;
    try {
      result = await client.request('message.receive', {
        message_id: command.messageId,
        endpoint_id: session.endpoint_id,
        process_generation: session.process_generation,
        provider_session_id: session.session_id,
      });
    } catch (error) {
      throw receiveOrderRefusal(error, command.messageId) ?? receiveRefusal(error) ?? error;
    }
    const offer = typeof result.delegation_id === 'string' ? offerActionCommands(result.delegation_id, session.recipe_prefix) : null;
    // F23: held work names its work id; these are the commands that use it.
    const work = typeof result.work_id === 'string' ? workActionCommands(result.work_id, session.recipe_prefix) : null;
    return {
      outcome: 'committed',
      ...result,
      ...(offer ? { accept_command: offer.accept, decline_command: offer.decline } : {}),
      ...(work ? { update_command: work.update, complete_command: work.complete, delegate_command: work.delegate } : {}),
      ...(work && result.ack_pending === true ? { ack_command: work.ack } : {}),
      acknowledge_command: `${session.recipe_prefix ?? tightbeamRecipeCommand()} ack ${result.message_id} --endpoint ${session.endpoint_id} --generation ${session.process_generation}`,
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
      // Only work that arrived as a user message owes an acknowledgement; agent-held work reports progress with update.
      throw new AgentCommandError('ack_unavailable', 'this work has no pending user acknowledgement', {
        next_action: `${tightbeamRecipeCommand()} agent update --work ${command.workId} --body "<progress>"`,
      });
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
    return withDeliveryWarning({
      ...intentResult(result),
      work_id: chain.root_obligation_id,
      ...(await readChannelDeliveries(client, result.message_id)),
      confirmation: 'Acknowledged · final response still required',
    });
  }
  if (command.command === 'delegate') {
    const chain = await workChain(client, command.workId);
    const node = selectCustodiedWork(chain, session, command.workId);
    const target = await resolveAgent(client, session, command.to, { verb: 'delegate', command });
    const result = await client.request('message.commit', {
      sender_principal_id: session.principal_id,
      conversation_id: chain.conversation_id,
      body: command.body,
      idempotency_key: commitKey('delegate', command, 'message'),
      recipient_endpoint_id: target.endpoint_id,
      obligation_effect: {
        type: 'handoff.offer', obligation_id: node.obligation_id, generation: node.generation,
        sender_endpoint_id: session.endpoint_id, process_generation: session.process_generation,
        target_principal_id: target.principal_id, registration_key: commitKey('delegate', command, 'registration'),
        acceptance_deadline_at: handoffDeadline(session, command),
      },
    });
    target.resolved = await settledRecipient(client, target, result);
    const callerSessionId = session.session_id ?? session.provider_session_id ?? null;
    const handle = await sessionHandlesFor(client, [target.resolved.session_id, target.resolved.replacement_for, callerSessionId]);
    const returnTo = callerSessionId ? handle(callerSessionId) : shortSessionId(session);
    return {
      ...correspondenceResult(result, { subject: chain.subject ?? null, noReply: false, workId: chain.root_obligation_id, verb: 'Delegated' }),
      ...routeFields(result),
      ...(confirmationWarning(target.resolved) ? { confirmation_warning: confirmationWarning(target.resolved) } : {}),
      delegation_id: result.delegation_id,
      watch_id: result.watch_id,
      delegate_label: formatAddress(command.to),
      return_session: returnTo,
      resolved: target.resolved,
      thread_id: result.conversation_id,
      confirmation: await exactConfirmation(client, 'Delegated', target.resolved, {
        subject: chain.subject ?? null, conversationId: result.conversation_id, tail: [`return to ${returnTo}`, 'final response still required'], handle,
      }),
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
      const workFields = await workStatusFields(client, session, chain);
      if (!messageId) {
        return { outcome: workFields.work_status, work_id: chain.root_obligation_id, ...workFields, staged_resolution: stagedResolution, notification: chain.notification ?? null };
      }
      const deliveries = await client.request('message.delivery.list', { message_id: messageId });
      const channelDeliveries = deliveries.channel_deliveries ?? [];
      return {
        outcome: deliveryOutcome(channelDeliveries),
        work_id: chain.root_obligation_id,
        ...workFields,
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
  const boundCommand = bindAgentCommand(session, command);
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
    if (command.command === 'wait' || !refreshSession || !staleGenerationConflict(error)) throw error;
    const refreshed = await refreshSession();
    result = await runAgentCommandOnce(client, refreshed, boundCommand);
  }
  // Waiting only reads the committed outbound message. A timeout or read error
  // must never re-enter the send/complete retry path.
  if (command.waitDeliveryMs) result = await waitForDelivery(client, session, result, command.waitDeliveryMs);
  result = deliveryConfirmation(result, command);
  const warning = consumeInboundWarning(session, boundCommand);
  if (warning) result = { ...result, warning };
  return command.command === 'status' && command.workId ? { ...result, rendered: renderWorkStatus(result) } : result;
}

const TERMINAL_WORK_STATUSES = new Set(['done', 'cancelled']);

// Terminal work has nothing left to wait for: report how it ended, any
// delivery verdict it did reach, and the thread to read, never the same wait.
function terminalWorkConfirmation(result, { delivered, failed }) {
  const thread = result.thread_id ? shortThreadId(result.thread_id) : null;
  const delivery = delivered ? 'Delivery confirmed' : failed ? 'Delivery failed' : null;
  return {
    ...result,
    // With no delivery verdict, the outcome of a closed work is how it ended, as plain `status --work` reports it, not the wait's `committed`.
    outcome: result.outcome === 'committed' ? result.work_status : result.outcome,
    confirmation: [`Work ${result.work_status}`, result.subject, thread, delivery].filter(Boolean).join(' · '),
    ...(thread ? { next_action: `${tightbeamRecipeCommand()} agent thread --thread ${thread}` } : {}),
    ...(failed ? { guidance: 'Report the delivery failure; do not resend automatically.' } : {}),
  };
}

function holderLabel(holder) {
  if (!holder) return 'nobody';
  if (holder.never_started) return `${holder.runtime ?? 'session'} (never started)`;
  const state = holder.session_state === 'stopped' && holder.resumable ? 'stopped · resumable' : (holder.session_state ?? holder.endpoint_state);
  return `${holder.runtime ?? 'session'} ${holder.short_id ?? shortThreadId(holder.session_id ?? holder.endpoint_id)}${state ? ` (${state})` : ''}`;
}

/** The `status --work` text view: one headline, then one plain line per known field. */
function renderWorkStatus(result) {
  const channels = Array.isArray(result.channel_deliveries) && result.channel_deliveries.length > 0
    ? result.channel_deliveries.map((delivery) => `${delivery.label ?? delivery.selector ?? 'channel'} ${delivery.state}`).join(', ')
    : null;
  const fields = [
    ['work_id', result.work_id],
    ['holder', holderLabel(result.holder)],
    ['waiting_on', result.waiting_on],
    ['delivery_step', result.delivery_step],
    ['launch_failure', result.launch_failure?.message],
    ['pending_offer', result.pending_offer ? `${result.pending_offer.delegation_id} (offered to you; receive it, then accept or decline)` : null],
    ['accept_command', result.accept_command],
    ['decline_command', result.decline_command],
    ['message_id', result.message_id],
    ['delivery_wait', result.delivery_wait],
    ['delivery_check_error', result.delivery_check_error],
    ['holder_lookup_error', result.holder_lookup_error],
    ['channel_deliveries', channels],
    ['next_action', result.next_action],
    ['guidance', result.guidance],
  ];
  const headline = result.confirmation ?? `Work ${String(result.work_status ?? 'unknown').replaceAll('_', ' ')}`;
  return [headline, ...fields.filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => `${key}: ${value}`)].join('\n');
}

function deliveryConfirmation(result, command) {
  if (['ack', 'update'].includes(command.command)) return result;
  // A plain send keeps its own receipt; only an explicit wait reports delivery.
  if (command.command === 'send' && !command.waitDeliveryMs) return result;
  if ((!Array.isArray(result.channel_deliveries) && !command.waitDeliveryMs) || (!result.confirmation && !command.waitDeliveryMs)) return result;
  const delivered = result.outcome === 'delivered';
  const failed = result.channel_deliveries?.some((delivery) => ['failed', 'cancelled'].includes(delivery.state));
  if (command.command === 'status' && command.workId && TERMINAL_WORK_STATUSES.has(result.work_status)) return terminalWorkConfirmation(result, { delivered, failed });
  const unavailable = result.delivery_check_error === 'permission_denied';
  const noRoutes = result.channel_deliveries?.length === 0;
  const label = delivered ? 'Delivery confirmed'
    : failed ? 'Delivery failed'
    : unavailable ? 'Delivery status unavailable'
    : noRoutes ? 'Message committed; no channel delivery to confirm'
    : command.command === 'status' ? 'Delivery not confirmed'
    : command.command === 'send' ? 'Message queued; delivery not yet confirmed'
    : 'Reply queued; delivery not yet confirmed';
  const target = result.message_id ? `--message ${result.message_id}` : `--work ${result.work_id}`;
  // A cancel keeps its holder notice; the delivery label follows it.
  const cancelNotice = command.command === 'cancel' && Number.isInteger(result.notified_holders) ? `${result.confirmation} · ` : '';
  return {
    ...result,
    confirmation: `${cancelNotice}${label}`,
    ...(!delivered ? {
      ...(!failed && !unavailable && !noRoutes ? { next_action: `${tightbeamCommandHint()} agent status ${target} --wait-delivery 30s` } : {}),
      guidance: result.guidance ?? (failed ? 'Report the delivery failure; do not resend automatically.' : `Check this existing ${['send', 'status'].includes(command.command) ? 'message' : 'reply'}; do not resend it.`),
    } : {}),
  };
}

async function waitForDelivery(client, session, initial, timeoutMs) {
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
    // It reports the same work fields as plain status --work, so a cancelled
    // root reads cancelled here too.
    if (!result.message_id && result.work_id) {
      const chain = await workChain({ request: read }, result.work_id);
      // A cancelled root's resolution carries no message: nothing to wait on.
      const messageId = chain.staged_resolution?.message_id ?? chain.notification?.message_id ?? chain.resolution?.message_id;
      result = {
        ...result,
        work_id: chain.root_obligation_id,
        thread_id: chain.conversation_id,
        subject: chain.subject ?? null,
        ...(await workStatusFields({ request: read }, session, chain)),
        ...(messageId ? { message_id: messageId } : {}),
      };
    }
    if (!result.message_id) return { ...result, delivery_wait: 'unavailable' };
    for (;;) {
      const routes = result.channel_deliveries;
      if (routes?.length && routes.every((delivery) => delivery.state === 'delivered')) {
        result = { ...result, delivery_wait: 'delivered' };
        if (result.work_id) {
          const view = await read('lifecycle.view', { root_obligation_id: result.work_id });
          const settled = view.chains?.find((entry) => entry.root_obligation_id === result.work_id);
          result.work_status = settled ? effectiveWorkStatus(settled) : undefined;
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
