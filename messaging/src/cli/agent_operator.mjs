// Operator verbs outside a session (ac-3d5.95, drive-liveness T5):
// `agent status --work <id> --operator` and `agent cancel --work <id> --operator
// --reason <text>`. Same trust as `agent sessions` without a caller: the same
// user, over the local socket, with the state root's credentials. Nothing here
// registers a session.

import os from "node:os";

import {
  AgentCommandError,
  runAgentCommand,
  workChain,
} from "./agent_commands.mjs";
import { deriveSessionState, ownerFacts } from "./agent_sessions.mjs";

// No caller: nothing is "you", so waiting-on reads "them" and no offer is pending.
const NO_CALLER = Object.freeze({
  principal_id: null,
  endpoint_id: null,
  process_generation: null,
  session_id: null,
});

/** Runs `run()` but fails with a named timeout when `command.deadlineMs` passes first. */
export function withDeadline(command, run) {
  if (!command.deadlineMs) return run();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const verb = command.command;
      reject(
        new AgentCommandError(
          "timeout",
          `agent ${verb} timed out after ${command.deadlineMs} ms${verb === "cancel" ? "; the cancel may have been applied, so check agent status --work before retrying" : ""}`,
          {
            details: { timeout_ms: command.deadlineMs },
          },
        ),
      );
    }, command.deadlineMs);
    run()
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}

const holderOwner = (endpoints, holder) => {
  const row =
    holder &&
    endpoints.find((endpoint) => endpoint.endpoint_id === holder.endpoint_id);
  const facts = row ? ownerFacts(row, deriveSessionState(row).state) : {};
  return {
    owner_alive: facts.owner_alive ?? null,
    activity: facts.activity ?? null,
  };
};

// How long the staged result can hold the work, so a refused cancel is never a dead end.
function stagedLine(staged) {
  const bound = staged.unbounded_reason
    ? `no give-up (${staged.unbounded_reason}): ${staged.unblocked_by}`
    : `gives up at ${staged.gives_up_at}, next retry ${staged.next_retry_at}`;
  return `staged result ${staged.message_id}: delivery ${staged.delivery_id} ${staged.delivery_state}, attempts ${staged.attempts}; ${bound}`;
}

function operatorLine(result) {
  const wakes = result.wakes;
  return [
    `updated_at: ${result.updated_at}`,
    `last_progress_at: ${result.last_progress_at}`,
    `held_until: ${result.held_until}`,
    `wakes: ${wakes.since_progress} since progress, next ${wakes.next_at}, last reason ${wakes.last_reason}`,
    `attention: ${result.attention}`,
    ...(result.staged_resolution?.delivery_id
      ? [stagedLine(result.staged_resolution)]
      : []),
    ...(result.holder
      ? [
          `holder owner_alive: ${result.holder.owner_alive}, activity: ${result.holder.activity}`,
        ]
      : []),
  ].join("\n");
}

export async function operatorStatus(client, command) {
  let operator = null;
  let endpoints = [];
  // The ordinary status read, with the operator extension asked for on the one lifecycle.view it already makes.
  const spy = {
    async request(op, payload) {
      const reply = await client.request(
        op,
        op === "lifecycle.view" ? { ...payload, operator: true } : payload,
      );
      if (op === "lifecycle.view")
        operator = reply.chains?.[0]?.operator ?? null;
      if (op === "endpoint.list") endpoints = reply.endpoints ?? [];
      return reply;
    },
  };
  let result;
  try {
    result = await runAgentCommand(spy, NO_CALLER, command);
  } catch (error) {
    if (
      error?.code === "malformed_request" &&
      /"operator"/.test(error.message ?? "")
    ) {
      throw new AgentCommandError(
        "daemon_too_old",
        "the running daemon predates agent status --operator; restart it on the current build",
        { details: { daemon_message: error.message } },
      );
    }
    throw error;
  }
  if (!operator)
    throw new AgentCommandError(
      "operator_facts_unavailable",
      "the daemon returned no operator facts for this work",
    );
  const { staged_resolution: operatorStaged, ...operatorFacts } = operator;
  const merged = {
    ...result,
    ...operatorFacts,
    // The plain view's staged_resolution keeps its fields; the operator's timing facts join it.
    staged_resolution: operatorStaged
      ? { ...result.staged_resolution, ...operatorStaged }
      : (result.staged_resolution ?? null),
    ...(result.holder
      ? {
          holder: {
            ...result.holder,
            ...holderOwner(endpoints, result.holder),
          },
        }
      : {}),
  };
  return { ...merged, rendered: `${result.rendered}\n${operatorLine(merged)}` };
}

export async function operatorCancel(client, command) {
  const chain = await workChain(client, command.workId);
  const operator = os.userInfo().username;
  let result;
  try {
    result = await client.request("lifecycle.operator_cancel", {
      root_obligation_id: chain.root_obligation_id,
      reason: command.reason,
      operator,
    });
  } catch (error) {
    if (error?.details?.reason === "work_closed") {
      throw new AgentCommandError("work_closed", error.message, {
        details: error.details,
        next_action: `agent status --work ${chain.root_obligation_id} --operator --json`,
      });
    }
    throw error;
  }
  const subject =
    typeof chain.subject === "string" && chain.subject.trim().length > 0
      ? [chain.subject]
      : [];
  return {
    outcome: "committed",
    work_id: result.root_obligation_id,
    thread_id: result.conversation_id,
    work_status: result.work_status,
    cancelled_wakes: result.cancelled_wakes,
    operator,
    reason: result.reason,
    confirmation: [
      "Cancelled",
      ...subject,
      `operator ${operator}`,
      `stopped ${result.cancelled_wakes} wake(s)`,
    ].join(" · "),
  };
}

/** Builds its own client (the verb is session-less), runs the verb, logs the boundary, and always closes the client. */
export async function runOperatorVerb(command, openClient, log = () => {}) {
  const startedAt = Date.now();
  const params = {
    verb: command.command,
    work_id: command.workId,
    timeout_ms: command.deadlineMs ?? null,
  };
  let client;
  try {
    client = await openClient();
    const result = await (command.command === "cancel"
      ? operatorCancel(client, command)
      : operatorStatus(client, command));
    log({
      event: "agent_operator",
      params,
      result: { work_status: result.work_status ?? result.outcome },
      status: "ok",
      latency_ms: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    log({
      event: "agent_operator",
      params,
      result: { code: error?.code ?? "error", message: error?.message },
      status: "error",
      latency_ms: Date.now() - startedAt,
      ...(process.env.TIGHTBEAM_HOOK_DEBUG ? { stack: error?.stack } : {}),
    });
    throw error;
  } finally {
    await client?.close();
  }
}
