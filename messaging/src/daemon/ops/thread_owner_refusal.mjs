// ac-32qki PR 2: on an owned thread a session post is admitted only from the newest session of an
// owner, as an offered session's accept or decline, or as work the sender holds; the rest is refused.
import { TightbeamError } from "../../protocol/envelope.mjs";
import { tightbeamCommandName } from "../../cli/package_context.mjs";
import { newest, ownersOf } from "./thread_owners.mjs";

// A session that holds an open obligation must be able to update or close it, or that work can never
// close: a work action with its own custody check (requireCustody, passed in), not steering.
function holdsNamedWork(db, { conversationId, effect, requireCustody }) {
  const node =
    typeof effect.obligation_id === "string"
      ? db
          .prepare(
            "SELECT * FROM obligations WHERE id = ? AND conversation_id = ? AND status = 'open'",
          )
          .get(effect.obligation_id, conversationId)
      : undefined;
  try {
    if (node)
      requireCustody(db, { node, senderEndpointId: effect.sender_endpoint_id });
    return Boolean(node);
  } catch (error) {
    if (error instanceof TightbeamError) return false;
    throw error;
  }
}

const isAdmitted = (db, args, owners) =>
  owners.length === 0 ||
  owners.some((id) => newest(db, id) === args.effect.sender_endpoint_id) ||
  ["handoff.accept", "handoff.decline"].includes(args.effect.type) ||
  holdsNamedWork(db, args);

// The owner a refused sender is told to reach: the owner on its own side (same principal), else the
// target owner, as its newest endpoint. `agent send --to session:` takes a provider session id, and
// only a live endpoint that has one can be sent to; a placeholder or restart window has none yet.
function ownerToReach(db, owners, senderEndpointId) {
  const principalOf = (id) =>
    db.prepare("SELECT principal_id FROM endpoints WHERE id = ?").get(id)
      ?.principal_id;
  const owner = newest(
    db,
    owners.find((id) => principalOf(id) === principalOf(senderEndpointId)) ??
      owners.at(-1),
  );
  const row = db
    .prepare("SELECT provider_session_id, state FROM endpoints WHERE id = ?")
    .get(owner);
  const live = row?.provider_session_id && row.state !== "closed";
  return { owner, session: live ? row.provider_session_id : null };
}

function refusalText(session) {
  const cli = tightbeamCommandName();
  if (session) {
    const sendTo = `${cli} agent send --to session:${session}`;
    return {
      action: sendTo,
      message: `this thread is owned by session ${session}; your session is not an owner. Start a new thread to it (${sendTo}) or ask it to transfer the thread to you.`,
    };
  }
  const threads = `${cli} agent threads`;
  return {
    action: threads,
    message: `this thread is owned by a session that is starting or restarting; your session is not an owner. Retry on this thread shortly, or check ${threads}.`,
  };
}

/**
 * Refuses a session post on an owned thread unless the sender is the newest session of an owner, answers
 * an offer made to it (accept or decline: that reply is the pass), or acts on open work it holds.
 * Unowned threads (NULL owners: every old thread) and user-channel posts are never checked.
 */
export function refuseNonOwner(db, args) {
  const { conversationId, effect, sendBranch, logger } = args;
  if (sendBranch !== "agent" || typeof effect.sender_endpoint_id !== "string")
    return;
  const owners = Object.values(ownersOf(db, conversationId)).filter(Boolean);
  if (isAdmitted(db, args, owners)) return;
  const { owner, session } = ownerToReach(
    db,
    owners,
    effect.sender_endpoint_id,
  );
  logger?.warn?.({
    event: "thread_post_refused",
    params: { conversation_id: conversationId, effect: effect.type },
    result: {
      sender_endpoint_id: effect.sender_endpoint_id,
      owner_endpoint_id: owner,
      owner_state: session ? "live" : "starting", // which advice branch ran
    },
    status: "refused",
  });
  const { action, message } = refusalText(session);
  throw new TightbeamError("thread_not_owner", message, {
    conversation_id: conversationId,
    owner_endpoint_id: owner,
    owner_session_id: session,
    safe_action: action,
  });
}
