// Claude `--input-format stream-json` adapter for the run host
// (run_host.mjs). An adapter owns the agent's wire format on the child's
// stdin and stdout; the host owns the socket, the replay table and the input
// lifetime. Interface: start(brief), prompt(text, deliver) -> delivered,
// endInput(); it calls onIdle() when the agent is idle with no background
// task, and onBusy() when it starts work again.

import { randomUUID } from "node:crypto";
import readline from "node:readline";

export function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

const RETRY_MS = 2_000;
const RETRY_BUDGET_MS = 30_000;

const WARN_OUTCOMES = new Set(["budget", "refused"]);

const isSystem = (row, subtype) =>
  row?.type === "system" && row.subtype === subtype;

const isControlError = (row) =>
  row?.type === "control_response" && row.response?.subtype === "error";

// A refused control ends the loop that sent it: one warn, not one per retry.
const refuseOnControlError = (row, logger, steerRetry) => {
  if (!isControlError(row)) return;
  logger.warn({
    event: "run_host.control_failed",
    params: { request_id: row.response.request_id },
    result: { error: row.response.error },
    status: "error",
  });
  steerRetry.refused(row.response.request_id);
};

// The re-send loop for steers: one at a time, ended once, logged once.
// `resend` writes a control and returns its request_id.
function createSteerRetry({
  resend,
  logger,
  timers = { setInterval, clearInterval },
}) {
  let loop = null;
  const stop = (outcome) => {
    if (!loop) return;
    timers.clearInterval(loop.timer);
    const { attempts } = loop;
    loop = null;
    logger[WARN_OUTCOMES.has(outcome) ? "warn" : "info"]({
      event: "run_host.steer_background",
      params: { attempts },
      result: { outcome },
    });
  };
  const tick = (state) => {
    if (++state.ticks * RETRY_MS >= RETRY_BUDGET_MS) stop("budget");
    else {
      state.attempts++;
      state.sent.add(resend());
    }
  };
  return {
    stop,
    // A late refusal of an earlier loop's control must not end this one.
    refused(requestId) {
      if (loop?.sent.has(requestId)) stop("refused");
    },
    tasksChanged(count) {
      if (!loop) return;
      loop.baseline = Math.min(loop.baseline, count);
      if (count > loop.baseline) stop("backgrounded");
    },
    // A steer writes the control, then the user line, then starts the loop;
    // a steer during a loop restarts its 30 s budget from that steer. A
    // queued prompt writes only the user line.
    // shortcut: a retry after Claude consumed the user line may background a
    // step the agent began for that line; accepted, the 30 s bound limits it.
    deliver(isSteer, baseline, writeUser) {
      const requestId = isSteer && resend();
      writeUser();
      if (!isSteer) return;
      if (loop) {
        loop.ticks = 0;
        loop.sent.add(requestId);
        return;
      }
      const state = {
        attempts: 0,
        ticks: 0,
        baseline,
        sent: new Set([requestId]),
      };
      state.timer = timers.setInterval(() => tick(state), RETRY_MS).unref();
      loop = state;
    },
  };
}

/**
 * Busy and idle come from Claude's own events (G1, 2.1.322):
 * system/session_state_changed running|idle, including turns Claude starts
 * itself on a task_notification, and system/background_tasks_changed, whose
 * `tasks` lists the backgrounded steps still running. A CLI that sends no
 * session_state_changed falls back to: busy from a written user line until
 * the next `result` row. A steer while busy sends a `background_tasks`
 * control first (G1: the CLI backgrounds the foreground step and answers).
 * An early push (~2 s into a step) can be ignored, so the control is re-sent
 * every 2 s, up to 30 s, until the step backgrounds, the agent idles or input ends.
 * A refused control still leaves the user line queued for the next turn
 * boundary, so it costs only a warn.
 */
export function createClaudeAdapter({
  input,
  output,
  logger,
  onIdle,
  onBusy = () => {},
  timers,
}) {
  let busy = false;
  let backgroundTasks = 0;
  let reportsState = false;
  const steerRetry = createSteerRetry({
    resend: () => {
      const request_id = `run_host-${randomUUID()}`;
      send({
        type: "control_request",
        request_id,
        request: { subtype: "background_tasks" },
      });
      return request_id;
    },
    logger,
    timers,
  });
  const setBusy = (value) => {
    busy = value;
    if (busy) onBusy();
    else {
      steerRetry.stop("idle");
      if (backgroundTasks === 0) onIdle();
    }
  };
  const send = (row) => input.write(`${JSON.stringify(row)}\n`);
  const sendUser = (text) => {
    send({ type: "user", message: { role: "user", content: text } });
    setBusy(true);
  };
  const track = (row) => {
    if (isSystem(row, "session_state_changed")) {
      reportsState = true;
      setBusy(row.state !== "idle");
    }
    if (isSystem(row, "background_tasks_changed") && Array.isArray(row.tasks)) {
      backgroundTasks = row.tasks.length;
      steerRetry.tasksChanged(backgroundTasks);
      if (!busy && backgroundTasks === 0) onIdle();
    }
    if (row?.type === "result" && !reportsState) setBusy(false);
  };
  readline
    .createInterface({ input: output, crlfDelay: Infinity })
    // stdout closed: the agent is gone (the host never calls endInput then).
    .on("close", () => steerRetry.stop("exited"))
    .on("line", (line) => {
      const row = parseJsonLine(line);
      track(row);
      refuseOnControlError(row, logger, steerRetry);
    });
  return {
    start: (brief) => sendUser(brief),
    prompt(text, deliver) {
      const delivered = deliver === "steer" && busy ? "steer" : "queue";
      steerRetry.deliver(delivered === "steer", backgroundTasks, () =>
        sendUser(text),
      );
      return delivered;
    },
    endInput: () => {
      steerRetry.stop("ended");
      input.end();
    },
  };
}
