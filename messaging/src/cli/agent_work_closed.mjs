// The one refusal for any agent verb on closed work (ac-2ih35). Closed work is
// not lost custody: update/complete/park/delegate/cancel on it say who closed
// it and when, and that nothing is left to recover. recovery_authority_required
// stays for an open root whose custody this session lost.

import { AgentCommandError } from "./agent_commands.mjs";
import { isRequester } from "./agent_reply_flow.mjs";
import { shortThreadId } from "./agent_threads.mjs";
import { tightbeamRecipeCommand } from "./package_context.mjs";

// From lifecycle.view's closing facts: an operator, the requester (or its
// lineage replacement), or a holder; null when the closer is unknown.
function closedBy(chain) {
  const { source, closed_by_endpoint_id: by } = chain.resolution;
  const holders = [...(chain.attempts ?? []), ...(chain.delegations ?? [])].map(
    (node) => node.custodian_endpoint_id,
  );
  // An endpoint closer wins: a session's own source string never makes it an operator.
  const party = !by
    ? null
    : isRequester(chain, { endpoint_id: by })
      ? "the requester"
      : holders.includes(by)
        ? "its holder"
        : null;
  const operator =
    !by && typeof source === "string" && source.startsWith("operator_cancel:")
      ? `operator ${source.slice("operator_cancel:".length)}`
      : null;
  return party ?? operator;
}

// A node its own holder finished: only the custodian of a node may complete
// or cancel it (daemon requireTerminalCustody). Failed and superseded nodes
// are custody loss and keep the recovery refusal.
const FINISHED_NODE = new Set(["fulfilled", "cancelled"]);

/**
 * @param {object} chain a lifecycle.view chain
 * @param {object|null} node the named node its holder finished while the root
 *   stays open; null when the root itself is closed (chain.resolution set)
 */
export function workClosedError(chain, node = null) {
  const thread = shortThreadId(chain.conversation_id);
  const closed = node
    ? { resolution: node.resolution, source: null, closed_at: node.closed_at }
    : chain.resolution;
  const {
    resolution = null,
    source = null,
    closed_at: closedAt = null,
  } = closed;
  const by = node ? "its holder" : closedBy(chain);
  const label = resolution === "cancelled" ? "cancelled" : "done";
  const what = node
    ? `Work ${node.obligation_id} on ${thread}`
    : `Work on ${thread}`;
  return new AgentCommandError(
    "work_closed",
    `${what} is ${label}. Closed${by ? ` by ${by}` : ""}${closedAt ? ` at ${closedAt}` : ""}; stop, nothing to recover.`,
    {
      details: {
        root_id: chain.root_obligation_id,
        ...(node ? { obligation_id: node.obligation_id } : {}),
        resolution,
        source,
        closed_by: by,
        closed_at: closedAt,
      },
      next_action: `${tightbeamRecipeCommand()} agent thread --thread ${thread}`,
    },
  );
}

/**
 * The work_closed refusal for a session outside custody, or null for real
 * custody loss: the root is closed, or the node this session finished is
 * named by its id, or by the root id its notices carry when every node this
 * session held is finished (any lost node keeps the recovery refusal).
 */
export function closedWorkError(chain, session, requestedWorkId) {
  if (chain.resolution) return workClosedError(chain);
  const nodes = [...(chain.attempts ?? []), ...(chain.delegations ?? [])];
  const held = nodes.filter(
    (node) => node.custodian_endpoint_id === session.endpoint_id,
  );
  const mine =
    nodes.find((node) => node.obligation_id === requestedWorkId) ??
    (requestedWorkId === chain.root_obligation_id &&
    held.length > 0 &&
    held.every((node) => FINISHED_NODE.has(node.resolution))
      ? held.at(-1)
      : undefined);
  return FINISHED_NODE.has(mine?.resolution)
    ? workClosedError(chain, mine)
    : null;
}
