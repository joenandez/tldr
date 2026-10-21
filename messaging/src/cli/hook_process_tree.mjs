// Process-tree observation for the installed hook: the owner of a session
// (liveness evidence) and the facts about the runtime process that started
// it. Imports nothing from src/daemon/ (the architecture contract §5).
//
// Why this exists (F27, Codex 0.161+): the TUI no longer runs its own tool
// and hook processes. It talks to ONE managed `codex app-server` per
// CODEX_HOME over a unix socket, and every hook descends from that
// app-server, which is shared by all the TUIs and outlives each of them.
// Recording the app-server as a session's owner delayed resumes until it
// exited, made two sessions die together, and hid a reopened pane (same
// owner, so no new registration). What identifies a session's client is the
// socket: each TUI holds one accepted connection of the app-server, which
// `lsof -U` shows as `->0x<peer>` on the TUI side. The TUI is then picked by
// its own `resume <id>` argument, else by being the only connected TUI
// working in the session's folder. Anything less certain records nothing.

import fs from 'node:fs';
import { execFileSync as runFile } from 'node:child_process';

// The runtime's own binary: `codex` or a platform-suffixed Codex build.
export const CODEX_COMMAND = /^codex(-(aarch64|x86_64|arm64)-[a-z0-9_-]+)?$/i;

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LSOF_MAX_BUFFER = 64 * 1024 * 1024;

// `ps -o lstart=` is locale-formatted. Capture and the daemon's later
// re-observation must print the same bytes for the same process, so both
// pin the C locale (and collapse whitespace) rather than inherit whatever
// the hook's or the launchd daemon's environment happens to carry.
export function psEnvironment() {
  return { ...process.env, LC_ALL: 'C', LANG: 'C' };
}

const PROCESS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/;

export function observeProcessRow(pid, execFileSync = runFile) {
  // `pgid`, never `pgrp`: macOS ps rejects `pgrp` ("keyword not found")
  // and exits 1, which is why no owner was ever recorded before 42 C.
  const raw = execFileSync('ps', ['-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'lstart=', '-o', 'comm=', '-p', String(pid)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: psEnvironment(),
  });
  const match = PROCESS_ROW.exec(String(raw).split('\n').find((line) => line.trim().length > 0) ?? '');
  if (!match) return null;
  const row = {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    processGroupId: Number(match[3]),
    startIdentity: match[4].trim().replace(/\s+/g, ' '),
    command: match[5].trim(),
  };
  if (row.pid !== pid || !Number.isSafeInteger(row.ppid) || !Number.isSafeInteger(row.processGroupId) || row.processGroupId < 1 || row.startIdentity.length === 0) return null;
  return row;
}

export function commandBaseName(command) {
  const base = command.split('/').pop() ?? '';
  return base.replace(/^-/, '');
}

/** The process's full argument line, or null when ps cannot print it. */
export function readProcessArgs(pid, execFileSync = runFile) {
  try {
    const raw = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: psEnvironment() });
    const line = String(raw).split('\n').find((text) => text.trim().length > 0);
    return line === undefined ? null : line.trim();
  } catch {
    return null;
  }
}

const argTokens = (args) => args.split(/\s+/).filter(Boolean);

/** True when the process is a Codex app-server (managed daemon, proxy, daemon helper, or an IDE's stdio server). */
export function isAppServerArgs(args) {
  return argTokens(args).slice(1).includes('app-server');
}

// Options of `codex [OPTIONS] resume [OPTIONS] [SESSION_ID] [PROMPT]` (from
// `codex --help` / `codex resume --help`, 0.16x). Those that take a value
// consume the next token unless written `--opt=value`; the rest are flags.
// `-i/--image <FILE>...` takes several values and so may swallow the id:
// that shape is treated as unknown rather than guessed at.
const CODEX_VALUE_OPTIONS = new Set([
  '-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env', '-m', '--model',
  '--local-provider', '-p', '--profile', '-s', '--sandbox', '-a', '--ask-for-approval', '-C', '--cd', '--add-dir',
]);
const CODEX_FLAG_OPTIONS = new Set([
  '--last', '--all', '--include-non-interactive', '--strict-config', '--oss', '--approve-for-me',
  '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '--worktree', '--search',
  '--no-alt-screen', '--no-daemon',
]);
const SHORT_VALUE_OPTION_ATTACHED = /^-[cmpsaC]./;

/** How many tokens the option at `index` occupies, or null when it is not an option this parser knows. */
function codexOptionWidth(tokens, index) {
  const token = tokens[index];
  if (CODEX_FLAG_OPTIONS.has(token)) return 1;
  if (CODEX_VALUE_OPTIONS.has(token)) return index + 1 < tokens.length ? 2 : null;
  if (token.startsWith('--') && CODEX_VALUE_OPTIONS.has(token.split('=')[0]) && token.includes('=')) return 1;
  if (SHORT_VALUE_OPTION_ATTACHED.test(token) && CODEX_VALUE_OPTIONS.has(token.slice(0, 2))) return 1;
  return null;
}

/**
 * The session id a TUI was started on with `codex [OPTIONS] resume [OPTIONS]
 * <id>`, or null. Only that command-position `resume <id>` shows that the
 * process runs the session: `fork <id>` names the SOURCE of a new session,
 * and any other subcommand naming an id (archive, delete, queue, ...) is
 * not a TUI on it. Anything this cannot read with certainty yields null, and
 * the caller falls back to the working-directory rule.
 */
export function sessionIdFromTuiArgs(args) {
  const tokens = argTokens(args).slice(1);
  let index = 0;
  // --last only matters in an option position, before the session id: it makes
  // the positional a prompt. After the id, every word is prompt text.
  let lastOption = false;
  const skipOptions = () => {
    while (index < tokens.length && tokens[index].startsWith('-')) {
      if (tokens[index] === '--last') lastOption = true;
      const width = codexOptionWidth(tokens, index);
      if (width === null) return false;
      index += width;
    }
    return true;
  };
  if (!skipOptions() || tokens[index] !== 'resume') return null;
  index += 1;
  if (!skipOptions()) return null;
  // The first positional word is the session id (or a name, or the prompt).
  const positional = tokens[index];
  if (positional === undefined || !SESSION_ID.test(positional)) return null;
  if (lastOption) return null;
  return positional.toLowerCase();
}

// lsof lives in /usr/sbin, which a runtime's hook environment (an app-server
// started from a GUI or launchd) does not always have on PATH: observed live,
// where a bare `lsof` made every capture fail closed. The absolute path is
// tried first, the PATH lookup second.
const LSOF_COMMANDS = Object.freeze(['/usr/sbin/lsof', 'lsof']);

function runLsof(args, execFileSync) {
  for (const command of LSOF_COMMANDS) {
    try {
      return String(execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: LSOF_MAX_BUFFER }));
    } catch (error) {
      // lsof exits 1 when it could not inspect some file, yet still answers.
      if (typeof error?.stdout === 'string' && error.stdout.length > 0) return error.stdout;
      if (Buffer.isBuffer(error?.stdout) && error.stdout.length > 0) return error.stdout.toString('utf8');
      if (error?.code !== 'ENOENT') return null;
    }
  }
  return null;
}

/**
 * Pids of every process holding a unix socket whose peer is one of the
 * app-server's own sockets: the app-server's clients. null when the socket
 * table cannot be read at all (never an empty answer in its place).
 */
export function findAppServerClients(appServerPid, execFileSync = runFile) {
  const raw = runLsof(['-nP', '-U', '-F', 'pfdn'], execFileSync);
  if (raw === null) return null;
  const processes = new Map();
  let current = null;
  let socket = null;
  for (const line of raw.split('\n')) {
    if (line.length < 2) continue;
    const field = line[0];
    const value = line.slice(1);
    if (field === 'p') {
      current = { pid: Number(value), sockets: [] };
      processes.set(current.pid, current);
    } else if (current !== null && field === 'f') {
      socket = { device: null, name: null };
      current.sockets.push(socket);
    } else if (socket !== null && field === 'd') {
      socket.device = value;
    } else if (socket !== null && field === 'n') {
      socket.name = value;
    }
  }
  const server = processes.get(appServerPid);
  if (!server) return null;
  const serverDevices = new Set(server.sockets.map((entry) => entry.device).filter(Boolean));
  const clients = [];
  for (const [pid, entry] of processes) {
    if (pid === appServerPid) continue;
    if (entry.sockets.some((candidate) => candidate.name?.startsWith('->') && serverDevices.has(candidate.name.slice(2)))) clients.push(pid);
  }
  return clients;
}

/** The process's working directory (realpath form, as lsof reports it), or null. */
export function readProcessCwd(pid, execFileSync = runFile) {
  const raw = runLsof(['-nP', '-a', '-d', 'cwd', '-p', String(pid), '-F', 'n'], execFileSync);
  if (raw === null) return null;
  const line = raw.split('\n').find((text) => text.startsWith('n') && text.length > 1);
  return line === undefined ? null : line.slice(1);
}

function sameDirectory(a, b) {
  const real = (value) => {
    try {
      return fs.realpathSync(value);
    } catch {
      return value.replace(/\/+$/, '') || '/';
    }
  };
  return real(a) === real(b);
}

/**
 * The TUI that owns `sessionId`, among the clients of the managed
 * app-server `appServerPid`. Returns `{ owner, signal, ...}` for a proven
 * owner, or `{ owner: null, reason, ...counts }` for anything less. Nothing
 * here may return the app-server or a process that was not itself observed
 * connected to it.
 */
export function resolveAppServerClientOwner({ appServerPid, sessionId, cwd, captureSource, execFileSync = runFile }) {
  const unresolved = (reason, extra = {}) => ({ owner: null, reason, app_server_pid: appServerPid, ...extra });

  const clientPids = findAppServerClients(appServerPid, execFileSync);
  if (clientPids === null) return unresolved('client_discovery_failed');
  // A stdio app-server (Subspace panes, IDE extensions) has no socket
  // clients: its client is a pipe, which says nothing about a process.
  if (clientPids.length === 0) return unresolved('no_socket_clients', { clients: 0 });

  const tuis = [];
  for (const pid of clientPids) {
    let row;
    try {
      row = observeProcessRow(pid, execFileSync);
    } catch {
      row = null;
    }
    const args = row === null ? null : readProcessArgs(pid, execFileSync);
    if (row === null || args === null) return unresolved('client_unobservable', { clients: clientPids.length });
    // A proxy, an IDE bridge, anything that is not a codex TUI may be the
    // client of THIS session: the set of TUIs is then not the whole set.
    if (!CODEX_COMMAND.test(commandBaseName(row.command)) || isAppServerArgs(args)) return unresolved('non_tui_client', { clients: clientPids.length });
    tuis.push({ row, args });
  }

  const wanted = typeof sessionId === 'string' ? sessionId.toLowerCase() : null;
  const byArgument = wanted === null ? [] : tuis.filter((candidate) => sessionIdFromTuiArgs(candidate.args) === wanted);
  if (byArgument.length > 1) return unresolved('ambiguous_session_arg', { clients: tuis.length });
  if (byArgument.length === 1) return provenOwner(byArgument[0].row, 'app_server_client_session_arg', appServerPid, captureSource, { clients: tuis.length });

  if (typeof cwd !== 'string' || cwd.length === 0) return unresolved('no_session_cwd', { clients: tuis.length });
  const matches = [];
  for (const candidate of tuis) {
    const folder = readProcessCwd(candidate.row.pid, execFileSync);
    if (folder === null) return unresolved('client_cwd_unobservable', { clients: tuis.length });
    if (sameDirectory(folder, cwd)) matches.push(candidate);
  }
  if (matches.length === 1) return provenOwner(matches[0].row, 'app_server_client_cwd', appServerPid, captureSource, { clients: tuis.length });
  return unresolved(matches.length === 0 ? 'no_client_in_session_cwd' : 'ambiguous_clients_in_session_cwd', { clients: tuis.length, cwd_matches: matches.length });
}

function provenOwner(row, signal, appServerPid, captureSource, extra) {
  return {
    owner: { pid: row.pid, start_identity: row.startIdentity, process_group_id: row.processGroupId, capture_source: captureSource },
    command: commandBaseName(row.command),
    signal,
    app_server_pid: appServerPid,
    ...extra,
  };
}

// A headless Claude invocation: a print flag together with a format flag.
// `-p` alone is not enough, because the args line joins the prompt text:
// `claude explain what the -p flag does` is a TUI with a prompt.
export function claudeArgsAreHeadless(args) {
  const tokens = argTokens(args).slice(1);
  const print = tokens.includes('-p') || tokens.includes('--print');
  const format = tokens.some((token) => token === '--input-format' || token === '--output-format' || token.startsWith('--input-format=') || token.startsWith('--output-format='));
  return print && format;
}

const CLAUDE_ARGS_ANCESTOR_MAX_HOPS = 16;

/**
 * The argument line of the Claude Code process that runs this hook: the
 * process named by CLAUDE_PID when it really is a claude binary (Claude
 * exports its own pid to hooks), else the nearest claude ancestor. null when
 * neither can be observed.
 */
export function claudeInvocationArgs({ env = process.env, parentProcessId = process.ppid, execFileSync = runFile } = {}) {
  const isClaude = (row) => /^claude$/i.test(commandBaseName(row.command));
  const observe = (pid) => {
    try {
      return observeProcessRow(pid, execFileSync);
    } catch {
      return null;
    }
  };
  const claimed = Number.parseInt(env.CLAUDE_PID ?? '', 10);
  if (Number.isSafeInteger(claimed) && claimed > 0 && String(claimed) === String(env.CLAUDE_PID).trim()) {
    const row = observe(claimed);
    if (row !== null && isClaude(row)) return readProcessArgs(claimed, execFileSync);
  }
  if (!Number.isInteger(parentProcessId) || parentProcessId < 1) return null;
  let pid = parentProcessId;
  for (let hop = 0; hop < CLAUDE_ARGS_ANCESTOR_MAX_HOPS; hop += 1) {
    const row = observe(pid);
    if (row === null) return null;
    if (isClaude(row)) return readProcessArgs(pid, execFileSync);
    if (row.ppid <= 1) return null;
    pid = row.ppid;
  }
  return null;
}
