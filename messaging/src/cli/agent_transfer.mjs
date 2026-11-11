// `agent transfer`: the holder moves its open work to another exact session
// through the daemon's recovery.transfer. Unlike delegate there is no offer
// and no kept debt: the target owes the final response from here on.

import { shortThreadId } from "./agent_threads.mjs";
import { tightbeamRecipeCommand } from "./package_context.mjs";

/**
 * @param {{request: Function}} client
 * @param {object} session the caller's bound session
 * @param {object} work the parsed command ({workId, to, body?}) plus workChain, selectCustodiedWork, resolveAgent, commitKey, exactConfirmation from agent_commands
 */
export async function runTransfer(
  client,
  session,
  {
    command,
    workChain,
    selectCustodiedWork,
    resolveAgent,
    commitKey,
    exactConfirmation,
  },
) {
  const chain = await workChain(client, command.workId);
  let custodyError = null;
  try {
    selectCustodiedWork(chain, session, command.workId);
  } catch (error) {
    custodyError = error;
  }
  const target = await resolveAgent(client, session, command.to, {
    verb: "transfer",
    command,
  });
  // A retry after success finds the target already holding the work; the daemon replays it by key.
  const alreadyMoved = (chain.attempts ?? []).some(
    (node) =>
      node.status === "open" &&
      node.custodian_endpoint_id === target.endpoint_id,
  );
  if (custodyError && !alreadyMoved) {
    // The shared custody refusal speaks of operator recovery; a transfer has one rule.
    custodyError.message =
      "only the session that holds this work can transfer it";
    custodyError.next_action = `${tightbeamRecipeCommand()} agent thread --thread ${shortThreadId(chain.conversation_id)}`;
    throw custodyError;
  }
  const result = await client.recoveryTransfer({
    root_obligation_id: chain.root_obligation_id,
    root_generation: chain.generation,
    target_endpoint_id: target.endpoint_id,
    sender_principal_id: session.principal_id,
    sender_endpoint_id: session.endpoint_id,
    process_generation: session.process_generation,
    idempotency_key: commitKey("transfer", command, "transfer"),
    ...(command.body ? { body: command.body } : {}),
  });
  return {
    outcome: "committed",
    work_id: chain.root_obligation_id,
    thread_id: chain.conversation_id,
    transferred_to_endpoint_id: result.endpoint_id,
    attempt_id: result.attempt_id,
    idempotent_replay: result.idempotent_replay,
    resolved: target.resolved,
    confirmation: await exactConfirmation(
      client,
      "Transferred",
      target.resolved,
      {
        subject: chain.subject ?? null,
        conversationId: chain.conversation_id,
        tail: ["final response is now theirs"],
      },
    ),
  };
}
