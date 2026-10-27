// Runtime hook adapters resolve exact identity through hook_identity.mjs and
// invoke only existing daemon operations. Tool-boundary shell hooks check the
// inbox watermark before starting PreToolUse/PostToolUse; both remain callable.

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { connect } from '../client/client.mjs';
import { shortId } from '../protocol/ids.mjs';
import { isSafeSessionId, sessionPaths } from '../protocol/session_paths.mjs';
import { routeOpenTo } from '../protocol/session_env.mjs';
import {
  captureOwnerProcess,
  classifyHookPayload,
  defaultPrincipalRef,
  readStdinSync,
  resolveHostBinding,
  resolveLaunchMode,
  resolveRuntime,
  resolveSessionId,
  resolveWorkingDirectory,
  sessionEnvChain,
} from './hook_identity.mjs';
import { hookCredentialsPath, readHookCredentials } from './hook_credentials.mjs';
import { observeProcessRow } from './hook_process_tree.mjs';
import { bootstrap, ensureDaemon } from './bootstrap.mjs';
import { offerActionCommands, tightbeamCodexWaitRecipe, tightbeamCommandHint, tightbeamCommandName, tightbeamRecipeCommand, workActionLines } from './package_context.mjs';
import { arrivalField, renderArrivalBlock } from '../protocol/arrival_block.mjs';
import { readCurrentWaitOutcome, readWaitMessage } from './agent_wait_journal.mjs';
import { decodeCopilotHookInput } from './copilot_hook.mjs';
import { academyLaunchStamp, packageBoundCopilotRuntimeIds } from '../runtimes/copilot_wake_contract.mjs';
import { boundCopilotRuntime, requiresExplicitCopilotRuntime, runCopilotHook } from './copilot_hook_runtime.mjs';

/** Choose bootstrap or daemon restoration without publishing partial credentials. */
function sessionStartPreparation({ credentials, flags, env }) {
  const hasExplicitIdentity = Boolean(
    flags.appId ||
      flags.appSecret ||
      flags.authority ||
      env.TIGHTBEAM_APP_ID ||
      env.TIGHTBEAM_APP_SECRET ||
      env.TIGHTBEAM_AUTHORITY,
  );
  if (!hasExplicitIdentity) return 'bootstrap';

  const appId = flags.appId || env.TIGHTBEAM_APP_ID || credentials?.app_id;
  const appSecret = flags.appSecret || env.TIGHTBEAM_APP_SECRET || credentials?.app_secret;
  const authority = flags.authority || env.TIGHTBEAM_AUTHORITY || credentials?.authority_name;
  return appId && appSecret && authority ? 'daemon' : null;
}

export const HOOK_EVENT_VERBS = ['session-start', 'user-prompt-submit', 'stop', 'wake-listen', 'pre-tool-use', 'post-tool-use', 'subagent-start', 'subagent-stop'];

// A hook that fails must not fail the agent's turn. Claude Code treats
// exit code 2 as "block"; every diagnostic below exits 1, which the
// runtime surfaces without stopping the session. Exit 2 is deliberate in
// exactly two places, each a decision rather than a failure: the Stop gate
// when it blocks, and the `wake-listen` listener when it wakes an idle
// session (an async-rewake hook wakes its host by exiting 2).
export class HookError extends Error {}

// Injected context is read by a model, so it is bounded: an unread 256 KiB
// message (the message.send cap) must not become 256 KiB of prompt.
const MAX_INJECTED_CHARS = 8000;

export function isHookProofDebugEvent(fields) {
  return (
    ((fields?.event === 'hook_stdin' || fields?.event === 'runtime_resolved') &&
      (fields.verb === 'pre-tool-use' || fields.verb === 'post-tool-use')) ||
    fields?.event === 'inject_emitted' ||
    fields?.event === 'inject_skipped'
  );
}

// The stream debug lines go to. `wake-listen` moves them to stdout while it
// runs: on a wake Claude Code shows the model that process's entire stderr
// verbatim as the arrival, so a diagnostic there would read as part of the
// message. stdout is safe because the host reads an async-rewake hook's
// stdout only when its stderr is empty (never on a wake), and the listener
// prints nothing else there. Every other verb keeps stderr.
let debugStreamName = 'stderr';

async function withDebugOffWakeChannel(work) {
  const previous = debugStreamName;
  debugStreamName = 'stdout';
  try {
    return await work();
  } finally {
    debugStreamName = previous;
  }
}

function debugLog(fields) {
  if (!process.env.TIGHTBEAM_HOOK_DEBUG) return;
  const line = `${JSON.stringify({ component: 'tightbeam-hook', ...fields })}\n`;
  process[debugStreamName].write(line);
  const file = process.env.TIGHTBEAM_HOOK_DEBUG_FILE;
  if (!file || !isHookProofDebugEvent(fields)) return;
  try {
    const before = fs.lstatSync(file);
    const noFollow = fs.constants.O_NOFOLLOW;
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      (before.mode & 0o077) !== 0 ||
      !Number.isInteger(noFollow)
    )
      return;
    const descriptor = fs.openSync(
      file,
      fs.constants.O_APPEND | fs.constants.O_WRONLY | noFollow,
    );
    try {
      const opened = fs.fstatSync(descriptor);
      if (opened.dev !== before.dev || opened.ino !== before.ino) return;
      fs.writeSync(descriptor, line, undefined, 'utf8');
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    // Debug evidence must never alter installed hook behavior.
  }
}

function writeFilePrivate(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, contents, { mode: 0o600 });
}

function readCache(paths) {
  try {
    const cached = JSON.parse(fs.readFileSync(paths.endpoint, 'utf8'));
    if (cached && typeof cached.endpoint_id === 'string' && typeof cached.principal_id === 'string') return cached;
  } catch {
    // A missing or unreadable cache is not an error: every verb can
    // rebuild it from an idempotent re-registration.
  }
  return null;
}

function recoveryStage(paths, endpoint) {
  const file = paths.recovery ?? path.join(paths.dir ?? path.dirname(paths.endpoint), 'recovery-context.json');
  try {
    const stage = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (stage?.resume_request_id === endpoint.recovery_resume_request_id && stage?.endpoint_id === endpoint.endpoint_id && stage.context) return stage.context;
  } catch {
    // No stage is normal on the first replacement SessionStart.
  }
  return null;
}

function sanitizedRecoveryContext(context) {
  return {
    subject: context.subject,
    participants: context.participants,
    messages: context.messages,
    unread: context.unread,
    root: context.root,
    // Session ids and endpoint lineage are daemon-only authority facts;
    // the hook needs only the typed failure explanation to render context.
    lineage: { failure_reason: context.lineage?.failure_reason ?? null },
  };
}

/** Identity is already resolved and validated against this runtime's registry. */
export function resolveIdentity({ payload, env, flags, credentials, sessionId, runtime, verb, copilotRecord = null }) {
  const authorityName = flags.authority || env.TIGHTBEAM_AUTHORITY || credentials?.authority_name;
  if (!authorityName) {
    throw new HookError(
      `no authority to register under: run "${tightbeamCommandName()} bootstrap", or set "authority_name" in the hook credential ` +
        `file, or pass --authority. Run "${tightbeamCommandName()} doctor" to see which checks fail`,
    );
  }
  const cwd = resolveWorkingDirectory({ payload, env });
  const log = verb === 'session-start' ? (fields) => debugLog({ ...fields, session_id: sessionId, runtime }) : undefined;
  return {
    session_id: sessionId,
    runtime,
    authority_name: authorityName,
    cwd,
    // Logged once per session (SessionStart); the tool-boundary verbs also
    // re-resolve identity and must stay out of the log.
    launch_mode: resolveLaunchMode({ payload, env, runtime, log }),
    // Set only by the daemon on a session it started (src/daemon/resumer.mjs
    // childEnv): the token of THAT launch. Forwarded verbatim so the
    // registration this session performs stamps which launch owns the
    // endpoint, which is what lets a later exit be told apart from a
    // zombie sibling's. Absent for an interactive session, and absent is a
    // valid answer — the row then records no launch owner at all.
    launch_token: env.TIGHTBEAM_LAUNCH_TOKEN || null,
    // Set only by the daemon on a cold start (resumer.mjs childEnv): the
    // exact placeholder this session was launched to adopt.
    placeholder_endpoint_id: env.TIGHTBEAM_PLACEHOLDER_ENDPOINT_ID || null,
    ...academyLaunchStamp(env, { record: copilotRecord, log }),
    ...resolveHostBinding(env, { log }),
    principal_ref: flags.principalRef || env.TIGHTBEAM_PRINCIPAL_REF || credentials?.principal_ref || defaultPrincipalRef({ runtime, cwd }),
  };
}

/** Idempotently register the session identity and cache the returned endpoint. */
async function registerSession(client, { paths, identity, app_id: appId }) {
  // The owning runtime process (item 42 C), observed only where the
  // endpoint is registered: the tool-boundary verbs never pay for a ps
  // walk. Null (capture failed or unsupported) registers without liveness
  // evidence, so the daemon never resumes this session headlessly on its
  // own; a caller-supplied snapshot (tests) is forwarded as given.
  const ownerProcess = identity.owner_process !== undefined
    ? identity.owner_process
    : captureOwnerProcess({ runtime: identity.runtime, copilot: identity.copilot_hook_bound, sessionId: identity.session_id, cwd: identity.cwd, log: (fields) => debugLog({ ...fields, session_id: identity.session_id }) });
  const principal = await client.request('principal.register', {
    authority_name: identity.authority_name,
    external_principal_ref: identity.principal_ref,
  });
  const endpoint = await client.request('endpoint.register', {
    authority_name: identity.authority_name,
    principal_id: principal.principal_id,
    runtime: identity.runtime,
    provider_session_id: identity.session_id,
    launch_mode: identity.launch_mode,
    authority_reference: identity.cwd,
    launch_token: identity.launch_token,
    academy_agent_name: identity.academy_agent_name,
    academy_permission_mode: identity.academy_permission_mode,
    ...(identity.host_name ? { host_name: identity.host_name, ...(identity.host_ref ? { host_ref: identity.host_ref } : {}) } : {}),
    ...(identity.placeholder_endpoint_id ? { placeholder_endpoint_id: identity.placeholder_endpoint_id } : {}),
    ...(ownerProcess ? { owner_process: ownerProcess } : {}),
  });

  const record = {
    session_id: identity.session_id,
    principal_id: principal.principal_id,
    endpoint_id: endpoint.endpoint_id,
    runtime: identity.runtime,
    authority_name: identity.authority_name,
    authority_reference: identity.cwd,
    launch_mode: identity.launch_mode,
    // Absent until runtime adoption stamps it (wave 4); carried once the
    // registration response exposes it so session.stop can fence exactly.
    process_generation: endpoint.process_generation ?? null,
    recovery_resume_request_id: endpoint.recovery_resume_request_id ?? null,
    // This is an opaque local binding, not daemon authority.  It prevents
    // a second installed app from using this exact session endpoint merely
    // because it can read the state directory; daemon ownership remains
    // the authoritative principal/read gate.
    app_id: appId,
    registered_at: new Date().toISOString(),
  };
  writeFilePrivate(paths.endpoint, `${JSON.stringify(record, null, 2)}\n`);
  debugLog({
    event: 'session_registered',
    session_id: identity.session_id,
    endpoint_id: endpoint.endpoint_id,
    idempotent_replay: endpoint.idempotent_replay,
    state: endpoint.state,
    launch_mode: identity.launch_mode,
  });
  return { ...record, state: endpoint.state, idempotent_replay: endpoint.idempotent_replay };
}

async function resolveSessionEndpoint(client, ctx) {
  const cached = readCache(ctx.paths);
  if (cached) {
    if (typeof cached.app_id === 'string' && cached.app_id !== ctx.app_id) {
      throw new HookError('the hook app does not match the app that registered this session endpoint');
    }
    if (typeof cached.app_id === 'string') return cached;
    // An old cache did not record its owner. Re-registering is idempotent
    // for the owning app and lets the daemon refuse a foreign app before
    // any inbox enumeration or delivery read.
    return registerSession(client, ctx);
  }
  // Hooks installed mid-session, or a cleared state root: re-register
  // rather than refuse, because the registration is idempotent and the
  // session is provably alive (its hook is running).
  return registerSession(client, ctx);
}

async function setEndpointState(client, ctx, state) {
  const endpoint = await resolveSessionEndpoint(client, ctx);
  if (!Number.isSafeInteger(endpoint.process_generation) || endpoint.process_generation < 1) {
    throw new HookError('the cached session endpoint has no exact process generation');
  }
  const result = await client.request('endpoint.state.set', {
    endpoint_id: endpoint.endpoint_id,
    process_generation: endpoint.process_generation,
    state,
  });
  debugLog({ event: 'endpoint_state_set', session_id: ctx.identity.session_id, endpoint_id: endpoint.endpoint_id, state });
  return { endpoint_id: result.endpoint_id, state: result.state };
}

// UX §9 S7. The context lines are absent for an entry staged before the
// daemon returned them; nothing here ever reads or prints a message body.
// Sender-controlled values pass through arrivalField (H1): one line, no tag.
function renderContextLines(entry) {
  if (typeof entry.thread_id !== 'string') return [];
  return [
    `From: ${arrivalField(entry.from)}${entry.from_cwd ? ` · ${arrivalField(entry.from_cwd)}` : ''}`,
    `Subject: ${arrivalField(entry.subject)}`,
    `Thread: ${shortId(entry.thread_id)} · ${entry.reply_required ? 'reply required' : 'no reply required'}`,
  ];
}

// UX §9 S11: a chain notice (delegation or cancel) leads with the S11 line
// the daemon derived from the canonical effect and its route reason. It asks
// for no reply, so it offers only the receive command (plus the held work's
// commands when the notice returns offered work to its offerer).
function renderNoticeLines(entry, prefix) {
  return [
    'tldr notice · received',
    arrivalField(entry.notice),
    `Message: ${entry.message_id}`,
    `Receive command: ${prefix} agent receive --message ${entry.message_id}`,
    // Offered work that came back (expired or lost) is still held: its work id and commands.
    ...(typeof entry.work_id === 'string' ? workActionLines({ work_id: entry.work_id, ack_pending: entry.ack_pending === true }, { prefix, commandSuffix: ' command' }) : []),
  ];
}

export function renderInjection(entries, { prefix = tightbeamCommandHint() } = {}) {
  const lines = [];
  for (const entry of entries) {
    if (lines.length > 0) lines.push('');
    if (typeof entry.notice === 'string') {
      lines.push(...renderNoticeLines(entry, prefix));
      continue;
    }
    lines.push('tldr message · received');
    lines.push(...renderContextLines(entry));
    lines.push(`Message: ${entry.message_id}`);
    lines.push(`Receive command: ${prefix} agent receive --message ${entry.message_id}`);
    if (typeof entry.delegation_id === 'string') {
      // A delegate answers an offer with accept or decline; a reply is not one.
      const offer = offerActionCommands(entry.delegation_id, prefix);
      lines.push(`Delegation: ${entry.delegation_id} · offered to you; receive it, then accept or decline`);
      lines.push(`Accept command: ${offer.accept}`);
      lines.push(`Decline command: ${offer.decline}`);
    } else {
      lines.push(`Reply command: ${prefix} agent reply --message ${entry.message_id} --body "<reply>" --wait-delivery 30s`);
    }
    // Tracked work this session holds: the id `--work` takes (F23).
    if (typeof entry.work_id === 'string') {
      lines.push(...workActionLines({ work_id: entry.work_id, ack_pending: entry.ack_pending === true }, { prefix, commandSuffix: ' command' }));
    }
    if (entry.has_external_origin) {
      lines.push(`For this external user message, within 120 seconds send ${prefix} agent ack saying it was received and work is underway, or send ${prefix} agent complete if the full answer is ready. A complete answer inside 120 seconds satisfies ACK; after a progress ACK, send the terminal response within 300 seconds of inbound acceptance.`);
    }
  }
  const text = lines.join('\n');
  const neutralized = entries.filter((entry) => ['from', 'from_cwd', 'subject', 'notice'].some((field) => typeof entry[field] === 'string' && arrivalField(entry[field]) !== entry[field]));
  if (neutralized.length > 0) {
    debugLog({ event: 'arrival_fields_neutralized', params: { message_ids: neutralized.map((entry) => entry.message_id) }, result: { count: neutralized.length }, status: 'escaped' });
  }
  const body = text.length > MAX_INJECTED_CHARS ? `${text.slice(0, MAX_INJECTED_CHARS)}\n[truncated; reply to each listed message explicitly]` : text;
  // Truncate inside the tag so the closing tag always survives.
  return renderArrivalBlock({
    event: 'received',
    messageIds: entries.map((entry) => entry.message_id),
    externalMessageIds: new Set(entries.filter((entry) => entry.has_external_origin).map((entry) => entry.message_id)),
    body,
  });
}

function renderOutboundChannelCatalog(routes) {
  const catalog = routes.map(({ selector, label }) => ({ selector, label }))
    .sort((a, b) => (a.selector < b.selector ? -1 : a.selector > b.selector ? 1 : 0));
  return `<tightbeam_outbound_channels>\n${JSON.stringify(catalog)}\n</tightbeam_outbound_channels>`;
}

/**
 * A replacement SessionStart receives canonical recovery state before the
 * ordinary outbound catalog.  Lineage IDs and provider-session identities
 * deliberately stay out of the model prompt: they are operator evidence,
 * not instructions or reply authority.
 */
export function renderRecoveryContext(context, adoptionLines = []) {
  const participantNames = (context.participants ?? []).map((participant) => participant.display_name ?? 'Unnamed participant').join(', ');
  const messages = (context.messages ?? [])
    .map((message) => `[${message.created_at}] ${String(message.body ?? '')}`)
    .join('\n');
  const root = context.root ?? {};
  return [
    '<tightbeam_recovery_context>',
    'You are the freshly started replacement session for this existing work. Continue from canonical context; do not recreate or infer a sibling transcript.',
    `Subject: ${context.subject ?? '(subject unavailable)'}`,
    `Participants: ${participantNames}`,
    `Root: ${root.root_obligation_id ?? 'unavailable'}`,
    `Root generation: ${root.generation ?? 'unavailable'}`,
    `Custody state: ${root.status ?? 'unavailable'}`,
    `Unread message ids: ${(context.unread?.message_ids ?? []).join(', ') || 'none'}`,
    'Relevant messages:',
    messages,
    'This is recovery context, not an acknowledgement request: no acknowledgement ceremony is required before ordinary action.',
    ...adoptionLines,
    '</tightbeam_recovery_context>',
  ].join('\n');
}

/**
 * S10 (ux.md §9): the threads this replacement adopted through lineage and
 * each predecessor that could not be resumed. Plain text, no bodies.
 */
export function renderAdoptionLines(threads) {
  const adopted = (threads ?? []).filter((thread) => (thread.adopted_from ?? []).length > 0);
  if (adopted.length === 0) return [];
  const previous = new Map();
  for (const thread of adopted) {
    for (const from of thread.adopted_from) {
      if (previous.has(from.endpoint_id)) continue;
      const runtime = from.runtime ?? (thread.participants ?? []).find((participant) => participant.endpoint_id === from.endpoint_id)?.runtime ?? 'session';
      previous.set(from.endpoint_id, `Previous session: ${runtime} ${shortId(from.provider_session_id ?? from.endpoint_id)} could not be resumed.`);
    }
  }
  const listed = adopted.map((thread) => [shortId(thread.conversation_id), thread.subject].filter(Boolean).join(' ')).join(', ');
  return [`Adopted threads: ${listed}`, ...previous.values()];
}

// The adopted-thread read is disclosure, not recovery authority: a failure
// leaves the recovery context intact and is only logged.
async function readAdoptionLines(client, endpoint) {
  try {
    const listed = await client.request('thread.list', {
      principal_id: endpoint.principal_id,
      endpoint_id: endpoint.endpoint_id,
      process_generation: endpoint.process_generation,
    });
    const lines = renderAdoptionLines(listed.threads);
    debugLog({ event: 'recovery_adopted_threads', endpoint_id: endpoint.endpoint_id, thread_count: listed.threads?.length ?? 0, line_count: lines.length });
    return lines;
  } catch (error) {
    debugLog({ event: 'recovery_adopted_threads_unavailable', endpoint_id: endpoint.endpoint_id, error: error.code || error.message });
    return [];
  }
}

/** The staged notification file, split into what can be injected and what cannot. */
function readStagedEntries(paths, file = paths.pending) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { entries: [], torn: [] };
  }
  const entries = [];
  const torn = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      torn.push(line);
    }
  }
  return { entries, torn };
}

const SCRATCH_LOCK_STALE_MS = 30_000;

function scratchLockPath(paths) {
  return path.join(paths.dir, '.pending-inject.lock');
}

function withScratchLock(paths, work) {
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const lock = scratchLockPath(paths);
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > SCRATCH_LOCK_STALE_MS) {
        fs.rmdirSync(lock);
        fs.mkdirSync(lock, { mode: 0o700 });
      } else {
        return null;
      }
    } catch (retryError) {
      if (retryError.code === 'EEXIST' || retryError.code === 'ENOENT') return null;
      throw retryError;
    }
  }
  try {
    return work();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

function claimFileName() {
  return `.pending-inject.claim-${process.pid}`;
}

function activeClaim(paths) {
  try {
    return fs
      .readdirSync(paths.dir)
      .filter((name) => name.startsWith('.pending-inject.claim-'))
      .sort()[0] ?? null;
  } catch {
    return null;
  }
}

function isLiveClaim(name) {
  const pid = Number(name.slice('.pending-inject.claim-'.length));
  if (!Number.isSafeInteger(pid) || pid < 1 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Appends ONE staged notification and returns only once it is on the disk.
 *
 * The listener ACK follows this write. If the hook dies before returning its
 * continuation, the notification remains durable without exposing message
 * content or claiming provider admission.
 */
export function appendStagedEntry(paths, entry) {
  const staged = withScratchLock(paths, () => {
    const { entries } = readStagedEntries(paths);
    if (entries.some((existing) => existing?.message_id === entry.message_id)) return false;
    const fd = fs.openSync(paths.pending, 'a', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(entry)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  });
  if (staged === null) throw new HookError('the local notification scratch is busy; retry at the next tool boundary');
  return staged;
}

// Claim only the bytes PostToolUse will render.  New PreToolUse writes go to
// a fresh pending file, so this Post cleanup cannot erase them.
export function claimStagedBatch(paths) {
  return withScratchLock(paths, () => {
    const prior = activeClaim(paths);
    if (prior) return isLiveClaim(prior) ? null : path.join(paths.dir, prior);
    try {
      const claim = path.join(paths.dir, claimFileName());
      fs.renameSync(paths.pending, claim);
      return claim;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  });
}

function ensurePendingScratch(paths) {
  const fd = fs.openSync(paths.pending, 'a', 0o600);
  fs.closeSync(fd);
}

// What PreToolUse and a parked Stop stage for the renderer: the message id and
// the bodyless context fields the daemon returned (older daemons return none).
const STAGED_CONTEXT_FIELDS = Object.freeze(['from', 'from_cwd', 'subject', 'thread_id', 'reply_required', 'notice', 'delegation_id', 'work_id', 'ack_pending']);

export function stagedNotificationEntry(attempt, source) {
  const entry = {
    message_id: source.message_id,
    attempt,
    has_external_origin: source.has_external_origin === true,
  };
  for (const field of STAGED_CONTEXT_FIELDS) if (source[field] !== undefined) entry[field] = source[field];
  return entry;
}

function stagedPresentationNotification(presentation) {
  return stagedNotificationEntry('initial', presentation);
}

function capturedWatermark(paths) {
  try {
    return fs.readFileSync(paths.watermark);
  } catch {
    return null;
  }
}

export function markCapturedWatermarkSeen(paths, watermark) {
  const temporary = `${paths.seen}.${process.pid}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, watermark);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(temporary, paths.seen);
  } catch (err) {
    try { fs.closeSync(fd); } catch {}
    fs.rmSync(temporary, { force: true });
    throw err;
  }
}

function ackHintPath(paths) {
  return path.join(paths.dir, 'ack.deadline.json');
}

function writeAckHint(paths, message) {
  if (typeof message.root_obligation_id !== 'string' || typeof message.ack_due_at !== 'string' || message.ack_accepted_at !== null) return;
  const dueAt = Date.parse(message.ack_due_at);
  if (!Number.isFinite(dueAt)) return;
  writeFilePrivate(ackHintPath(paths), `${JSON.stringify({ root_obligation_id: message.root_obligation_id, subject: message.conversation_subject ?? null, due_at: message.ack_due_at, due_at_epoch_ms: dueAt })}\n`);
}

function readAckHint(paths) {
  try {
    const hint = JSON.parse(fs.readFileSync(ackHintPath(paths), 'utf8'));
    return hint && typeof hint.root_obligation_id === 'string' ? hint : null;
  } catch {
    return null;
  }
}

async function reconcileAckHint(client, ctx) {
  const hint = readAckHint(ctx.paths);
  if (!hint) return;
  const chain = (await client.request('lifecycle.view', { root_obligation_id: hint.root_obligation_id })).chains?.[0];
  if (!chain || chain.status === 'done' || chain.ack_accepted_at || typeof chain.ack_due_at !== 'string') {
    fs.rmSync(ackHintPath(ctx.paths), { force: true });
    return;
  }
  writeAckHint(ctx.paths, { root_obligation_id: chain.root_obligation_id, ack_due_at: chain.ack_due_at, ack_accepted_at: chain.ack_accepted_at, conversation_subject: chain.subject });
}

/**
 * Records unparseable stage lines verbatim before the stage file is
 * cleared, and says so on stderr. The bytes are kept exactly as found:
 * a torn line is evidence of a lost delivery, and a summary of it is not.
 */
function quarantineTornLines(paths, lines) {
  const observedAt = new Date().toISOString();
  const record = lines.map((line) => `${JSON.stringify({ observed_at: observedAt, line })}\n`).join('');
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const fd = fs.openSync(paths.quarantine, 'a', 0o600);
  try {
    fs.writeFileSync(fd, record);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  process.stderr.write(
    `tightbeam: ${lines.length} torn line${lines.length === 1 ? '' : 's'} in ${paths.pending} could not be injected; ` +
      `the raw bytes are in ${paths.quarantine}\n`,
  );
}

// Stop delegates the owner-fenced decision to session.stop. Exit 2 blocks;
// allow idles the endpoint. Explicit waits use a brief guard and exact action
// outcome handoff; the legacy and background lanes retain their old contract.

// Keep each force-allow as a separate local diagnostic record.
function writeUnresolvedDiagnostic(ctx, endpoint, decision) {
  const record = {
    event: 'obligation_unresolved',
    at: new Date().toISOString(),
    session_id: ctx.identity.session_id,
    endpoint_id: endpoint.endpoint_id,
    principal_id: endpoint.principal_id,
    obligation_ids: decision.obligation_ids,
  };
  fs.mkdirSync(ctx.paths.dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(ctx.paths.dir, 'unresolved-obligations.jsonl'), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return record;
}

function renderForcedAllowNotice(decision) {
  // Same bound as the daemon's block reason (renderUnsafeReason): the wedge
  // that exhausts the budget is exactly the longest-list case, and stderr
  // feeds the model.
  const ids = decision.obligation_ids;
  const rows = ids
    .slice(0, 10)
    .map((id) => `  - ${id}`)
    .join('\n');
  const more = ids.length > 10 ? `\n  ...and ${ids.length - 10} more` : '';
  return (
    `[tightbeam] ${ids.length} obligation(s) are still unresolved after repeated blocked stops:\n${rows}${more}\n` +
    'Allowing this stop so you are not wedged. The work stays open and a durable unresolved ' +
    'diagnostic has been written to this session\'s unresolved-obligations.jsonl.'
  );
}

const LISTENER_HEARTBEAT_MS = 5_000;

function listenerFence(endpoint, decision) {
  return {
    endpoint_id: endpoint.endpoint_id,
    process_generation: decision.process_generation ?? endpoint.process_generation,
    listener_id: decision.listener_id,
    listener_generation: decision.listener_generation,
  };
}

function continuationFor(entry) {
  const prompt = renderInjection([entry]);
  return {
    continue: true,
    decision: 'block',
    reason: prompt,
    suppressOutput: false,
    systemMessage: prompt,
  };
}

/** Attach the admitted park, stage and ACK presentations, then emit. */
function holdParkedListener(client, { endpoint, decision, ctx, append, timers, emit, hostProbe = null, alreadyWoke = null, backgroundItems = null, logPrefix }) {
  const fence = listenerFence(endpoint, decision);
  const deadlineMs = Date.parse(decision.park_deadline_at);
  const waitMs = Number.isFinite(deadlineMs) ? Math.max(1, deadlineMs - Date.now()) : 1;
  const log = (suffix, fields = {}) => debugLog({ event: `${logPrefix}_${suffix}`, listener_id: fence.listener_id, ...fields });
  let settled = false;
  let presenting = false;
  let heartbeat = null;
  let timeout = null;
  let resolveWait;
  const result = new Promise((resolve) => {
    resolveWait = resolve;
  });

  const finish = (value) => {
    if (settled) return;
    settled = true;
    if (heartbeat) timers.clearInterval(heartbeat);
    if (timeout) timers.clearTimeout(timeout);
    resolveWait(value);
  };
  const end = async (terminalReason) => {
    log('ended', { reason: terminalReason });
    try {
      await client.endListener({ ...fence, terminal_reason: terminalReason });
    } catch (error) {
      // If this connection is already gone, the daemon reconciler owns the
      // sole fallback. A hook must never manufacture a second one.
      log('end_unavailable', { error: error.code || error.message });
    }
  };
  // `connection_lost` is the reason the reconciler itself uses when a
  // holder disappears: pending presentations take the daemon's miss path.
  const hostLost = async (at) => {
    log('host_lost', { at, status: 'warn' });
    await end('connection_lost');
    finish(null);
  };

  // A duplicate is ACKed, not left pending: an unACKed presentation would run
  // the daemon's deadline/miss path and fall back for a message this session
  // was already woken for. Nothing is staged and nothing is emitted.
  const acknowledgeDuplicate = async (presentation) => {
    await client.acknowledgeListener({ ...fence, presentation_id: presentation.presentation_id });
    log('duplicate_suppressed', {
      message_id: presentation.message_id,
      presentation_id: presentation.presentation_id,
      endpoint_id: fence.endpoint_id,
      process_generation: fence.process_generation,
      status: 'warn',
    });
    finish({ woke: false, suppressed: 'duplicate', message_id: presentation.message_id });
  };

  client.on('event', async (event, presentation) => {
    if (settled || presenting || event !== 'listener.presentation') return;
    if (
      (presentation.listener_id && presentation.listener_id !== fence.listener_id) ||
      (presentation.listener_generation && presentation.listener_generation !== fence.listener_generation) ||
      typeof presentation.presentation_id !== 'string' || typeof presentation.message_id !== 'string'
    ) return;
    presenting = true;
    let staged = null;
    try {
      if (alreadyWoke?.(presentation.message_id)) {
        await acknowledgeDuplicate(presentation);
        return;
      }
      if (hostProbe && !hostProbe.alive({ strict: true })) {
        await hostLost('before_stage');
        return;
      }
      const entry = stagedPresentationNotification(presentation);
      append(ctx.paths, entry);
      staged = entry;
      await client.acknowledgeListener({ ...fence, presentation_id: presentation.presentation_id });
      // A heartbeat failure, host loss, or park expiry may have ended this
      // listener while the ACK was in flight; an ended listener never wakes.
      if (settled) {
        log('presentation_after_end', { message_id: entry.message_id, presentation_id: presentation.presentation_id, status: 'warn' });
        return;
      }
      log('presented', { message_id: entry.message_id, presentation_id: presentation.presentation_id });
      finish(emit(entry));
    } catch (error) {
      log('delivery_failed', { error: error.code || error.message, woke: staged !== null && !settled, status: 'warn' });
      await end('presentation_failed');
      // A refused ACK (usually past the daemon's 1.5 s deadline under load) leaves
      // the daemon's miss path with nothing that wakes an idle session. The entry
      // is durable, so wake anyway: a spurious wake is cheap and `agent receive`
      // still owns delivery.
      finish(staged && !settled ? emit(staged) : null);
    }
  });

  const renew = async () => {
    if (settled) return;
    if (hostProbe && !hostProbe.alive()) {
      await hostLost('heartbeat');
      return;
    }
    try {
      await client.heartbeatListener(fence);
    } catch (error) {
      log('heartbeat_failed', { error: error.code || error.message });
      await end('connection_lost');
      finish(null);
      return;
    }
    if (backgroundItems) await releaseIfBackgroundFinished();
  };

  // Codex background wait: each renew re-evaluates the Stop's pending work
  // and, once none remains, ends the listener and continues the turn once.
  let pendingCount = backgroundItems?.length;
  let evaluationError = null;
  // An unreadable pending-bg state never ends the hold: it keeps waiting for a
  // later readable evaluation, a presentation, or the deadline.
  const evaluatePendingBackground = () => {
    try {
      const evaluation = openPendingBackground(ctx);
      if (evaluationError) log('background_readable', { previous_error: evaluationError });
      evaluationError = null;
      return evaluation;
    } catch (error) {
      const code = error.code || error.message;
      if (evaluationError !== code) log('background_unreadable', { status: 'error', error: code, stack: error.stack });
      evaluationError = code;
      return null;
    }
  };
  const releaseIfBackgroundFinished = async () => {
    if (settled || presenting) return;
    const evaluation = evaluatePendingBackground();
    if (!evaluation) return;
    const { items, completed, stale } = evaluation;
    if (items.length !== pendingCount) {
      pendingCount = items.length;
      log('background_pending', { pending: items.length, completed, stale });
    }
    if (items.length > 0) return;
    // Claims the listener: a presentation racing the end takes the daemon's miss path.
    presenting = true;
    const ids = backgroundItems.map((item) => item.id).join(', ');
    log('background_finished', { items: backgroundItems.length, reason: stale > 0 ? 'stale' : 'finished' });
    await end('background_wait_ended');
    finish({ decision: 'block', reason: `Background work finished: ${ids}` });
  };

  const attach = async () => {
    try {
      await client.attachListener(fence);
      log('attached', { listener_generation: fence.listener_generation });
    } catch (error) {
      log('attach_failed', { error: error.code || error.message });
      await end('hook_error');
      finish(null);
      return;
    }
    if (settled) return;
    heartbeat = timers.setInterval(renew, LISTENER_HEARTBEAT_MS);
    timeout = timers.setTimeout(async () => {
      await end('park_expired');
      finish(null);
    }, waitMs);
  };
  attach();
  return result;
}

/** stop-hold: the synchronous Stop hook returns the continuation itself. */
export async function holdParkedStop(client, { endpoint, decision, ctx, append = appendStagedEntry, timers = globalThis, backgroundItems = null } = {}) {
  return holdParkedListener(client, { endpoint, decision, ctx, append, timers, emit: continuationFor, backgroundItems, logPrefix: 'stop_listener' });
}

// The model sees this stderr verbatim, framed by the host as a "Stop hook
// blocking error", so it leads with what actually happened.
const WAKE_LEAD = 'Tightbeam: a new message arrived for this session.';

// background-hook: an async-rewake hook wakes the idle session by exiting 2
// with the arrival text on stderr. Called only after stage and ACK succeed.
function wakeEmitter(entry) {
  process.stderr.write(`${WAKE_LEAD}\n${renderInjection([entry])}\n`);
  process.exitCode = 2;
  return { woke: true, message_id: entry.message_id };
}

/**
 * background-hook: holds the park the `stop --handoff` gate recorded and,
 * on a presentation, wakes the idle session. Every other outcome — expiry,
 * a busy session ending the listener, a superseded fence, a lost host —
 * resolves `{ woke: false }` with nothing on stderr and exit 0.
 */
export async function listenForWake(client, { record, ctx, hostProbe, append = appendStagedEntry, timers = globalThis }) {
  const decision = { ...record.fence, park_deadline_at: record.park_deadline_at };
  const generation = { endpoint_id: record.endpoint.endpoint_id, process_generation: listenerFence(record.endpoint, decision).process_generation };
  const emit = (entry) => {
    const woke = wakeEmitter(entry);
    recordWake(ctx.paths, { ...generation, message_id: entry.message_id });
    return woke;
  };
  const woke = await withDebugOffWakeChannel(() => holdParkedListener(client, {
    endpoint: record.endpoint, decision, ctx, append, timers, emit, hostProbe, logPrefix: 'wake_listen',
    alreadyWoke: (messageId) => hasWoken(ctx.paths, { ...generation, message_id: messageId }),
  }));
  return woke ?? { woke: false };
}

// ---------------------------------------------------------------------
// The wake ledger (version skew, D2/D3). Invariant: one listener never wakes
// the session twice for the same message within one endpoint process
// generation, whatever the daemon version. A current daemon never re-presents
// an ACKed delivery at Stop, so this guard never triggers against it. An
// older daemon (before 5e72c235) re-presents an ACKed-but-unreceived message
// at every Stop; without this ledger each Stop pair re-woke the session for
// it forever. Each listener is a fresh process, so the memory of what already
// woke lives in the session's private dir.
//
// Degraded skew-window behavior, accepted and bounded: against that older
// daemon the suppressing listener still ACKs, which marks the endpoint busy
// while the host is actually idle. A new message then queues without a live
// wake until the next turn or tool boundary delivers it. Only the stop-hold
// emitter (`stop` without --handoff) skips this ledger: it is unchanged by
// design and does not use the background wake path.
const WAKE_LEDGER_LIMIT = 64;

function wakeLedgerPath(paths) {
  return path.join(paths.dir, 'wake-ledger.json');
}

function readWakeLedger(paths) {
  try {
    const ledger = JSON.parse(fs.readFileSync(wakeLedgerPath(paths), 'utf8'));
    if (Array.isArray(ledger?.entries)) return ledger.entries;
  } catch (error) {
    // No ledger is normal before the first wake. A damaged one fails open:
    // a possible duplicate wake beats a missed one, and the next wake rewrites it.
    if (error.code !== 'ENOENT') debugLog({ event: 'wake_ledger_unreadable', error: error.code || error.message, status: 'warn' });
  }
  return [];
}

function sameWake(entry, wake) {
  return entry?.endpoint_id === wake.endpoint_id && entry.process_generation === wake.process_generation && entry.message_id === wake.message_id;
}

function hasWoken(paths, wake) {
  return readWakeLedger(paths).some((entry) => sameWake(entry, wake));
}

// Called only after the wake was emitted. A failed write only weakens the
// guard against an older daemon; it must never undo the wake already sent.
function recordWake(paths, wake) {
  const entries = [...readWakeLedger(paths), { ...wake, woke_at: new Date().toISOString() }].slice(-WAKE_LEDGER_LIMIT);
  const file = wakeLedgerPath(paths);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFilePrivate(temp, `${JSON.stringify({ version: 1, entries })}\n`);
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    debugLog({ event: 'wake_ledger_write_failed', message_id: wake.message_id, error: error.code || error.message, status: 'warn' });
  }
}

// ---------------------------------------------------------------------
// The Stop handoff (idle-wake background-hook, D2). The `stop --handoff`
// gate and the async `wake-listen` hook start in the same millisecond with
// byte-identical stdin, so the gate records its decision in a private
// per-session file keyed by sha256 of those exact bytes and the listener
// waits a bounded time for it. No daemon operation is involved.
// ---------------------------------------------------------------------

const HANDOFF_DIR = 'stop-handoff';
const HANDOFF_RECORD_VERSION = 1;
// Keys are unique per Stop, so a record is read once within seconds; any
// older one is debris from a listener that never ran.
const HANDOFF_TTL_MS = 5 * 60 * 1000;
const HANDOFF_WAIT_MS = 10_000;
const HANDOFF_POLL_MS = 50;
const HANDOFF_DECISIONS = new Set(['park', 'block', 'allow', 'error']);
const HANDOFF_KEY = /^[0-9a-f]{64}$/;

export function stopHandoffKey(raw) {
  return createHash('sha256').update(raw).digest('hex');
}

function handoffDir(paths) {
  return path.join(paths.dir, HANDOFF_DIR);
}

function pruneStopHandoffs(dir, nowMs) {
  let pruned = 0;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    try {
      if (nowMs - fs.lstatSync(file).mtimeMs <= HANDOFF_TTL_MS) continue;
      fs.rmSync(file, { force: true });
      pruned += 1;
    } catch {
      // Pruning is hygiene; a concurrent consumer may already have it.
    }
  }
  return pruned;
}

/** Atomically (temp + fsync + rename) writes this Stop's 0600 handoff record. */
function writeStopHandoff(ctx, fields) {
  const key = ctx.stdinKey;
  if (!HANDOFF_KEY.test(key ?? '')) throw new HookError('the Stop handoff has no stdin key');
  const dir = handoffDir(ctx.paths);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pruned = pruneStopHandoffs(dir, Date.now());
  const record = { version: HANDOFF_RECORD_VERSION, key, written_at: new Date().toISOString(), session_id: ctx.identity.session_id, ...fields };
  const temporary = path.join(dir, `.${key}.${process.pid}.${randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    // Overwrites a byte-identical earlier Stop's record: the newest wins.
    fs.renameSync(temporary, path.join(dir, `${key}.json`));
  } catch (error) {
    try { fs.closeSync(fd); } catch {}
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  debugLog({ event: 'stop_handoff_written', session_id: ctx.identity.session_id, key: key.slice(0, 12), decision: record.decision, pruned });
}

// A failed `stop --handoff` gate records `error` so its wake listener exits
// at once instead of waiting out its bound; the gate still fails as before.
function recordGateFailure(verb, ctx) {
  if (verb === 'stop' && ctx.handoff === true) recordStopHandoffBestEffort(ctx, { decision: 'error' });
}

// block/allow/error records only let the listener exit early; losing one
// costs the listener its bounded wait, never the gate's own decision.
function recordStopHandoffBestEffort(ctx, fields) {
  try {
    writeStopHandoff(ctx, fields);
  } catch (error) {
    debugLog({ event: 'stop_handoff_write_failed', session_id: ctx.identity.session_id, decision: fields.decision, error: error.code || error.message, status: 'warn' });
  }
}

function claimStopHandoff(file) {
  const claimed = `${file}.${process.pid}.${randomUUID()}.claimed`;
  try {
    fs.renameSync(file, claimed);
    return claimed;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function readClaimedHandoff(claimed, key) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(claimed, 'utf8'));
  } catch {
    return { status: 'invalid', record: null };
  } finally {
    fs.rmSync(claimed, { force: true });
  }
  if (record?.version !== HANDOFF_RECORD_VERSION || record.key !== key || !HANDOFF_DECISIONS.has(record.decision)) return { status: 'invalid', record: null };
  const age = Date.now() - Date.parse(record.written_at);
  if (!Number.isFinite(age) || age > HANDOFF_TTL_MS) return { status: 'stale', record: null };
  return { status: 'ok', record };
}

/**
 * Waits up to `waitMs` for this Stop's handoff record and consumes it
 * (claim by rename, then unlink) so it is never re-used. Resolves
 * `{ status: 'ok' | 'missing' | 'invalid' | 'stale', record }`.
 */
export async function consumeStopHandoff(paths, key, { waitMs = HANDOFF_WAIT_MS, pollMs = HANDOFF_POLL_MS } = {}) {
  const file = path.join(handoffDir(paths), `${key}.json`);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const claimed = claimStopHandoff(file);
    if (claimed) return readClaimedHandoff(claimed, key);
    if (Date.now() >= deadline) return { status: 'missing', record: null };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Whether the runtime that will receive a wake is still there. A SIGKILLed
 * Claude orphans its async hooks (reparented to pid 1) and their exit 2 goes
 * nowhere, so a listener that staged and ACKed then would claim a
 * presentation nobody saw. Two signals, cheapest first:
 *   - this process's parent changed or became pid 1 (no spawn);
 *   - the session's owner process (the same capture SessionStart registers)
 *     no longer exists (signal 0), or — strictly, before staging — its pid
 *     now names a different process (OS start identity, one `ps`).
 * Without a captured owner the parent check stands alone.
 */
export function createHostProbe({
  runtime,
  sessionId,
  cwd,
  parentProcessId = () => process.ppid,
  capture = captureOwnerProcess,
  kill = (pid) => process.kill(pid, 0),
  observe = observeProcessRow,
  log,
} = {}) {
  const initialParent = parentProcessId();
  const owner = capture({ runtime, sessionId, cwd, parentProcessId: initialParent, log });
  const ownerGone = () => {
    try {
      kill(owner.pid);
      return false;
    } catch (error) {
      return error.code === 'ESRCH';
    }
  };
  const ownerReplaced = () => {
    try {
      const row = observe(owner.pid);
      return row === null || row.startIdentity !== owner.start_identity;
    } catch {
      // ps failing right after signal 0 succeeded is a race, not evidence.
      return false;
    }
  };
  return {
    owner,
    alive({ strict = false } = {}) {
      const parent = parentProcessId();
      if (parent <= 1 || parent !== initialParent) return false;
      if (!owner) return true;
      if (ownerGone()) return false;
      return !(strict && ownerReplaced());
    },
  };
}

// ---------------------------------------------------------------------
// The verbs
// ---------------------------------------------------------------------

export const HANDLERS = {
  async 'session-start'(client, ctx) {
    const endpoint = await registerSession(client, ctx);
    let recovery = '';
    let recoveryBlocked = false;
    if (typeof endpoint.recovery_resume_request_id === 'string') {
      try {
        let context = recoveryStage(ctx.paths, endpoint);
        if (!context) {
          context = await client.request('recovery.context', {
            resume_request_id: endpoint.recovery_resume_request_id,
            endpoint_id: endpoint.endpoint_id,
          });
          writeFilePrivate(ctx.paths.recovery ?? path.join(ctx.paths.dir ?? path.dirname(ctx.paths.endpoint), 'recovery-context.json'), `${JSON.stringify({
            resume_request_id: endpoint.recovery_resume_request_id,
            endpoint_id: endpoint.endpoint_id,
            context: sanitizedRecoveryContext(context),
          })}\n`);
        }
        await client.request('recovery.retry', {
          root_obligation_id: context.root.root_obligation_id,
          root_generation: context.root.generation,
          target_endpoint_id: endpoint.endpoint_id,
          target_process_generation: endpoint.process_generation,
          // The durable replacement request is the one-shot recovery action
          // identity. A hook replay after a crash gets the same attempt,
          // never a sibling owner.
          idempotency_key: `replacement:${endpoint.recovery_resume_request_id}`,
        });
        recovery = `${renderRecoveryContext(context, await readAdoptionLines(client, endpoint))}\n\n`;
      } catch (error) {
        // The daemon records incomplete lineage during admission.  The hook
        // must not invent a partial transcript or silently treat the fresh
        // session as a replacement owner.
        debugLog({ event: 'recovery_context_blocked', endpoint_id: endpoint.endpoint_id, error: error.code || error.message });
        recovery = '<tightbeam_recovery_blocked>Replacement recovery context is incomplete. Do not act on the prior work; it remains open for operator recovery.</tightbeam_recovery_blocked>\n\n';
        recoveryBlocked = true;
      }
    }
    if (recoveryBlocked) {
      return {
        ...endpoint,
        output: { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: recovery.trimEnd() } },
      };
    }
    const catalog = await client.request('channel.route.list', {
      available_only: true,
      required_capability: 'send',
    });
    return {
      ...endpoint,
      output: {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: `${recovery}${renderOutboundChannelCatalog(catalog.routes.filter(({ selector }) => routeOpenTo(selector, ctx.identity?.academy_agent_name)))}`,
        },
      },
    };
  },

  async 'user-prompt-submit'(client, ctx) {
    return setEndpointState(client, ctx, 'busy');
  },

  async stop(client, ctx) {
    try {
      return await gateStop(client, ctx);
    } catch (error) {
      recordGateFailure('stop', ctx);
      throw error;
    }
  },

  'wake-listen'(client, ctx) {
    return listenForWake(client, { record: ctx.handoffRecord, ctx, hostProbe: ctx.hostProbe });
  },

  async 'pre-tool-use'(client, ctx) {
    await reconcileAckHint(client, ctx);
    const watermark = capturedWatermark(ctx.paths);
    if (!watermark) return { staged: 0, message_ids: [] };
    const endpoint = await resolveSessionEndpoint(client, ctx);
    if (!Number.isSafeInteger(endpoint.process_generation) || endpoint.process_generation < 1) {
      throw new HookError('the cached session endpoint has no exact process generation');
    }
    const notification = await client.request('message.notification.next', {
      endpoint_id: endpoint.endpoint_id,
      process_generation: endpoint.process_generation,
      provider_session_id: ctx.identity.session_id,
    });
    if (typeof notification.message_id === 'string' && (notification.attempt === 'initial' || notification.attempt === 'retry')) {
      appendStagedEntry(ctx.paths, stagedNotificationEntry(notification.attempt, notification));
      // Never re-read `inbox.watermark` here.  A daemon write during the
      // peek remains different from this captured value and wakes the next
      // tool boundary.
      markCapturedWatermarkSeen(ctx.paths, watermark);
      return { staged: 1, message_ids: [notification.message_id] };
    }
    markCapturedWatermarkSeen(ctx.paths, watermark);
    return { staged: 0, message_ids: [] };
  },
};

// A daemon older than background_wait refuses the field as malformed;
// retry once without it under the SAME key (its refusal wrote nothing), so
// the Stop behaves exactly as it did before the flag existed.
async function requestSessionStop(client, request, { backgroundWait, sessionId }) {
  if (!backgroundWait) return client.request('session.stop', request);
  try {
    return await client.request('session.stop', { ...request, background_wait: true });
  } catch (error) {
    if (error?.code !== 'malformed_request' || error?.details?.field !== 'background_wait') throw error;
    debugLog({ event: 'stop_gate_background_wait_unsupported', session_id: sessionId, endpoint_id: request.endpoint_id, result: 'retry_without_flag' });
    return client.request('session.stop', request);
  }
}

function currentActionId(ctx) {
  try {
    return fs.readFileSync(ctx.paths.action, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function currentWaitOutcome(ctx, endpoint) {
  const actionId = currentActionId(ctx);
  const session = {
    endpoint_id: endpoint.endpoint_id,
    process_generation: endpoint.process_generation,
    session_id: ctx.identity.session_id,
    agent_action_store_path: path.join(ctx.paths.dir, 'agent-actions.json'),
    pending_reply_guard: readCache(ctx.paths)?.pending_reply_guard,
  };
  return readCurrentWaitOutcome(session, actionId);
}

function setPendingReplyGuard(ctx, endpoint, decision) {
  const cached = readCache(ctx.paths);
  if (!cached || cached.endpoint_id !== endpoint.endpoint_id) return;
  const guard = decision?.wait_mode === 'explicit' && Array.isArray(decision.pending_references)
    ? {
        endpoint_id: endpoint.endpoint_id,
        provider_session_id: ctx.identity.session_id,
        process_generation: endpoint.process_generation,
        guard_stop_key: decision.guard_stop_key,
        pending_references: [...decision.pending_references].sort(),
      }
    : null;
  if (guard?.pending_references.length && typeof guard.guard_stop_key === 'string') cached.pending_reply_guard = guard;
  else delete cached.pending_reply_guard;
  writeFilePrivate(ctx.paths.endpoint, `${JSON.stringify(cached, null, 2)}\n`);
}

// An unreadable pending-bg must never skip the Stop gate: the Stop proceeds
// unflagged, exactly as it did before background_wait existed.
function readStopPendingBackground(ctx) {
  try {
    return openPendingBackground(ctx);
  } catch (error) {
    debugLog({ event: 'stop_gate_pending_bg_unreadable', session_id: ctx.identity.session_id, status: 'error', error: error.code || error.message, stack: error.stack });
    return null;
  }
}

/**
 * The Stop gate. Without `--handoff` (stop-hold, and every config installed
 * before idle wake) a park is held right here, exactly as before. With it
 * (background-hook) the gate records the decision for `wake-listen` and a
 * park returns at once, leaving the endpoint idle as the daemon set it.
 */
async function gateStop(client, ctx) {
  const handoff = ctx.handoff === true;
  const endpoint = await resolveSessionEndpoint(client, ctx);
  // One call decides everything: block with a bounded reason, or allow
  // with the endpoint already idled inside the same transaction. The key
  // makes THIS attempt replayable without burning the anti-wedge budget
  // twice; the cached process generation fences a stale process out.
  // Claude Stop entries of any type ask the daemon to keep a headless session parked.
  // Handoff only: the synchronous stop-hold has no way to end when the
  // background work does, so a flagged hold would sit to the park deadline.
  // Codex plain Stop waits on pending-bg items only for headless runs.
  // Interactive parks stay armed-only; no pending work means no second block.
  // Explicit Stop never holds: agents wait for messages with `agent wait`.
  const codexPending = !handoff && ctx.waitMode !== 'explicit' && ctx.identity.runtime === 'codex' && endpoint.launch_mode === 'non_interactive' ? readStopPendingBackground(ctx) : null;
  const backgroundWait = handoff
    ? Array.isArray(ctx.payload?.background_tasks) && ctx.payload.background_tasks.length > 0
    : codexPending?.items.length > 0;
  const waitOutcome = ctx.waitMode === 'explicit' ? currentWaitOutcome(ctx, endpoint) : null;
  const request = {
    endpoint_id: endpoint.endpoint_id,
    process_generation: endpoint.process_generation,
    idempotency_key: randomUUID(),
    ...(ctx.waitMode === 'explicit' ? { wait_mode: 'explicit' } : {}),
    ...(waitOutcome ? { wait_outcome: waitOutcome } : {}),
  };
  const decision = await requestSessionStop(client, request, { backgroundWait, sessionId: ctx.identity.session_id });
  if (ctx.waitMode === 'explicit') setPendingReplyGuard(ctx, endpoint, decision);
  if (ctx.waitMode === 'explicit' && decision.pending_references?.length) {
    decision.reason = ctx.identity.runtime === 'codex'
      ? decision.reason.replace(/Run .* agent wait and stop again after it returns\./u, tightbeamCodexWaitRecipe())
      : decision.reason.replace(
        `${tightbeamCommandName()} agent wait`,
        `${tightbeamRecipeCommand()} agent wait`,
      );
  }
  debugLog({
    event: 'stop_gate',
    session_id: ctx.identity.session_id,
    endpoint_id: endpoint.endpoint_id,
    background_wait: backgroundWait,
    ...(codexPending ? { pending_bg: codexPending.items.length, pending_bg_completed: codexPending.completed, pending_bg_stale: codexPending.stale } : {}),
    decision: decision.decision,
    escaped: decision.obligation_ids.length,
    handoff,
    idle_wake: handoff ? 'background-hook' : 'stop-hold',
  });

  if (decision.decision === 'block') {
    if (handoff) recordStopHandoffBestEffort(ctx, { decision: 'block' });
    // Exit 2 IS the block: Claude Code reads it as "block this turn"
    // and feeds stderr back to the model, and the JSON on stdout is the
    // same decision in the documented hook-output shape for a runtime
    // that reads stdout instead. Every other failure in this file stays
    // exit 1 for exactly the reason this path wants 2.
    process.stderr.write(`${decision.reason}\n`);
    process.exitCode = 2;
    return {
      blocked: true,
      endpoint_id: endpoint.endpoint_id,
      obligation_ids: decision.obligation_ids,
      output: { decision: 'block', reason: decision.reason },
    };
  }

  if (decision.decision === 'park' && handoff) {
    // Not best-effort: without this record nothing holds the park.
    writeStopHandoff(ctx, {
      decision: 'park',
      endpoint: { endpoint_id: endpoint.endpoint_id, principal_id: endpoint.principal_id, process_generation: endpoint.process_generation },
      fence: listenerFence(endpoint, decision),
      park_deadline_at: decision.park_deadline_at,
    });
    return { endpoint_id: endpoint.endpoint_id, state: 'idle', gate: 'park-handoff' };
  }

  if (decision.decision === 'park') {
    const continuation = await holdParkedStop(client, { endpoint, decision, ctx, backgroundItems: backgroundWait ? codexPending.items : null });
    return continuation
      ? { endpoint_id: endpoint.endpoint_id, state: 'busy', gate: 'park-continued', output: continuation }
      : { endpoint_id: endpoint.endpoint_id, state: 'idle', gate: 'park-ended' };
  }

  if (handoff) recordStopHandoffBestEffort(ctx, { decision: 'allow' });
  // A bounded allow names the work it escaped; a clean allow carries none.
  const forced = decision.obligation_ids.length > 0;
  if (forced) {
    writeUnresolvedDiagnostic(ctx, endpoint, decision);
    process.stderr.write(`${renderForcedAllowNotice(decision)}\n`);
  }
  return { endpoint_id: endpoint.endpoint_id, state: 'idle', gate: forced ? 'force-allow' : 'allow', obligation_ids: decision.obligation_ids };
}

// ---------------------------------------------------------------------
// pending-bg: Codex background work the Stop hold must wait for. Codex never
// fires PostToolUse for a background terminal and never fires SubagentStop
// for a child killed at parent exit, so each open item is one empty file,
// <session dir>/pending-bg/bash-<tool_use_id> or agent-<agent_id>.
// ---------------------------------------------------------------------

const PENDING_BG_KINDS = Object.freeze(['bash', 'agent']);

/**
 * Every open pending-bg item of one session, oldest first:
 * `[{ item: 'bash-call_1', kind: 'bash', id: 'call_1', created_at_ms }]`.
 * A missing directory is no items.
 */
export function listPendingBackground(paths) {
  let names;
  try {
    names = fs.readdirSync(paths.pendingBg);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const items = [];
  for (const item of names) {
    const dash = item.indexOf('-');
    const kind = item.slice(0, dash);
    if (dash < 1 || !PENDING_BG_KINDS.includes(kind)) continue;
    try {
      items.push({ item, kind, id: item.slice(dash + 1), created_at_ms: fs.statSync(path.join(paths.pendingBg, item)).mtimeMs });
    } catch (error) {
      // Deleted between readdir and stat: the item just finished.
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return items.sort((a, b) => a.created_at_ms - b.created_at_ms);
}

// shortcut: an item older than this is an orphan (a child killed at parent
// exit fires no SubagentStop); revisit if legitimate jobs outlast it.
export const PENDING_BG_STALE_MS = 30 * 60 * 1000;

function addCompletedItemId(ids, line) {
  if (!line.includes('"item_completed"')) return;
  try {
    const { payload } = JSON.parse(line);
    if (payload?.type === 'item_completed' && typeof payload.item?.id === 'string') ids.add(payload.item.id);
  } catch {
    // A line Codex is still writing; the next evaluation reads it whole.
  }
}

// Reads the rollout bytes appended since the last call into `tail`
// ({ offset, partial, ids }); a file shorter than the offset is a new rollout.
function readRolloutTail(file, tail) {
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    if (size < tail.offset) Object.assign(tail, { offset: 0, partial: Buffer.alloc(0), ids: new Set() });
    const appended = Buffer.alloc(size - tail.offset);
    let read = 0;
    while (read < appended.length) {
      const n = fs.readSync(fd, appended, read, appended.length - read, tail.offset + read);
      if (n === 0) break;
      read += n;
    }
    tail.offset += read;
    // Split on the newline byte, so a multi-byte character is never cut in two.
    const bytes = Buffer.concat([tail.partial, appended.subarray(0, read)]);
    const end = bytes.lastIndexOf(0x0a) + 1;
    for (const line of bytes.subarray(0, end).toString('utf8').split('\n')) addCompletedItemId(tail.ids, line);
    tail.partial = bytes.subarray(end);
  } finally {
    fs.closeSync(fd);
  }
}

// Ids of the rollout's `item_completed` records: a background terminal's
// only end signal (id == its PreToolUse tool_use_id). Null when unreadable.
// Each call reads only what was appended since the previous call on this
// ctx (one Stop hold), so the five-second tick costs the new bytes only.
function completedTranscriptItemIds(ctx) {
  ctx.rolloutTail ??= { offset: 0, partial: Buffer.alloc(0), ids: new Set() };
  try {
    readRolloutTail(ctx.payload?.transcript_path, ctx.rolloutTail);
  } catch (error) {
    debugLog({ event: 'pending_bg_transcript_unreadable', session_id: ctx.identity.session_id, status: 'error', error: error.code || error.message, stack: error.stack });
    return null;
  }
  // A final line with no newline yet may already be whole.
  const ids = new Set(ctx.rolloutTail.ids);
  addCompletedItemId(ids, ctx.rolloutTail.partial.toString('utf8'));
  return ids;
}

/**
 * The background work a Codex Stop still waits for: this session's pending
 * items minus stale orphans and minus Bash items the rollout reports
 * completed (both of whose files are removed). Agent items end only by SubagentStop.
 * An unreadable transcript keeps every Bash item counted.
 */
export function openPendingBackground(ctx, { now = Date.now() } = {}) {
  const fresh = [];
  let stale = 0;
  for (const item of listPendingBackground(ctx.paths)) {
    if (now - item.created_at_ms >= PENDING_BG_STALE_MS) {
      updatePendingBackground(ctx, item.kind, item.id, 'delete');
      stale += 1;
    } else {
      fresh.push(item);
    }
  }
  const completedIds = fresh.some((item) => item.kind === 'bash') ? completedTranscriptItemIds(ctx) : null;
  const items = [];
  let completed = 0;
  for (const item of fresh) {
    if (item.kind === 'bash' && completedIds?.has(item.id)) {
      updatePendingBackground(ctx, 'bash', item.id, 'delete');
      completed += 1;
    } else {
      items.push(item);
    }
  }
  return { items, completed, stale };
}

// A tracking failure is reported, never fatal: it must not cost the tool
// boundary its message drain or injection.
function updatePendingBackground(ctx, kind, id, action) {
  const item = `${kind}-${id}`;
  const fields = { session_id: ctx.identity.session_id, item };
  try {
    if (action === 'create') {
      fs.mkdirSync(ctx.paths.pendingBg, { recursive: true, mode: 0o700 });
      fs.closeSync(fs.openSync(path.join(ctx.paths.pendingBg, item), 'a', 0o600));
      debugLog({ event: 'pending_bg_created', ...fields });
      return;
    }
    fs.unlinkSync(path.join(ctx.paths.pendingBg, item));
    debugLog({ event: 'pending_bg_deleted', ...fields });
  } catch (error) {
    if (action === 'delete' && error.code === 'ENOENT') {
      debugLog({ event: 'pending_bg_deleted', ...fields, result: 'absent' });
      return;
    }
    debugLog({ event: 'pending_bg_failed', ...fields, action, status: 'error', error: error.code || error.message, stack: error.stack });
    process.stderr.write(`tightbeam: could not ${action} background item ${item}: ${error.code || error.message}\n`);
  }
}

// SubagentStart/SubagentStop: Codex only (Claude's Stop input lists its own
// background tasks). Local file work; no daemon contact.
function trackCodexSubagent(verb, ctx) {
  const agentId = ctx.payload.agent_id;
  if (ctx.identity.runtime !== 'codex' || !isSafeSessionId(agentId)) {
    debugLog({ event: 'pending_bg_skipped', verb, session_id: ctx.identity.session_id, runtime: ctx.identity.runtime, reason: ctx.identity.runtime !== 'codex' ? 'not_codex' : 'unsafe_agent_id', status: 'warn' });
    return { tracked: false };
  }
  updatePendingBackground(ctx, 'agent', agentId, verb === 'subagent-start' ? 'create' : 'delete');
  return { tracked: true };
}

function currentWaitMessage(ctx, cached, actionId) {
  if (!cached || !actionId) return null;
  try {
    return readWaitMessage({
      endpoint_id: cached.endpoint_id,
      process_generation: cached.process_generation,
      session_id: ctx.identity.session_id,
      agent_action_store_path: path.join(ctx.paths.dir, 'agent-actions.json'),
    }, actionId);
  } catch (error) {
    debugLog({ event: 'wait_message_lookup_failed', session_id: ctx.identity.session_id, error: error.code || error.message });
    return null;
  }
}
const toolActionId = (ctx) => (ctx.payload.tool_use_id === undefined ? currentActionId(ctx) : isSafeSessionId(ctx.payload.tool_use_id) ? ctx.payload.tool_use_id : null);
// PostToolUse touches no socket at all — it renders what PreToolUse already staged locally (zero IPC).
async function runPostToolUse(ctx) {
  // A subagent's tool call carries the parent's session_id plus agent_id.
  // Its PostToolUse must not claim the parent's staged messages: the main
  // agent's next PostToolUse (e.g. PostToolUse:Agent on return) injects them.
  if (ctx.payload.agent_id) {
    debugLog({ event: 'inject_skipped_subagent', session_id: ctx.identity.session_id, agent_type: ctx.payload.agent_type ?? null });
    return { injected: 0, quarantined: 0, output: null, subagent: true };
  }
  const claimed = claimStagedBatch(ctx.paths);
  if (!claimed) {
    debugLog({ event: 'inject_skipped', session_id: ctx.identity.session_id });
    return { injected: 0, quarantined: 0, output: null };
  }
  const { entries, torn } = readStagedEntries(ctx.paths, claimed);
  const cached = readCache(ctx.paths);
  const waitedMessage = currentWaitMessage(ctx, cached, toolActionId(ctx));
  const visibleEntries = waitedMessage ? entries.filter((entry) => entry.message_id !== waitedMessage) : entries;
  if (entries.length === 0 && torn.length === 0) {
    fs.rmSync(claimed, { force: true });
    debugLog({ event: 'inject_skipped', session_id: ctx.identity.session_id });
    return { injected: 0, quarantined: 0, output: null };
  }
  // Before the truncation below can destroy them, and before an injection
  // can fail: whatever else happens to this boundary, the bytes survive.
  if (torn.length > 0) {
    quarantineTornLines(ctx.paths, torn);
    debugLog({ event: 'inject_quarantined', session_id: ctx.identity.session_id, lines: torn.length });
  }
  const output =
    visibleEntries.length === 0
      ? null
      : { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: renderInjection(visibleEntries, { prefix: ctx.recipePrefix }) } };
  // Truncate only after rendering succeeded, so a crash mid-render leaves
  // the staged messages to be injected at the next tool boundary.
  const commitOutput = () => {
    fs.rmSync(claimed, { force: true });
    // Create only if PreToolUse did not open the successor file; append mode cannot truncate a notification staged meanwhile.
    ensurePendingScratch(ctx.paths);
  };
  if (!ctx.deferOutputCommit || output === null) commitOutput();
  debugLog({ event: 'inject_emitted', session_id: ctx.identity.session_id, messages: visibleEntries.length, suppressed_wait_message: Boolean(waitedMessage), quarantined: torn.length });
  return { injected: visibleEntries.length, quarantined: torn.length, output, ...(ctx.deferOutputCommit && output !== null ? { commitOutput } : {}) };
}

/**
 * `wake-listen` before it touches the daemon: wait for and consume this
 * Stop's handoff record, then confirm the host that would receive a wake is
 * still there. Returns `{ result }` to exit 0 silently, or the park record
 * and host probe to hold.
 */
async function prepareWakeListen(ctx) {
  const sessionId = ctx.identity.session_id;
  const key = ctx.stdinKey.slice(0, 12);
  const startedAt = Date.now();
  debugLog({ event: 'wake_listen_started', session_id: sessionId, key });
  const { status, record } = await consumeStopHandoff(ctx.paths, ctx.stdinKey);
  if (!record) {
    debugLog({ event: 'wake_listen_no_record', session_id: sessionId, key, result: status, latency: Date.now() - startedAt, status: 'warn' });
    return { result: { woke: false, handoff: status } };
  }
  if (record.decision !== 'park') {
    debugLog({ event: 'wake_listen_ended', session_id: sessionId, key, reason: `gate_${record.decision}` });
    return { result: { woke: false, decision: record.decision } };
  }
  const hostProbe = createHostProbe({
    runtime: ctx.identity.runtime,
    sessionId,
    cwd: ctx.identity.cwd,
    log: (fields) => debugLog({ ...fields, session_id: sessionId }),
  });
  if (!hostProbe.alive()) {
    debugLog({ event: 'wake_listen_host_lost', session_id: sessionId, listener_id: record.fence?.listener_id, at: 'start', status: 'warn' });
    return { result: { woke: false, host_lost: true } };
  }
  return { record, hostProbe };
}

/**
 * Runs one hook verb end to end: resolve identity, resolve credentials,
 * connect if the verb needs the daemon, dispatch, and return a result the
 * CLI prints only under --json (a SessionStart hook's stdout is injected
 * into the session's context, so quiet is the correct default).
 *
 * `registry` is the caller's createRuntimeRegistry instance scoped to its
 * state root; without one, identity resolves against the builtins only.
 */
export function runHookVerb(verb, options = {}) {
  if (verb === 'wake-listen') return withDebugOffWakeChannel(() => runResolvedHookVerb(verb, options));
  return runResolvedHookVerb(verb, options);
}

async function runResolvedHookVerb(verb, { stateRoot, flags = {}, env = process.env, stdin, registry, socketPath } = {}) {
  if (!HOOK_EVENT_VERBS.includes(verb)) {
    throw new HookError(`unknown hook event: ${verb} (expected one of ${HOOK_EVENT_VERBS.join(', ')})`);
  }

  const delivered = stdin === undefined ? readStdinSync() : { text: stdin, complete: true };
  // The Stop gate and its wake listener get byte-identical stdin; both key
  // their handoff on these exact bytes, never on a re-serialized payload.
  const stdinKey = stopHandoffKey(delivered.raw ?? Buffer.from(delivered.text ?? '', 'utf8'));
  const { status, payload, bytes } = classifyHookPayload(delivered);
  debugLog({ event: 'hook_stdin', verb, status, bytes });
  if (status !== 'empty' && status !== 'ok') {
    // The env chain is refused here on purpose. A `claude -p` child
    // inherits its PARENT's session id in the environment, so falling
    // back on a damaged payload would register the child's endpoint —
    // and later idle it mid-turn — under the parent's live session.
    // Failing is what this design already does with a session id it
    // cannot resolve.
    throw new HookError(
      `the hook payload on stdin was ${status === 'truncated' ? 'never fully delivered' : 'not a JSON object'} ` +
        `(${bytes} bytes read); refusing to fall back to the environment session id, which in a nested ` +
        "session is the PARENT's",
    );
  }
  const explicitRuntime = flags.runtime || env.TIGHTBEAM_RUNTIME;
  const copilotRuntime = boundCopilotRuntime({ explicitRuntime, registry });
  const isCopilot = copilotRuntime !== null;
  const copilotInput = isCopilot ? decodeCopilotHookInput(verb, payload) : null;
  if (copilotInput?.child) return { skipped: true, subagent: true };
  if (copilotInput?.streamEvent) throw new HookError(`Copilot stream event ${copilotInput.event} cannot be handled as callback ${verb}`);
  if (copilotInput && copilotInput.sessionId === undefined) throw new HookError(`Copilot ${copilotInput.event} requires its actual session UUID`);
  if (copilotInput && !copilotInput.streamEvent && copilotInput.event !== ({
    'session-start': 'sessionStart',
    'user-prompt-submit': 'userPromptSubmitted',
    'post-tool-use': 'postToolUse',
  })[verb]) throw new HookError(`Copilot callback event does not match hook verb ${verb}`);
  const hookPayload = copilotInput?.payload ?? payload;
  // Copilot callbacks validate their own identity before this incumbent bootstrap path.
  let credentials = readHookCredentials(stateRoot);
  if (requiresExplicitCopilotRuntime({ explicitRuntime, credentials, payload: hookPayload, env, registry })) throw new HookError('Copilot hook requires an explicit --runtime binding; pass --runtime instead of relying on runtime inference or credentials');
  if (verb === 'session-start' && socketPath && registry) {
    const preparation = sessionStartPreparation({ credentials, flags, env });
    if (preparation === 'bootstrap') {
      try {
        const report = await bootstrap({ stateRoot, socketPath, runtimeTypes: [...registry.names()], wakeRuntimeTypes: packageBoundCopilotRuntimeIds(registry) });
        debugLog({ event: 'auto_bootstrap', status: report.status, app_id: report.app_id, daemon: report.daemon });
        credentials = readHookCredentials(stateRoot);
      } catch (err) {
        debugLog({ event: 'auto_bootstrap_failed', error: err.code || err.message });
        throw err;
      }
    } else if (preparation === 'daemon') {
      const daemon = await ensureDaemon(stateRoot, socketPath);
      debugLog({ event: 'auto_daemon', status: daemon });
    }
  }

  const runtime = resolveRuntime({
    payload: hookPayload,
    env,
    registry,
    explicit: flags.runtime || env.TIGHTBEAM_RUNTIME || credentials?.runtime,
  });
  if (!runtime || (!explicitRuntime && registry?.get(runtime)?.hooksInstall?.format === 'copilot-json')) {
    throw new HookError(runtime ? 'Copilot hook requires an explicit --runtime binding' : 'could not determine the runtime for this session; pass --runtime or set TIGHTBEAM_RUNTIME');
  }
  debugLog({ event: 'runtime_resolved', verb, runtime, bound: Boolean(flags.runtime || env.TIGHTBEAM_RUNTIME || credentials?.runtime) });

  // With the runtime known, the session-id fallback chain can be scoped to
  // that record's declared vars (manifest bindings), so another runtime's
  // session variable cannot leak into this session's identity.
  const sessionId = isCopilot ? copilotInput.sessionId : resolveSessionId({ payload: hookPayload, env, registry, runtime });
  if (!sessionId) {
    throw new HookError(
      'could not resolve a session id from the hook payload or the environment ' +
        `(${['payload.session_id', ...sessionEnvChain(registry)].join(', ')})`,
    );
  }

  // From here the session directory is known, so a failing handoff gate
  // can tell its listener; identity is filled in once it resolves.
  const ctx = { paths: sessionPaths(stateRoot, sessionId), identity: { session_id: sessionId }, payload: hookPayload, handoff: flags.handoff === true, waitMode: flags.waitMode, stdinKey, copilotInput, deferOutputCommit: isCopilot };
  let client;
  try {
    ctx.identity = resolveIdentity({ payload: hookPayload, env, flags, credentials, sessionId, runtime, verb, copilotRecord: copilotRuntime });

    if (verb === 'post-tool-use' && !isCopilot) return runPostToolUse(ctx);
    if (verb === 'subagent-start' || verb === 'subagent-stop') return trackCodexSubagent(verb, ctx);
    if (verb === 'wake-listen') {
      // The record decides whether this listener has anything to hold, so it
      // is read before credentials or a daemon connection are needed.
      const prepared = await prepareWakeListen(ctx);
      if (prepared.result) return prepared.result;
      ctx.handoffRecord = prepared.record;
      ctx.hostProbe = prepared.hostProbe;
    }

    const appCredential = resolveHookAppCredential({ stateRoot, flags, env, credentials });
    ctx.app_id = appCredential.appId;
    client = await openHookClient(stateRoot, appCredential);
  } catch (error) {
    recordGateFailure(verb, ctx);
    throw error;
  }
  try {
    if (isCopilot) return await runCopilotHook({ client, verb, ctx, handlers: HANDLERS, render: runPostToolUse });
    return await HANDLERS[verb](client, ctx);
  } finally {
    await client.close();
  }
}

function resolveHookAppCredential({ stateRoot, flags, env, credentials }) {
  const appId = flags.appId || env.TIGHTBEAM_APP_ID || credentials?.app_id;
  const appSecret = flags.appSecret || env.TIGHTBEAM_APP_SECRET || credentials?.app_secret;
  if (!appId || !appSecret) {
    throw new HookError(
      `no application credentials for the hook: run "${tightbeamCommandName()} bootstrap", or write ${hookCredentialsPath(stateRoot)} ` +
        '(mode 0600) with {"app_id":…,"app_secret":…,"authority_name":…}, or set TIGHTBEAM_APP_ID and ' +
        `TIGHTBEAM_APP_SECRET. Run "${tightbeamCommandName()} doctor" to see which checks fail`,
    );
  }
  return { appId, appSecret };
}

async function openHookClient(stateRoot, { appId, appSecret }) {
  const client = await connect(stateRoot);
  try {
    await client.handshake({ appId, credential: { kind: 'app', app_secret: appSecret } });
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}
