// The five `tightbeam hook <event>` verbs (plan §3, event map matching
// helm/src/lib/bootstrap_hooks.mjs:46-50):
//
//   SessionStart      session-start       principal.register + endpoint.register
//   UserPromptSubmit  user-prompt-submit  endpoint.state.set busy
//   Stop              stop                one session.stop call (block=exit 2, allow=idle)
//   PreToolUse        pre-tool-use        no automatic message consumption
//   PostToolUse       post-tool-use       inject staged notifications only
//
// Every verb resolves identity through src/cli/hook_identity.mjs and
// nothing here re-implements it. The hooks call existing daemon
// operations only; they hold no authority the operations do not already
// enforce.
//
// PreToolUse and PostToolUse are reached through hooks/pre-tool-use and
// hooks/post-tool-use, which perform the watermark check in shell and only
// start this process when there is something to do. Both verbs stay
// directly callable — that is how the conformance fixture and an operator
// drive them.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { connect } from '../client/client.mjs';
import { sessionPaths } from '../protocol/session_paths.mjs';
import {
  captureOwnerProcess,
  classifyHookPayload,
  defaultPrincipalRef,
  readStdinSync,
  resolveLaunchMode,
  resolveRuntime,
  resolveSessionId,
  resolveWorkingDirectory,
  sessionEnvChain,
} from './hook_identity.mjs';
import { hookCredentialsPath, readHookCredentials } from './hook_credentials.mjs';
import { bootstrap, ensureDaemon } from './bootstrap.mjs';
import { tightbeamCommandHint, tightbeamCommandName, tightbeamRecipeCommand } from './package_context.mjs';

/**
 * Chooses the SessionStart preparation that is safe for the identity
 * sources the caller supplied. Local identity may use the idempotent
 * bootstrap. A complete explicit identity may restore daemon liveness but
 * never publish local credentials. A partial explicit identity must have no
 * side effects before the normal missing-identity diagnostic is produced.
 */
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

export const HOOK_EVENT_VERBS = ['session-start', 'user-prompt-submit', 'stop', 'pre-tool-use', 'post-tool-use'];

// A hook that fails must not fail the agent's turn. Claude Code treats
// exit code 2 as "block"; every diagnostic below exits 1, which the
// runtime surfaces without stopping the session. The Stop gate is the one
// deliberate exception — when it blocks, exit 2 IS the contract, and it is
// a decision the gate reached, not a failure.
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

function debugLog(fields) {
  if (!process.env.TIGHTBEAM_HOOK_DEBUG) return;
  const line = `${JSON.stringify({ component: 'tightbeam-hook', ...fields })}\n`;
  process.stderr.write(line);
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

/**
 * The identity facts a registration needs. The runtime arrives already
 * resolved and validated (see runHookVerb): the explicit escapes
 * (`--runtime`, `TIGHTBEAM_RUNTIME`, the credential file) bind it named,
 * otherwise registry evidence resolved it or this function is never
 * reached.
 */
function resolveIdentity({ payload, env, flags, credentials, sessionId, runtime, verb }) {
  const authorityName = flags.authority || env.TIGHTBEAM_AUTHORITY || credentials?.authority_name;
  if (!authorityName) {
    throw new HookError(
      `no authority to register under: run "${tightbeamCommandName()} bootstrap", or set "authority_name" in the hook credential ` +
        `file, or pass --authority. Run "${tightbeamCommandName()} doctor" to see which checks fail`,
    );
  }
  const cwd = resolveWorkingDirectory({ payload, env });
  const academyAgentName = typeof env.ACADEMY_AGENT_NAME === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(env.ACADEMY_AGENT_NAME)
    ? env.ACADEMY_AGENT_NAME
    : null;
  return {
    session_id: sessionId,
    runtime,
    authority_name: authorityName,
    cwd,
    // Logged once per session (SessionStart); the tool-boundary verbs also
    // re-resolve identity and must stay out of the log.
    launch_mode: resolveLaunchMode({ payload, env, runtime, log: verb === 'session-start' ? (fields) => debugLog({ ...fields, session_id: sessionId, runtime }) : undefined }),
    // Set only by the daemon on a session it started (src/daemon/resumer.mjs
    // childEnv): the token of THAT launch. Forwarded verbatim so the
    // registration this session performs stamps which launch owns the
    // endpoint, which is what lets a later exit be told apart from a
    // zombie sibling's. Absent for an interactive session, and absent is a
    // valid answer — the row then records no launch owner at all.
    launch_token: env.TIGHTBEAM_LAUNCH_TOKEN || null,
    academy_agent_name: academyAgentName,
    principal_ref: flags.principalRef || env.TIGHTBEAM_PRINCIPAL_REF || credentials?.principal_ref || defaultPrincipalRef({ runtime, cwd }),
  };
}

/**
 * Registers (or idempotently re-registers) this session's principal and
 * endpoint and caches the result. `principal.register` and
 * `endpoint.register` both replay on an identical repeat, which is exactly
 * what lets a stateless hook run this on every SessionStart — and lets any
 * later verb rebuild a lost cache without a second code path.
 */
async function registerSession(client, { paths, identity, app_id: appId }) {
  // The owning runtime process (item 42 C), observed only where the
  // endpoint is registered: the tool-boundary verbs never pay for a ps
  // walk. Null (capture failed or unsupported) registers without liveness
  // evidence, so the daemon never resumes this session headlessly on its
  // own; a caller-supplied snapshot (tests) is forwarded as given.
  const ownerProcess = identity.owner_process !== undefined
    ? identity.owner_process
    : captureOwnerProcess({ runtime: identity.runtime, log: (fields) => debugLog({ ...fields, session_id: identity.session_id }) });
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

function renderInjection(entries) {
  const lines = [];
  for (const entry of entries) {
    lines.push('Tightbeam message · received');
    lines.push(`Message: ${entry.message_id}`);
    lines.push(`Attempt: ${entry.attempt === 'retry' ? 'retry' : 'initial'}`);
    lines.push(`Receive command: ${tightbeamCommandHint()} agent receive --message ${entry.message_id}`);
    lines.push(`Reply command: ${tightbeamCommandHint()} agent reply --message ${entry.message_id} --body "<reply>" --wait-delivery 30s`);
    if (entry.has_external_origin) {
      lines.push(`For this external user message, within 120 seconds send ${tightbeamRecipeCommand()} agent ack saying it was received and work is underway, or send ${tightbeamRecipeCommand()} agent complete if the full answer is ready. A complete answer inside 120 seconds satisfies ACK; after a progress ACK, send the terminal response within 300 seconds of inbound acceptance.`);
    }
  }
  const text = lines.join('\n');
  return text.length > MAX_INJECTED_CHARS ? `${text.slice(0, MAX_INJECTED_CHARS)}\n[truncated; reply to each listed message explicitly]` : text;
}

function renderOutboundChannelCatalog(routes) {
  const catalog = routes
    .map(({ selector, label }) => ({ selector, label }))
    .sort((a, b) => (a.selector < b.selector ? -1 : a.selector > b.selector ? 1 : 0));
  return `<tightbeam_outbound_channels>\n${JSON.stringify(catalog)}\n</tightbeam_outbound_channels>`;
}

/**
 * A replacement SessionStart receives canonical recovery state before the
 * ordinary outbound catalog.  Lineage IDs and provider-session identities
 * deliberately stay out of the model prompt: they are operator evidence,
 * not instructions or reply authority.
 */
export function renderRecoveryContext(context) {
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
    '</tightbeam_recovery_context>',
  ].join('\n');
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

function stagedPresentationNotification(presentation, endpoint) {
  return {
    message_id: presentation.message_id,
    attempt: 'initial',
    has_external_origin: presentation.has_external_origin === true,
  };
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

// ---------------------------------------------------------------------
// The Stop gate (Project Relay parent 3.2; plan «Technical Approach 4»).
//
// One daemon call replaces the retired obligation.list + endpoint.state.set
// sequencing: `session.stop` authenticates this exact endpoint (+observed
// process generation), evaluates owned work, and returns ONLY block or
// allow — the daemon records the bounded escape evidence, marks the
// endpoint idle after an allow, and replays idempotently. Launch mode is
// NOT an input: the adapter owns everything after allow (REQ-04).
//
// Outward behavior is preserved: exit 2 IS the block (stderr feeds the
// model), exit 0 allows, and the bounded force-allow — after the daemon's
// anti-wedge budget is exhausted — still leaves the work open, still says
// so on stderr, and still appends this session's unresolved diagnostic.

/**
 * The force-allow's durable local evidence. Appended, never rewritten:
 * each force-allow is its own line, so an earlier unresolved escape cannot
 * be erased by a later one. The canonical evidence lives in the daemon's
 * root_attention table; this file is the per-session diagnostic the legacy
 * gate wrote and operators grep for.
 */
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

/**
 * Holds one daemon-admitted Stop park. The daemon, not this adapter, owns
 * eligibility, the lease, presentation deadline, and fallback selection.
 * This function only attaches the connection it already authenticated,
 * renews that exact fence, stages the presented reply, and then ACKs it.
 */
export async function holdParkedStop(client, { endpoint, decision, ctx, append = appendStagedEntry, timers = globalThis } = {}) {
  const fence = listenerFence(endpoint, decision);
  const deadlineMs = Date.parse(decision.park_deadline_at);
  const waitMs = Number.isFinite(deadlineMs) ? Math.max(1, deadlineMs - Date.now()) : 1;
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
    try {
      await client.endListener({ ...fence, terminal_reason: terminalReason });
    } catch (error) {
      // If this connection is already gone, the daemon reconciler owns the
      // sole fallback. A hook must never manufacture a second one.
      debugLog({ event: 'stop_listener_end_unavailable', listener_id: fence.listener_id, error: error.code || error.message });
    }
  };

  client.on('event', async (event, presentation) => {
    if (settled || presenting || event !== 'listener.presentation') return;
    if (
      (presentation.listener_id && presentation.listener_id !== fence.listener_id) ||
      (presentation.listener_generation && presentation.listener_generation !== fence.listener_generation) ||
      typeof presentation.presentation_id !== 'string' || typeof presentation.message_id !== 'string'
    ) return;
    presenting = true;
    try {
      const entry = stagedPresentationNotification(presentation, endpoint);
      append(ctx.paths, entry);
      await client.acknowledgeListener({ ...fence, presentation_id: presentation.presentation_id });
      finish(continuationFor(entry));
    } catch (error) {
      debugLog({ event: 'stop_listener_delivery_failed', listener_id: fence.listener_id, error: error.code || error.message });
      await end('presentation_failed');
      finish(null);
    }
  });

  try {
    await client.attachListener(fence);
    debugLog({ event: 'stop_listener_attached', listener_id: fence.listener_id, listener_generation: fence.listener_generation });
  } catch (error) {
    debugLog({ event: 'stop_listener_attach_failed', listener_id: fence.listener_id, error: error.code || error.message });
    await end('hook_error');
    return null;
  }
  if (settled) return result;
  heartbeat = timers.setInterval(() => {
    client.heartbeatListener(fence).catch(async (error) => {
      debugLog({ event: 'stop_listener_heartbeat_failed', listener_id: fence.listener_id, error: error.code || error.message });
      await end('connection_lost');
      finish(null);
    });
  }, LISTENER_HEARTBEAT_MS);
  timeout = timers.setTimeout(async () => {
    await end('park_expired');
    finish(null);
  }, waitMs);
  return result;
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
        recovery = `${renderRecoveryContext(context)}\n\n`;
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
          additionalContext: `${recovery}${renderOutboundChannelCatalog(catalog.routes)}`,
        },
      },
    };
  },

  async 'user-prompt-submit'(client, ctx) {
    return setEndpointState(client, ctx, 'busy');
  },

  async stop(client, ctx) {
    const endpoint = await resolveSessionEndpoint(client, ctx);
    // One call decides everything: block with a bounded reason, or allow
    // with the endpoint already idled inside the same transaction. The key
    // makes THIS attempt replayable without burning the anti-wedge budget
    // twice; the cached process generation fences a stale process out.
    const decision = await client.request('session.stop', {
      endpoint_id: endpoint.endpoint_id,
      process_generation: endpoint.process_generation,
      idempotency_key: randomUUID(),
    });
    debugLog({
      event: 'stop_gate',
      session_id: ctx.identity.session_id,
      endpoint_id: endpoint.endpoint_id,
      decision: decision.decision,
      escaped: decision.obligation_ids.length,
    });

    if (decision.decision === 'block') {
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

    if (decision.decision === 'park') {
      const continuation = await holdParkedStop(client, { endpoint, decision, ctx });
      return continuation
        ? { endpoint_id: endpoint.endpoint_id, state: 'busy', gate: 'park-continued', output: continuation }
        : { endpoint_id: endpoint.endpoint_id, state: 'idle', gate: 'park-ended' };
    }

    // A bounded allow names the work it escaped; a clean allow carries none.
    const forced = decision.obligation_ids.length > 0;
    if (forced) {
      writeUnresolvedDiagnostic(ctx, endpoint, decision);
      process.stderr.write(`${renderForcedAllowNotice(decision)}\n`);
    }
    return { endpoint_id: endpoint.endpoint_id, state: 'idle', gate: forced ? 'force-allow' : 'allow', obligation_ids: decision.obligation_ids };
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
      appendStagedEntry(ctx.paths, { message_id: notification.message_id, attempt: notification.attempt, has_external_origin: notification.has_external_origin === true });
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

// PostToolUse touches no socket at all — it renders what PreToolUse
// already staged locally, so an inject costs zero IPC.
async function runPostToolUse(ctx) {
  const claimed = claimStagedBatch(ctx.paths);
  if (!claimed) {
    debugLog({ event: 'inject_skipped', session_id: ctx.identity.session_id });
    return { injected: 0, quarantined: 0, output: null };
  }
  const { entries, torn } = readStagedEntries(ctx.paths, claimed);
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
    entries.length === 0
      ? null
      : { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: renderInjection(entries) } };
  // Truncate only after rendering succeeded, so a crash mid-render leaves
  // the staged messages to be injected at the next tool boundary.
  fs.rmSync(claimed, { force: true });
  // Create only when PreToolUse did not already open its fresh successor
  // file; append mode cannot truncate a notification staged meanwhile.
  ensurePendingScratch(ctx.paths);
  debugLog({ event: 'inject_emitted', session_id: ctx.identity.session_id, messages: entries.length, quarantined: torn.length });
  return { injected: entries.length, quarantined: torn.length, output };
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
export async function runHookVerb(verb, { stateRoot, flags = {}, env = process.env, stdin, registry, socketPath } = {}) {
  if (!HOOK_EVENT_VERBS.includes(verb)) {
    throw new HookError(`unknown hook event: ${verb} (expected one of ${HOOK_EVENT_VERBS.join(', ')})`);
  }

  const delivered = stdin === undefined ? readStdinSync() : { text: stdin, complete: true };
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
  // Runtime first, and fail closed named: an explicit binding is validated
  // against this state root's registry (an unknown value is a refusal
  // BEFORE any endpoint registration write), and evidence matching two
  // registered runtimes is refused rather than first-matched — a Grok or
  // Muse hook reading Claude-shaped config must never become claude-code.
  // The named refusals from resolveRuntime carry their codes through to
  // the CLI's `error <code>: <message>` reporting.
  // Lazily bootstrap a fresh install. The plugin manifests wire these
  // hooks at install time but nothing in the plugin model runs a script,
  // so before this existed every SessionStart on a new machine died with
  // "no authority to register under" and the product was inert until
  // somebody ran three admin commands and hand-wrote a credential file.
  //
  // SessionStart always restores daemon liveness for a usable identity.
  // Local identity goes through idempotent bootstrap so an existing
  // credential is preserved and a missing one is provisioned. Complete
  // explicit identity starts only the daemon; partial explicit identity has
  // no side effects and fails later with the precise missing-identity error.
  // Later verbs run inside a live session whose SessionStart has passed.
  let credentials = readHookCredentials(stateRoot);
  if (verb === 'session-start' && socketPath && registry) {
    const preparation = sessionStartPreparation({ credentials, flags, env });
    if (preparation === 'bootstrap') {
      try {
        const report = await bootstrap({ stateRoot, socketPath, runtimeTypes: [...registry.names()] });
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
    payload,
    env,
    registry,
    explicit: flags.runtime || env.TIGHTBEAM_RUNTIME || credentials?.runtime,
  });
  if (!runtime) {
    throw new HookError('could not determine the runtime for this session; pass --runtime or set TIGHTBEAM_RUNTIME');
  }
  debugLog({ event: 'runtime_resolved', verb, runtime, bound: Boolean(flags.runtime || env.TIGHTBEAM_RUNTIME || credentials?.runtime) });

  // With the runtime known, the session-id fallback chain can be scoped to
  // that record's declared vars (manifest bindings), so another runtime's
  // session variable cannot leak into this session's identity.
  const sessionId = resolveSessionId({ payload, env, registry, runtime });
  if (!sessionId) {
    throw new HookError(
      'could not resolve a session id from the hook payload or the environment ' +
        `(${['payload.session_id', ...sessionEnvChain(registry)].join(', ')})`,
    );
  }

  const paths = sessionPaths(stateRoot, sessionId);
  const identity = resolveIdentity({ payload, env, flags, credentials, sessionId, runtime, verb });
  const ctx = { paths, identity, payload };

  if (verb === 'post-tool-use') return runPostToolUse(ctx);

  const appId = flags.appId || env.TIGHTBEAM_APP_ID || credentials?.app_id;
  const appSecret = flags.appSecret || env.TIGHTBEAM_APP_SECRET || credentials?.app_secret;
  if (!appId || !appSecret) {
    throw new HookError(
      `no application credentials for the hook: run "${tightbeamCommandName()} bootstrap", or write ${hookCredentialsPath(stateRoot)} ` +
        '(mode 0600) with {"app_id":…,"app_secret":…,"authority_name":…}, or set TIGHTBEAM_APP_ID and ' +
        `TIGHTBEAM_APP_SECRET. Run "${tightbeamCommandName()} doctor" to see which checks fail`,
    );
  }

  ctx.app_id = appId;

  const client = await connect(stateRoot);
  try {
    await client.handshake({ appId, credential: { kind: 'app', app_secret: appSecret } });
    return await HANDLERS[verb](client, ctx);
  } finally {
    await client.close();
  }
}
