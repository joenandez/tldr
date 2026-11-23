// `codex app-server` JSON-RPC adapter for the run host (run_host.mjs). Same
// interface as the Claude adapter, plus: start(brief) resolves with the
// thread id (the run's session, so in.sock binds under it), and the adapter
// forwards the app-server's stdout line by line so its own
// {"type":"thread.started"} echo never lands inside a JSON-RPC line. Streaming
// delta notifications are not forwarded: item/completed repeats them in full
// and no consumer reads them (performance review F1).
//
// An ack means the app-server accepted a turn/start or turn/steer carrying the
// prompt (directly or through steer recovery); a prompt logged lost answers
// `rejected`, so the daemon records no receipt and retries it. A prompt that
// cannot be written now (a turn is starting, or no thread) is refused `busy`.

import readline from "node:readline";

import { parseJsonLine } from "./claude_stream_adapter.mjs";
import { forwardLine } from "./codex_forward.mjs";
import { answerApprovalRequest } from "./codex_approvals.mjs";
import {
  flushParked,
  loseParked,
  recoverSteer,
} from "./codex_steer_recovery.mjs";
import { withHandshakeDeadline } from "./handshake_deadline.mjs";

// G2: the app-server exits ~1 s after EOF, so this is a safety net, never routine.
export const SAFETY_KILL_MS = 30_000;
// An app-server that ignores SIGTERM is killed outright this long after it.
export const SIGKILL_AFTER_MS = 5_000;

const CLOSED_ANSWER = { error: { message: "app-server closed stdout" } };
const textInput = (text) => [{ type: "text", text }];
const isDeltaNotification = (row) =>
  row?.id === undefined && /(\/d|D)elta$/.test(row?.method ?? "");

class CodexAppServerAdapter {
  ownsStdout = true;
  nextId = 0;
  waiting = new Map();
  threadId = null;
  lastTurnCompleted = false;
  // Busy from turn/start until turn/completed; the active turn id comes from turn/started.
  starting = false;
  turnId = null;
  // Turns a refused steer proved ended; their late turn/completed must not end the live turn.
  deadTurnIds = new Set();
  // Ids of prompts whose turn/start or turn/steer request has no answer yet.
  unanswered = new Set();
  // Steers refused while a replacement turn is still starting; they wait for that start to settle.
  parked = [];
  // Prompt id -> its pending answer, settled once a turn carrying it is accepted or it is lost.
  outcomes = new Map();
  closed = false;
  endRequested = false;
  inputClosed = false;
  safetyKilled = false;
  awaitingDrain = false;

  constructor({
    child,
    input,
    output,
    stdout,
    logger,
    resume,
    onIdle,
    onBusy,
    approvalPolicy,
    sandbox,
    safetyKillMs = SAFETY_KILL_MS,
    killGraceMs = SIGKILL_AFTER_MS,
    handshakeMs,
  }) {
    Object.assign(this, {
      child,
      input,
      stdout,
      logger,
      resume,
      onIdle,
      onBusy,
    });
    this.safetyKillMs = safetyKillMs;
    this.killGraceMs = killGraceMs;
    this.handshakeMs = handshakeMs;
    // Only a launch that already bypasses approvals and the sandbox may accept one unattended.
    this.bypass =
      approvalPolicy === "never" && sandbox === "danger-full-access";
    // JSON.stringify drops an undefined policy field, so the app-server default applies.
    this.policy = { approvalPolicy, sandbox };
    this.lines = readline.createInterface({
      input: output,
      crlfDelay: Infinity,
    });
    this.lines.on("line", (line) => this.onLine(line));
    this.lines.on("close", () => this.settleAll());
  }

  send(row) {
    this.input.write(`${JSON.stringify({ jsonrpc: "2.0", ...row })}\n`);
  }

  request(method, params) {
    this.nextId += 1;
    const id = this.nextId;
    // After the app-server's stdout closed nothing can answer: settle now, or the handshake waits forever.
    if (this.closed) return Promise.resolve(CLOSED_ANSWER);
    const answered = new Promise((resolve) => this.waiting.set(id, resolve));
    this.send({ id, method, params });
    return answered;
  }

  onLine(line) {
    const row = parseJsonLine(line);
    if (!isDeltaNotification(row)) this.forward(line);
    if (row?.method && row.id !== undefined) return this.answerRequest(row);
    if (row?.method) return this.onNotification(row);
    const resolve = this.waiting.get(row?.id);
    if (!resolve) return;
    this.waiting.delete(row.id);
    resolve(row);
  }

  forward(line) {
    forwardLine(this, line);
  }

  onNotification({ method, params }) {
    // A sub-agent thread's turn must not make this run look idle.
    if (params?.threadId !== this.threadId) return;
    if (method === "turn/started") {
      this.turnId = params.turn.id;
      this.starting = false;
      this.onBusy();
      flushParked(this);
    }
    if (method === "turn/completed") {
      if (this.isDeadTurn(params.turn.id)) return;
      this.turnId = null;
      this.lastTurnCompleted = params.turn.status === "completed";
      this.settle();
    }
  }

  // Only the current turn's completion idles the run: a known turn id must match, and while a
  // replacement turn is starting (id unknown) only a turn a refused steer proved dead is ignored.
  isDeadTurn(id) {
    return this.deadTurnIds.delete(id) || (this.turnId ?? id) !== id;
  }

  /** Approvals never widen beyond the launch: accept only under bypass, else cancel the turn. */
  answerRequest(row) {
    answerApprovalRequest(this, row);
  }

  /** At each turn end or failed start: the run is idle, so the host's grace may start. */
  settle() {
    this.starting = false;
    flushParked(this);
    this.idleCheck();
  }

  // Idle means no turn and no acked prompt still unanswered or parked: input never closes under one.
  idleCheck() {
    if (this.busy() || this.unanswered.size > 0) return;
    this.onIdle();
    this.closeIfIdle();
  }

  // G2: EOF mid-turn kills the running command, so stdin ends only between turns.
  closeIfIdle() {
    if (
      !this.endRequested ||
      this.inputClosed ||
      this.busy() ||
      this.unanswered.size > 0
    )
      return;
    this.inputClosed = true;
    this.input.end();
    // An app-server already gone needs no safety kill (and must not log a false one).
    if (
      this.child.exitCode ||
      this.child.signalCode ||
      this.child.exitCode === 0
    )
      return;
    const timer = setTimeout(() => this.safetyKill(), this.safetyKillMs);
    timer.unref();
    this.child.once("exit", () => clearTimeout(timer));
  }

  safetyKill() {
    this.safetyKilled = true;
    this.logger.warn({
      event: "run_host.safety_kill",
      params: { signal: "SIGTERM", after_ms: this.safetyKillMs },
      status: "error",
    });
    this.child.kill("SIGTERM");
    const escalation = setTimeout(() => this.escalateKill(), this.killGraceMs);
    escalation.unref();
    this.child.once("exit", () => clearTimeout(escalation));
  }

  escalateKill() {
    this.logger.warn({
      event: "run_host.safety_kill",
      params: { signal: "SIGKILL", after_ms: this.killGraceMs },
      status: "error",
    });
    this.child.kill("SIGKILL");
  }

  busy() {
    return this.starting || this.turnId !== null;
  }

  settleOutcome(id, error) {
    this.outcomes.get(id)?.(error);
    this.outcomes.delete(id);
  }

  lost(id, error) {
    this.settleOutcome(id, error);
    this.logger.error({
      event: "run_host.prompt_lost",
      params: { id },
      result: { error },
      status: "error",
    });
  }

  /** `id` (a prompt's delivery id, if any) is tracked until its request is answered. */
  startTurn(text, id = null, supersededId = null) {
    this.starting = true;
    this.onBusy();
    if (id) this.unanswered.add(id);
    this.request("turn/start", {
      threadId: this.threadId,
      input: textInput(text),
    }).then(({ error }) => {
      this.unanswered.delete(id);
      if (!error) {
        this.settleOutcome(id, null);
        return this.idleCheck();
      }
      this.logger.error({
        event: "run_host.turn_failed",
        result: { error },
        status: "error",
      });
      if (id) this.lost(id, error);
      // The turn this one replaced may still be running (its completion not seen yet): stay busy.
      if (
        supersededId !== null &&
        this.turnId === null &&
        this.deadTurnIds.delete(supersededId)
      ) {
        this.turnId = supersededId;
        this.starting = false;
        flushParked(this);
        return;
      }
      this.settle();
    });
  }

  steer(job) {
    const { text, id } = job;
    const params = {
      threadId: this.threadId,
      expectedTurnId: this.turnId,
      input: textInput(text),
    };
    this.unanswered.add(id);
    this.request("turn/steer", params).then(({ error }) => {
      this.unanswered.delete(id);
      if (!error) {
        this.settleOutcome(id, null);
        return this.idleCheck();
      }
      this.logger.warn({
        event: "run_host.control_failed",
        params: {
          method: "turn/steer",
          expected_turn_id: params.expectedTurnId,
        },
        result: { error },
        status: "error",
      });
      this.recover({ ...job, turnId: params.expectedTurnId }, error);
      this.idleCheck();
    });
  }

  recover(job, error) {
    recoverSteer(this, job, error);
  }

  undelivered() {
    return this.unanswered.size;
  }

  // An app-server gone mid-request answers nothing; settle every waiter.
  settleAll() {
    this.closed = true;
    loseParked(this);
    for (const resolve of this.waiting.values()) resolve(CLOSED_ANSWER);
    this.waiting.clear();
  }

  async openThread() {
    await this.request("initialize", {
      clientInfo: { name: "run_host", version: "1" },
      capabilities: null,
    });
    this.send({ method: "initialized", params: {} });
    const opened = this.resume
      ? await this.request("thread/resume", {
          threadId: this.resume,
          ...this.policy,
        })
      : await this.request("thread/start", {
          cwd: process.cwd(),
          ...this.policy,
        });
    if (opened.error) {
      this.logger.error({
        event: "run_host.thread_failed",
        params: { resume: this.resume },
        result: { error: opened.error },
        status: "error",
      });
    }
    return opened.result?.thread?.id ?? null;
  }

  // A wedged app-server answers nothing: give up on the open so input ends and the safety kill reaps it.
  openThreadBounded() {
    return withHandshakeDeadline(this.openThread(), this.handshakeMs, () => {
      this.logger.warn({
        event: "run_host.handshake_timeout",
        params: { resume: this.resume },
        result: { after_ms: this.handshakeMs },
        status: "error",
      });
      return null;
    });
  }

  async start(brief) {
    this.threadId = await this.openThreadBounded();
    if (!this.threadId) {
      this.endInput();
      return null;
    }
    this.stdout.write(
      `${JSON.stringify({ type: "thread.started", thread_id: this.threadId })}\n`,
    );
    this.startTurn(brief);
    return this.threadId;
  }

  /** Resolves "steer" or "queue" once the app-server accepted a turn carrying the text, else {refused}. */
  prompt(text, _deliver, id) {
    const steering = Boolean(this.turnId);
    if (!this.threadId || this.closed || (this.starting && !steering))
      return { refused: "busy" };
    const mode = steering ? "steer" : "queue";
    const answered = new Promise((resolve) =>
      this.outcomes.set(id, (error) =>
        resolve(error ? { refused: "rejected" } : mode),
      ),
    );
    if (steering) this.steer({ text, id });
    else this.startTurn(text, id);
    return answered;
  }

  endInput() {
    this.endRequested = true;
    this.closeIfIdle();
  }

  /** The app-server's own failure code wins; otherwise the run succeeds iff its last turn completed. */
  exitCode(code) {
    if (code !== 0 && !this.safetyKilled) return code;
    return this.lastTurnCompleted ? 0 : 1;
  }
}

export const createCodexAdapter = (options) =>
  new CodexAppServerAdapter(options);
