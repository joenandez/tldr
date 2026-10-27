// Session identity, runtime, and launch mode — resolved once, here, for
// all five `tightbeam hook <event>` verbs (plan §3: "Session identity is
// resolved once, inside the CLI, from the runtime's stdin JSON payload
// with the env fallback chain Helm uses"). Absorbing the chain every Helm
// hook re-implements (helm/hooks/lib/resolve_session_id.sh) is the point
// of this module; nothing below may be duplicated in a verb.
//
// Imports nothing from src/daemon/ (the architecture contract §5).

import fs from 'node:fs';
import tty from 'node:tty';
import { execFileSync as runFile } from 'node:child_process';

import { createRuntimeRegistry } from '../runtimes/registry.mjs';
import { COPILOT_OWNER_CAPTURE_SOURCE, COPILOT_OWNER_COMMAND } from '../runtimes/copilot_wake_contract.mjs';

import { isSafeSessionId } from '../protocol/session_paths.mjs';
import { HOST_NAME_PATTERN, HOST_REF_PATTERN } from '../protocol/host_binding.mjs';
import {
  CODEX_COMMAND,
  claudeArgsAreHeadless,
  claudeInvocationArgs,
  commandBaseName,
  isAppServerArgs,
  observeProcessRow as observeOwnerCandidate,
  readProcessArgs,
  resolveAppServerClientOwner,
} from './hook_process_tree.mjs';

export { claudeInvocationArgs };

// Cross-runtime legacy fallbacks that belong to the CHAIN, not to any one
// runtime record: HELM_AGENT_SESSION_ID predates per-runtime identity and
// every runtime honours it. helm/hooks/lib/resolve_session_id.sh:31 keeps
// it between the primaries and the secondary spellings, so the derived
// chain inserts these after the first round of declared vars.
const CHAIN_GLOBAL_FALLBACKS = Object.freeze(['HELM_AGENT_SESSION_ID']);

// A builtins-only view for callers that hold no registry (unit tests,
// direct library use). The CLI always passes a state-root-scoped instance.
let sharedBuiltinRegistry = null;
function defaultRegistry() {
  if (sharedBuiltinRegistry === null) {
    sharedBuiltinRegistry = createRuntimeRegistry({ stateRoot: '(hook-identity-builtins-only)' });
  }
  return sharedBuiltinRegistry;
}

function namedIdentityError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * The session-env fallback chain, derived from the registry's records in
 * `names()` order: round one takes each runtime's primary variable (with
 * the chain-level globals after it), later rounds take remaining
 * spellings — exactly the order helm/hooks/lib/resolve_session_id.sh:31
 * ships for the builtins, extended by whatever manifest runtimes are
 * registered. The payload still wins over all of them: when `claude -p`
 * runs inside another session the child inherits the PARENT's env but the
 * runtime stamps the CHILD's id into the payload, and preferring env there
 * overwrote the parent's identity (that file's GH#19 note, 2026-05-17).
 */
export function sessionEnvChain(registry = defaultRegistry()) {
  const records = registry.list();
  const rounds = Math.max(...records.map((record) => record.identity.sessionEnvVars.length));
  const chain = [];
  for (let round = 0; round < rounds; round += 1) {
    for (const record of records) {
      const name = record.identity.sessionEnvVars[round];
      if (name !== undefined && !chain.includes(name)) chain.push(name);
    }
    if (round === 0) {
      for (const name of CHAIN_GLOBAL_FALLBACKS) {
        if (!chain.includes(name)) chain.push(name);
      }
    }
  }
  return chain;
}

/** A runtime-bound session sees only its own record's vars plus the globals. */
function scopedSessionChain(record) {
  return [...record.identity.sessionEnvVars, ...CHAIN_GLOBAL_FALLBACKS.filter((name) => !record.identity.sessionEnvVars.includes(name))];
}

/**
 * Classifies what stdin delivered, because the caller must treat the
 * cases differently:
 *
 *   empty        nothing arrived and the read finished — fall back to the
 *                env chain, which is a supported way to run a hook.
 *   ok           a whole JSON object arrived; `payload` holds it.
 *   unparseable  bytes arrived that are not a JSON object.
 *   truncated    the read never finished (see readStdinSync).
 *
 * Folding the last two into `empty` — which is what this returned before —
 * is a wrong-identity bug, not a lenient default: a `claude -p` child
 * inherits its PARENT's session id in the environment, so a payload that
 * arrives damaged silently resolves to the parent, and the child's Stop
 * then marks a live, mid-turn parent idle. The caller fails loudly on
 * both, exactly as it already does for a session id it cannot resolve.
 */
export function classifyHookPayload({ text = '', complete = true } = {}) {
  const raw = typeof text === 'string' ? text : '';
  const bytes = raw.length;
  if (!complete) return { status: 'truncated', payload: {}, bytes };
  if (raw.trim().length === 0) return { status: 'empty', payload: {}, bytes };
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: 'unparseable', payload: {}, bytes };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'unparseable', payload: {}, bytes };
  return { status: 'ok', payload: value, bytes };
}

// How long to keep waiting for a payload the runtime has not finished
// writing. Bounded so a runtime that opens stdin and never writes cannot
// hang a tool boundary.
const STDIN_WAIT_MS = 2000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Reads the runtime's hook payload off stdin. Returns `{ text, complete }`,
 * where `complete` is false when the read gave up rather than reaching
 * end of file — the caller cannot tell a whole payload from a fragment
 * without it, and guessing there registers the wrong session.
 *
 * Deliberately never touches `process.stdin`: reading that property
 * constructs Node's stream wrapper, which puts fd 0 into NON-BLOCKING
 * mode, after which a synchronous read of a pipe the runtime has not
 * filled yet fails with EAGAIN. That failure is silent and its
 * consequence is not: the hook falls back to the environment chain, and a
 * `claude -p` child launched inside another session then registers under
 * its PARENT's session id. Observed against Claude Code 2.1.237 while
 * driving the real CLI; `tty.isatty(0)` answers the same question without
 * constructing anything.
 */
export function readStdinSync() {
  if (tty.isatty(0)) return { text: '', raw: Buffer.alloc(0), complete: true };
  const chunks = [];
  let complete = true;
  const buffer = Buffer.alloc(65536);
  const deadline = Date.now() + STDIN_WAIT_MS;
  for (;;) {
    let bytesRead;
    try {
      bytesRead = fs.readSync(0, buffer, 0, buffer.length, null);
    } catch (err) {
      // EAGAIN: fd 0 is non-blocking (another library got to process.stdin
      // first) and the writer has not caught up yet.
      if (err.code === 'EAGAIN' && Date.now() < deadline) {
        sleepSync(5);
        continue;
      }
      // Out of time, or the read failed after the payload had started
      // arriving: either way what we hold is a fragment. A read that
      // fails before a single byte arrives is a stdin that can never
      // deliver one (a closed or unreadable fd 0), which is the same
      // thing as an empty stdin and stays a supported path.
      complete = err.code !== 'EAGAIN' && chunks.length === 0;
      break;
    }
    if (bytesRead === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
  // `raw` is the exact bytes read: the Stop gate and its wake listener key
  // their handoff on them, so neither may re-serialize the payload.
  const raw = Buffer.concat(chunks);
  return { text: raw.toString('utf8'), raw, complete };
}

/**
 * The resolved session id, or null. Both runtimes send snake_case
 * `session_id` (Claude Code documented; Codex 0.148.0 confirmed from the
 * shipped binary's wire structs). When `runtime` names a manifest-origin
 * record the env fallback is scoped to that record's declared vars plus
 * the chain-level globals — a bound Grok session must not adopt a parent
 * shell's CLAUDE_SESSION_ID. Builtins keep the full derived chain, which
 * reproduces the shipped order exactly. An id that could escape the
 * per-session state directory resolves to null — the caller then fails
 * loudly rather than acting on a guess.
 */
export function resolveSessionId({ payload = {}, env = process.env, runtime, registry } = {}) {
  let chain;
  if (typeof runtime === 'string' && registry !== undefined) {
    const record = registry.get(runtime);
    if (record !== null && record.origin === 'manifest') {
      chain = scopedSessionChain(record);
    }
  }
  if (chain === undefined) chain = sessionEnvChain(registry);
  const candidates = [payload.session_id, ...chain.map((name) => env[name])];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0 && isSafeSessionId(candidate)) return candidate;
  }
  return null;
}

const LAUNCH_MODES = new Set(['interactive', 'non_interactive']);

/**
 * The single launch-mode normaliser. Helm carries two that disagree —
 * helm/src/lib/tachyon_eligibility.mjs:24-51 folds `-` to `_` and accepts
 * `headless`, helm/src/lib/ariadne_followup.mjs:301-310 does neither — and
 * reproducing that split would make the Stop gate's hard/soft decision
 * depend on which module asked. This is the union of both, and returns
 * null (not "unknown") because the endpoints column holds
 * `interactive | non_interactive | NULL`.
 */
export function normalizeLaunchMode(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/-/g, '_');
  if (normalized === 'headless' || normalized === 'noninteractive') return 'non_interactive';
  return LAUNCH_MODES.has(normalized) ? normalized : null;
}

/**
 * True when this process has a controlling terminal. Opening /dev/tty
 * fails with ENXIO when it does not, which is the same fact Helm reads
 * with `ps -o tty=` (helm/hooks/helm-capture-session-identity.sh:67-72) —
 * without spawning anything.
 */
export function hasControllingTerminal() {
  try {
    fs.closeSync(fs.openSync('/dev/tty', 'r'));
    return true;
  } catch {
    return false;
  }
}

// Item 42 C: the capture source each runtime's hook stamps, mirroring
// src/daemon/owner_process_contract.mjs (no daemon import); 'claude' aliases 'claude-code'.
const OWNER_CAPTURE_SOURCES = Object.freeze({ codex: 'codex-hook', 'claude-code': 'claude-hook', claude: 'claude-hook' });

// The process names that can own a session's transcript: the runtime's own
// binary (`codex`, a platform-suffixed Codex build, `claude`) or `node` for
// an npm-installed runtime. Everything else between the hook and the
// runtime is a relay — `sh -c`, the user's shell, the tldr-agents launcher
// chain, or a runtime helper — and is walked past. Walking past an
// unexpected name can only land on a LONGER-lived ancestor, which delays a
// headless resume; stopping at a short-lived helper would read its exit as
// the session's and resume beside a live pane, so it is never done.
const OWNER_RUNTIME_COMMANDS = Object.freeze({
  codex: CODEX_COMMAND,
  'claude-code': /^claude$/i,
  claude: /^claude$/i,
});
export const OWNER_CAPTURE_MAX_HOPS = 8;

function isOwnerCommand(runtime, name) {
  return name === 'node' || OWNER_RUNTIME_COMMANDS[runtime].test(name);
}

/**
 * The runtime process that owns this session, observed from the installed
 * hook, named by PID, its OS start identity (lstart, C locale), and its
 * process group. The start identity is what keeps a reused PID from passing
 * for the recorded owner later.
 *
 * The owner is the hook's nearest ancestor that is the runtime's own binary
 * (or `node`), past any shell, launcher, or helper relay — with one
 * exception that is the point of F27: a Codex `app-server` is never an
 * owner. Since Codex 0.161 the TUI delegates its hooks to one managed
 * app-server shared by every TUI (and by whichever pane started it), so the
 * hook's ancestor says nothing about which TUI the session belongs to. For
 * that layout the session's own TUI is resolved from the app-server's socket
 * clients (see hook_process_tree.mjs); when that cannot be proven the
 * capture is `unknown` and records nothing. Older Codex, `--no-daemon`,
 * `codex exec` and Claude hook directly under the runtime process.
 *
 * Built-ins and `copilot` (package-bound record; command `copilot`, not `node`) capture. Null — never a partial
 * snapshot — for any other runtime, an unobservable ancestor, a chain that
 * does not reach the runtime process within OWNER_CAPTURE_MAX_HOPS, or an
 * app-server layout whose TUI is not provable; the daemon then has no
 * liveness evidence and never resumes an interactive session on that
 * endpoint's behalf. `sessionId` and `cwd` identify the session being
 * registered. `log`, when given, receives one structured record of the
 * decision naming the signal that chose the owner (never arguments, ids or
 * folders).
 */
export function captureOwnerProcess({ runtime, copilot = false, parentProcessId = process.ppid, sessionId, cwd, execFileSync = runFile, log } = {}) {
  const captureSource = copilot ? COPILOT_OWNER_CAPTURE_SOURCE : Object.hasOwn(OWNER_CAPTURE_SOURCES, runtime) ? OWNER_CAPTURE_SOURCES[runtime] : null;
  const report = (status, extra = {}) => {
    if (typeof log === 'function') log({ event: 'owner_process_capture', params: { runtime: runtime ?? null }, status, ...extra });
  };
  if (captureSource === null) {
    report('skipped', { result: 'unsupported_runtime' });
    return null;
  }
  if (!Number.isInteger(parentProcessId) || parentProcessId < 1) {
    report('failed', { result: 'no_parent_process' });
    return null;
  }
  let pid = parentProcessId;
  const relays = [];
  try {
    for (let hop = 0; hop < OWNER_CAPTURE_MAX_HOPS; hop += 1) {
      const observed = observeOwnerCandidate(pid, execFileSync);
      if (!observed) {
        report('failed', { result: 'ancestor_unobservable', hops: hop });
        return null;
      }
      const name = commandBaseName(observed.command);
      if (copilot ? COPILOT_OWNER_COMMAND.test(name) : isOwnerCommand(runtime, name)) {
        if (runtime === 'codex') {
          const args = readProcessArgs(observed.pid, execFileSync);
          if (args === null) {
            report('unknown', { result: 'owner_args_unobservable', relays });
            return null;
          }
          if (isAppServerArgs(args)) {
            const { owner, reason, signal, command, ...facts } = resolveAppServerClientOwner({ appServerPid: observed.pid, sessionId, cwd, captureSource, execFileSync });
            if (owner === null) {
              report('unknown', { result: reason, ...facts });
              return null;
            }
            report('ok', { result: { pid: owner.pid, process_group_id: owner.process_group_id, command, relays, signal, ...facts } });
            return owner;
          }
        }
        report('ok', { result: { pid: observed.pid, process_group_id: observed.processGroupId, command: name, relays, signal: 'runtime_ancestor' } });
        return { pid: observed.pid, start_identity: observed.startIdentity, process_group_id: observed.processGroupId, capture_source: captureSource };
      }
      relays.push(name);
      if (observed.ppid <= 1) break;
      pid = observed.ppid;
    }
  } catch (error) {
    report('failed', { result: 'ps_failed', error: error?.code ?? error?.message ?? 'ps_failed' });
    return null;
  }
  report('failed', { result: 'no_runtime_ancestor', relays });
  return null;
}

// Agent commands sit a few relays below their runtime (node CLI, launcher
// sh, component dispatch, the tool shell, a runtime helper); this bound
// only has to clear that chain, never reach launchd.
export const AGENT_RUNTIME_ANCESTOR_MAX_HOPS = 16;

/**
 * The built-in runtime whose own binary is this process's nearest ancestor,
 * or null. Unlike owner capture, `node` is NOT a match: it names no runtime,
 * and the agent CLI is itself a node process.
 */
export function nearestRuntimeAncestor({ parentProcessId = process.ppid, execFileSync = runFile } = {}) {
  if (!Number.isInteger(parentProcessId) || parentProcessId < 1) return null;
  let pid = parentProcessId;
  try {
    for (let hop = 0; hop < AGENT_RUNTIME_ANCESTOR_MAX_HOPS; hop += 1) {
      const observed = observeOwnerCandidate(pid, execFileSync);
      if (!observed) return null;
      const name = commandBaseName(observed.command);
      for (const [runtime, pattern] of Object.entries(OWNER_RUNTIME_COMMANDS)) {
        if (runtime !== 'claude' && pattern.test(name)) return runtime;
      }
      if (observed.ppid <= 1) return null;
      pid = observed.ppid;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * The session an agent command acts for. Agent commands have no hook
 * payload, so identity comes from the environment — and a process launched
 * from another runtime's shell inherits that runtime's session variable (a
 * Claude pane in an app relaunched by a Codex agent carries CODEX_THREAD_ID,
 * which outranks Claude's own CLAUDE_CODE_SESSION_ID in the chain). When
 * runtime families disagree, an explicit TIGHTBEAM_RUNTIME pin decides, then
 * the nearest runtime-binary ancestor; otherwise this refuses rather than
 * act as a session that may belong to another agent.
 */
export function resolveAgentIdentity({ env = process.env, registry, parentProcessId, execFileSync, log } = {}) {
  const activeRegistry = registry ?? defaultRegistry();
  const families = [];
  for (const record of activeRegistry.list()) {
    const sessionId = record.identity.sessionEnvVars.map((name) => env[name]).find((value) => typeof value === 'string' && value.length > 0 && isSafeSessionId(value));
    if (sessionId !== undefined) families.push({ runtime: record.id, sessionId });
  }
  const report = (status, result) => {
    if (typeof log === 'function') log({ event: 'agent_identity_resolved', params: { families: families.map((family) => family.runtime) }, status, result });
  };

  const pinned = typeof env.TIGHTBEAM_RUNTIME === 'string' && env.TIGHTBEAM_RUNTIME.length > 0 ? env.TIGHTBEAM_RUNTIME : null;
  if (pinned !== null) {
    const record = activeRegistry.get(pinned);
    if (!record) throw namedIdentityError('unknown_runtime', `unknown runtime: ${pinned} (registered runtimes: ${activeRegistry.names().join(', ')})`);
    const sessionId = scopedSessionChain(record).map((name) => env[name]).find((value) => typeof value === 'string' && value.length > 0 && isSafeSessionId(value)) ?? null;
    report('ok', { source: 'pin', runtime: record.id });
    return { sessionId, runtime: record.id, source: 'pin' };
  }

  const distinct = new Set(families.map((family) => family.sessionId));
  if (distinct.size <= 1) {
    const sessionId = resolveSessionId({ env, registry: activeRegistry });
    const runtime = families.length === 1 ? families[0].runtime : null;
    return { sessionId, runtime, source: 'env' };
  }

  const ancestor = nearestRuntimeAncestor({ parentProcessId, execFileSync });
  const match = families.find((family) => family.runtime === ancestor);
  if (match) {
    report('ok', { source: 'ancestry', runtime: match.runtime });
    return { sessionId: match.sessionId, runtime: match.runtime, source: 'ancestry' };
  }
  report('refused', { reason: 'session_identity_ambiguous', ancestor });
  throw namedIdentityError(
    'session_identity_ambiguous',
    `this process carries session ids from several runtimes (${families.map((family) => family.runtime).join(', ')}) and its runtime could not be identified; ` +
      'set TIGHTBEAM_RUNTIME to the runtime running this command (for example TIGHTBEAM_RUNTIME=claude-code) and retry',
  );
}

/**
 * An explicitly supplied value that fails normalisation is evidence gone
 * bad (LC-S11): discarding it and inferring a different disposition would
 * register the endpoint under a launch mode nobody declared — and every
 * later consumer, Stop included, would act on that invention. Absence is
 * not evidence and is never refused.
 */
function refuseMalformedLaunchMode(value) {
  if (value === undefined || value === null || value === '') return;
  throw namedIdentityError(
    'invalid_launch_mode',
    `launch mode ${JSON.stringify(value)} is not one of interactive|non_interactive ` +
      '(headless, noninteractive, and hyphenated spellings are accepted); refusing to infer a different mode for this session',
  );
}

// The Codex rollout's first line is its `session_meta` record, and that
// line embeds the full base instructions: ~19 KB typical, 144 KB the
// largest seen across 3000 real 2026 transcripts. Key order is not stable
// (some Codex builds sort keys, putting `source` after the instructions),
// so the whole line is parsed rather than scanned by offset. The bound
// keeps a damaged or foreign file from turning SessionStart into a big read.
export const TRANSCRIPT_META_MAX_BYTES = 512 * 1024;
const TRANSCRIPT_META_CHUNK_BYTES = 64 * 1024;

// `session_meta.payload.source`, observed on Codex 0.155.1–0.158.0:
// `codex exec` writes "exec" (originator "codex_exec"); the TUI writes
// "cli" (originator "codex-tui"); app-server clients write "vscode"
// (Subspace panes: originator "subspace"). A spawned subagent's source is
// an object ({subagent: …}) and `mcp` is Codex serving another agent —
// neither says whether a person is attached, so they fall through.
const CODEX_SOURCE_LAUNCH_MODES = Object.freeze({
  exec: 'non_interactive',
  cli: 'interactive',
  vscode: 'interactive',
});

/**
 * Reads the Codex rollout's first line — its `session_meta` record — and
 * returns the launch facts it carries. Bounded and non-throwing: a missing,
 * unreadable, non-regular, oversized, or malformed file is a status, never
 * an exception, because transcript evidence is optional and SessionStart
 * must still register. Opened non-blocking so a FIFO planted at the path
 * cannot hang the hook; only a regular file is read.
 */
export function readCodexSessionMeta(transcriptPath, { maxBytes = TRANSCRIPT_META_MAX_BYTES } = {}) {
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) return { status: 'no_transcript_path' };
  let fd = null;
  try {
    fd = fs.openSync(transcriptPath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    if (!fs.fstatSync(fd).isFile()) return { status: 'not_a_file' };
    const chunks = [];
    let total = 0;
    let lineEnd = -1;
    while (total < maxBytes) {
      const chunk = Buffer.alloc(Math.min(TRANSCRIPT_META_CHUNK_BYTES, maxBytes - total));
      const read = fs.readSync(fd, chunk, 0, chunk.length, total);
      if (read === 0) break;
      const newline = chunk.subarray(0, read).indexOf(0x0a);
      chunks.push(chunk.subarray(0, newline === -1 ? read : newline));
      total += read;
      if (newline !== -1) {
        lineEnd = total - read + newline;
        break;
      }
    }
    if (lineEnd === -1 && total >= maxBytes) return { status: 'first_line_over_bound', bytes: total };
    const line = Buffer.concat(chunks).toString('utf8').trim();
    if (line.length === 0) return { status: 'empty' };
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return { status: 'malformed' };
    }
    if (!record || typeof record !== 'object' || record.type !== 'session_meta' || !record.payload || typeof record.payload !== 'object') {
      return { status: 'not_session_meta' };
    }
    const { source, originator } = record.payload;
    return {
      status: 'ok',
      source: typeof source === 'string' ? source : null,
      // An object source names its variant by its single key ("subagent").
      source_kind: typeof source === 'string' ? source : source && typeof source === 'object' ? Object.keys(source)[0] ?? 'object' : null,
      originator: typeof originator === 'string' ? originator : null,
    };
  } catch (err) {
    return { status: 'unreadable', error: err.code || 'read_failed' };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Nothing to recover: the read already produced its answer.
      }
    }
  }
}

/**
 * Codex transcript evidence, consulted only where it can be true. The
 * first line describes the launch that CREATED the rollout; a resume
 * appends to the same file without a new session_meta (verified across
 * ~1500 real transcripts), so an exec session later reopened in the TUI
 * would still read "exec". Only a fresh start — the hook payload's own
 * `source: "startup"`, which is the SessionStart reason and unrelated to
 * the transcript's `source` — makes the first line describe this process.
 */
function codexTranscriptLaunchMode({ payload, runtime, readMeta }) {
  if (runtime !== undefined && runtime !== null && runtime !== 'codex') return { mode: null, evidence: { transcript: 'skipped_runtime' } };
  if (payload.source !== 'startup') return { mode: null, evidence: { transcript: 'skipped_not_startup' } };
  const meta = readMeta(payload.transcript_path);
  const evidence = {
    transcript: meta.status,
    ...(meta.source_kind ? { codex_source: meta.source_kind } : {}),
    ...(meta.originator ? { codex_originator: meta.originator } : {}),
    ...(meta.error ? { transcript_error: meta.error } : {}),
  };
  const mode = meta.status === 'ok' && meta.source ? CODEX_SOURCE_LAUNCH_MODES[meta.source] ?? null : null;
  return { mode, evidence };
}

const CLAUDE_RUNTIMES = new Set(['claude-code', 'claude']);

/**
 * Claude Code runs hooks without a controlling terminal, so the terminal
 * signal below never fires for a real TUI (F26). What the binary itself
 * exports is the reliable evidence (observed on 2.1.295):
 *
 *   TUI       CLAUDE_CODE_ENTRYPOINT=cli      CLAUDE_CODE_SESSION_ATTENDED=1
 *   -p, SDK   CLAUDE_CODE_ENTRYPOINT=sdk-cli  CLAUDE_CODE_SESSION_ATTENDED=0
 *
 * (the sdk entrypoint is decided by the caller). Older builds export no
 * attended flag; for them `cli` alone is interactive unless the claude
 * process's own arguments say headless, and arguments alone say headless
 * only when a print flag comes with a format flag. Evidence that disagrees
 * is left unknown rather than resolved either way, and these variables mean
 * nothing for another runtime that merely inherited a Claude shell.
 */
function claudeLaunchMode({ env, runtime, observeArgs }) {
  if (!CLAUDE_RUNTIMES.has(runtime)) return { mode: null, evidence: {} };
  const entrypoint = typeof env.CLAUDE_CODE_ENTRYPOINT === 'string' ? env.CLAUDE_CODE_ENTRYPOINT.trim().toLowerCase() : '';
  const attended = typeof env.CLAUDE_CODE_SESSION_ATTENDED === 'string' ? env.CLAUDE_CODE_SESSION_ATTENDED.trim() : '';
  if (attended === '0') return { mode: 'non_interactive', signal: 'claude_code_session_attended', evidence: {} };
  if (entrypoint === 'cli' && attended === '1') return { mode: 'interactive', signal: 'claude_code_attended_cli', evidence: {} };
  const claudeMarked = ['CLAUDECODE', 'CLAUDE_PID'].some((name) => typeof env[name] === 'string' && env[name].length > 0) || entrypoint !== '' || attended !== '';
  if (!claudeMarked) return { mode: null, evidence: {} };
  const args = observeArgs();
  const headless = typeof args === 'string' && claudeArgsAreHeadless(args);
  if (entrypoint === 'cli') {
    return headless
      ? { mode: null, evidence: { claude_mode: 'conflict_entrypoint_cli_vs_process_args' } }
      : { mode: 'interactive', signal: 'claude_code_entrypoint_cli', evidence: {} };
  }
  return headless ? { mode: 'non_interactive', signal: 'claude_process_args', evidence: {} } : { mode: null, evidence: {} };
}

function helmJobPresent(env) {
  return ['HELM_JOB_ID', 'HELM_RUN_ID'].some((name) => typeof env[name] === 'string' && env[name].trim().length > 0);
}

/**
 * Resolves `interactive` vs `non_interactive` and names the signal that
 * decided, in precedence order:
 *
 *   1. TIGHTBEAM_LAUNCH_MODE — the operator override, and what the resume
 *      path sets when it spawns a session itself. Subspace's Codex
 *      app-server panes set it to `interactive`; nothing below can
 *      outvote it.
 *   2. A payload-supplied launch_mode, if a runtime ever sends one.
 *   3. HELM_AGENT_LAUNCH_MODE — Helm's own declaration, stamped on every
 *      agent it executes (scheduling/src/lib/executor.mjs agentExecutionEnv,
 *      `non_interactive` unless the job states otherwise). A foreign
 *      contract: an unusable value is ignored and logged, not refused, so
 *      a Helm-side typo cannot stop the session registering at all.
 *   4. Host headless evidence (CLAUDE_CODE_ENTRYPOINT=sdk-cli, set by
 *      `claude -p` and SDK hosts such as Subspace chats) is recorded as
 *      `host_headless`, never decisive: only tldr launches (1, 3, 7) are.
 *   5. Claude's own attended/entrypoint flags and process arguments (see
 *      claudeLaunchMode): a real TUI has no controlling terminal, so this
 *      is what makes it interactive. A headless reading is evidence only.
 *   6. The Codex rollout's session_meta `source` on a fresh start: `cli`
 *      and `vscode` are interactive; `exec` is evidence only, like 4.
 *   7. A Helm job run (HELM_JOB_ID or HELM_RUN_ID, which the executor sets
 *      on every run, process jobs included) is non_interactive.
 *   8. A controlling terminal with no headless evidence is interactive.
 *   9. Missing terminal evidence is unknown (NULL), not headless.
 *
 * Positive noninteractive evidence is never inferred from a missing TTY:
 * a visible pane can lack conventional terminal evidence. A PRESENT
 * Tightbeam or payload value that normalises to nothing is refused named
 * instead of falling through the chain — an explicit answer cannot degrade
 * into a guess.
 *
 * `runtime`, when given, limits transcript reading to Codex and the Claude
 * flags to Claude. `readMeta` and `observeClaudeArgs` are the transcript and
 * process-argument reader seams for tests.
 */
export function resolveLaunchModeEvidence({
  payload = {},
  env = process.env,
  hasControllingTerminal: tty,
  runtime,
  readMeta = readCodexSessionMeta,
  observeClaudeArgs,
} = {}) {
  const override = normalizeLaunchMode(env.TIGHTBEAM_LAUNCH_MODE);
  if (override) return { launch_mode: override, signal: 'tightbeam_launch_mode' };
  refuseMalformedLaunchMode(env.TIGHTBEAM_LAUNCH_MODE);

  const fromPayload = normalizeLaunchMode(payload.launch_mode);
  if (fromPayload) return { launch_mode: fromPayload, signal: 'payload_launch_mode' };
  refuseMalformedLaunchMode(payload.launch_mode);

  const evidence = {};
  const fromHelm = normalizeLaunchMode(env.HELM_AGENT_LAUNCH_MODE);
  if (fromHelm) return { launch_mode: fromHelm, signal: 'helm_agent_launch_mode' };
  if (typeof env.HELM_AGENT_LAUNCH_MODE === 'string' && env.HELM_AGENT_LAUNCH_MODE.trim() !== '') evidence.helm_agent_launch_mode = 'ignored_unusable';

  const entrypoint = typeof env.CLAUDE_CODE_ENTRYPOINT === 'string' ? env.CLAUDE_CODE_ENTRYPOINT.toLowerCase() : '';
  if (entrypoint.startsWith('sdk')) evidence.host_headless = 'claude_code_entrypoint';
  const claude = entrypoint.startsWith('sdk') ? { mode: null, evidence: {} } : claudeLaunchMode({ env, runtime, observeArgs: observeClaudeArgs ?? (() => claudeInvocationArgs({ env })) });
  Object.assign(evidence, claude.evidence);
  if (claude.mode === 'interactive') return { launch_mode: claude.mode, signal: claude.signal, ...evidence };
  if (claude.mode) evidence.host_headless = claude.signal;

  const transcript = codexTranscriptLaunchMode({ payload, runtime, readMeta });
  Object.assign(evidence, transcript.evidence);
  if (transcript.mode === 'interactive') return { launch_mode: transcript.mode, signal: 'codex_transcript_source', ...evidence };
  if (transcript.mode) evidence.host_headless = 'codex_transcript_source';

  if (helmJobPresent(env)) return { launch_mode: 'non_interactive', signal: 'helm_job_env', ...evidence };

  const terminal = tty === undefined ? hasControllingTerminal() : Boolean(tty);
  return terminal
    ? { launch_mode: 'interactive', signal: 'controlling_terminal', ...evidence }
    : { launch_mode: null, signal: 'none', ...evidence };
}

/**
 * The launch mode alone (see resolveLaunchModeEvidence for the chain).
 * `log`, when given, receives one structured record naming the deciding
 * signal; callers pass it only at SessionStart so per-tool-call verbs,
 * which re-resolve identity on every fire, stay silent.
 */
export function resolveLaunchMode({ log, ...options } = {}) {
  const decision = resolveLaunchModeEvidence(options);
  if (typeof log === 'function') log({ event: 'launch_mode_resolved', ...decision });
  return decision.launch_mode;
}

/**
 * The session-host binding from TIGHTBEAM_HOST / TIGHTBEAM_HOST_REF. The
 * values are only validated name strings; they never select a binary, path,
 * or arguments. An invalid value is omitted with one debug record, and a ref
 * without a valid host is dropped with it.
 */
export function resolveHostBinding(env = process.env, { log } = {}) {
  const read = (field, pattern) => {
    const value = env[field];
    if (value === undefined || value === '') return null;
    if (typeof value === 'string' && pattern.test(value)) return value;
    if (typeof log === 'function') log({ event: 'host.binding_invalid', params: { field }, status: 'omitted' });
    return null;
  };
  const hostName = read('TIGHTBEAM_HOST', HOST_NAME_PATTERN);
  if (hostName === null) return { host_name: null, host_ref: null };
  return { host_name: hostName, host_ref: read('TIGHTBEAM_HOST_REF', HOST_REF_PATTERN) };
}

/**
 * One evidence phase: every record whose declared hints match, in registry
 * order. Two different runtimes matching is refused by name — picking the
 * first would let a Grok or Muse hook reading Claude-shaped config resolve
 * as claude-code and corrupt endpoint identity and resume routing (plan W2
 * «Admission gates»). Matches within one record are that runtime's own
 * spellings and are never ambiguous.
 *
 * Named codes: `ambiguous_runtime_evidence` here, `unknown_runtime` for an
 * explicit binding the registry does not hold (matching hooks_install).
 */
function resolveByEvidence(records, hintsOf, present) {
  const matched = [];
  for (const record of records) {
    if (hintsOf(record).some((hint) => present(hint)) && !matched.includes(record.id)) matched.push(record.id);
  }
  if (matched.length > 1) {
    throw namedIdentityError(
      'ambiguous_runtime_evidence',
      `runtime identity is ambiguous: ${matched.join(' vs ')} all match this session's evidence; ` +
        'bind one explicitly with --runtime or TIGHTBEAM_RUNTIME',
    );
  }
  return matched.length === 1 ? matched[0] : null;
}

/**
 * The resume axis (docs/protocol.md endpoint.register `runtime`), not the
 * trust axis, read through `registry`'s records. Transcript path first for
 * the same reason session id prefers the payload: the runtime stamps it
 * per fire, whatever env wraps the spawn
 * (helm/hooks/helm-capture-session-identity.sh:38-44).
 *
 * An explicit binding short-circuits ALL sniffing and is validated against
 * the registry — canonical ids, legacy aliases, and registered manifest
 * ids bind; anything else fails closed named BEFORE any endpoint
 * registration write. The documented escapes (`--runtime`,
 * `TIGHTBEAM_RUNTIME`, the credential file's `runtime` field) all arrive
 * through this one argument.
 */
export function resolveRuntime({ payload = {}, env = process.env, explicit, registry } = {}) {
  const activeRegistry = registry ?? defaultRegistry();
  if (typeof explicit === 'string' && explicit.length > 0) {
    const bound = activeRegistry.get(explicit);
    if (!bound) {
      throw namedIdentityError(
        'unknown_runtime',
        `unknown runtime: ${explicit} (registered runtimes: ${activeRegistry.names().join(', ')})`,
      );
    }
    return bound.id;
  }

  const records = activeRegistry.list();
  const transcript = typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
  const fromTranscript = resolveByEvidence(records, (record) => record.identity.transcriptHints, (hint) => transcript.includes(hint));
  if (fromTranscript) return fromTranscript;

  return resolveByEvidence(records, (record) => record.identity.envMarkers, (marker) => Boolean(env[marker]));
}

/** The session's working directory — the evidence a resume needs. */
export function resolveWorkingDirectory({ payload = {}, env = process.env } = {}) {
  for (const candidate of [payload.cwd, env.CLAUDE_PROJECT_DIR]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return process.cwd();
}

/**
 * The default external principal ref. A principal is the agent identity
 * that outlives any one session, so the default is the workspace the agent
 * works in, per runtime: two sessions opened on the same repository are
 * the same correspondent, and `principal.register` replays onto the same
 * row. Override with --principal-ref, TIGHTBEAM_PRINCIPAL_REF, or the
 * credential file when an application owns a different identity model.
 */
export function defaultPrincipalRef({ runtime, cwd }) {
  return `${runtime}:${cwd}`;
}
