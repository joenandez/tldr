// `agent delegate --work <id> --at <time>` (thread-followups C2): park the
// request on an `update` that carries `wake_at`. The body goes where a
// reply's update goes: the user's origin channel, or the thread for an agent
// requester. While the user ack is still pending the update is the ack.

import { ackPending } from "./agent_reply_flow.mjs";
import { runWorkCommand, workChain } from "./agent_commands.mjs";
import { parseWaitTimeout } from "./agent_wait.mjs";

const AT_FORMS =
  "--at requires a duration such as 2m or +1h, or an ISO-8601 time with a timezone such as 2026-10-28T15:00:00Z";
const ISO_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;

/** @returns {string} ISO-8601 UTC wake time; throws RangeError naming --at. */
export function parseWakeAt(value, now = Date.now()) {
  let at;
  if (ISO_WITH_ZONE.test(value)) {
    at = Date.parse(value);
  } else {
    try {
      at = now + parseWaitTimeout(value.replace(/^\+/, ""));
    } catch (error) {
      throw new RangeError(
        `${AT_FORMS} (${error.message.replace("--timeout", "--at")})`,
      );
    }
  }
  if (Number.isNaN(at)) throw new RangeError(AT_FORMS);
  if (at <= now) throw new RangeError("--at must be a time in the future");
  return new Date(at).toISOString();
}

export async function delegateAt({ client, session, runOnce }, command) {
  const chain = await workChain(client, command.workId);
  const parked = ackPending(chain)
    ? await runOnce(client, session, { ...command, command: "ack" })
    : await runWorkCommand(client, session, command, chain, "update");
  // A user requester's channel delivery replaces this label (deliveryConfirmation).
  return {
    ...parked,
    wake_at: command.wakeAt,
    confirmation: `Request parked until ${command.wakeAt}; message queued to the requester`,
  };
}
