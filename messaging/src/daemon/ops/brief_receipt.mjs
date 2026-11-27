// ac-kf9rt v2: the read of an idle-wake brief's bodies. The resumer stamped
// `deliveries.brief_launch_token` on the ids its stdin brief showed with a body
// (resumer.mjs stampBriefLaunch); that launch's busy mark, sent by its own
// UserPromptSubmit pass, proves the brief was submitted to the model. Here the
// stamped rows are receipted for the endpoint's current owner, in
// admission order, through the push's writer (recordCurrentOwnerReceipt), and the next
// unread's notice is published as run_input.mjs does.
//
// Best effort, after the busy commit: every fault is logged and never fails or
// rolls back the busy mark. A row left unread stays safe (re-shown, or read at
// the reply).

import { TightbeamError } from "../../protocol/envelope.mjs";
import { withTransaction } from "../db.mjs";
import { MAX_LAUNCH_TOKEN_LENGTH } from "./endpoint_register.mjs";
import { recordCurrentOwnerReceipt } from "./message_receive_current_owner.mjs";
import { receiveOrderBy } from "./message_shared.mjs";
import { asksNothingSql } from "./delivery_admission.mjs";
import { publishSessionNotice } from "./session_notice.mjs";

// The exact owner the token names, only while it is alive and live.
function launchOwner(db, { endpointId, launchToken, appId }) {
  return db
    .prepare(
      `SELECT id, process_generation, provider_session_id, owner_epoch, owner_launch_token
       FROM endpoints
      WHERE id = ? AND owner_launch_token = ? AND created_by_app_id = ?
        AND state IN ('idle', 'busy') AND owner_process_exited_at IS NULL`,
    )
    .get(endpointId, launchToken, appId);
}

function receiptRows(db, owner, appId) {
  const rows = db
    .prepare(
      `SELECT message_id, ${asksNothingSql("d")} AS asks_nothing FROM deliveries d
      WHERE d.endpoint_id = ? AND d.brief_launch_token = ? AND d.read_at IS NULL AND d.state != 'failed'
      ORDER BY ${receiveOrderBy("d")}`,
    )
    .all(owner.id, owner.owner_launch_token)
    // Admission order (ac-jfv.171): what still asks something, then closed work.
    .sort((a, b) => a.asks_nothing - b.asks_nothing);
  const receipted = [];
  let wake = null;
  let stoppedAt = null;
  for (const { message_id: messageId } of rows) {
    // Its own transaction per row: a lost CAS keeps the receipts before it.
    const outcome = withTransaction(db, () =>
      recordCurrentOwnerReceipt(
        db,
        {
          message_id: messageId,
          endpoint_id: owner.id,
          process_generation: owner.process_generation,
          provider_session_id: owner.provider_session_id,
          owner_epoch: owner.owner_epoch,
          owner_launch_token: owner.owner_launch_token,
        },
        { appId, openAdmission: true },
      ),
    );
    // Oldest first: a row this owner cannot receipt now holds every later one.
    if (!outcome) {
      stoppedAt = messageId;
      break;
    }
    receipted.push(messageId);
    wake = outcome.wake;
  }
  return { stamped: rows.length, receipted, wake, stoppedAt };
}

/** Never throws. `context`: db, stateRoot, logger. */
export function receiptBriefBodies(
  context,
  { endpointId, launchToken, appId },
) {
  const startedAt = Date.now();
  const params = { endpoint_id: endpointId };
  try {
    const owner = launchOwner(context.db, { endpointId, launchToken, appId });
    if (!owner) {
      context.logger?.debug({
        event: "endpoint_busy_brief_receipt",
        params,
        result: { decision: "skipped", reason: "not_current_live_launch" },
        status: "ok",
      });
      return;
    }
    const outcome = receiptRows(context.db, owner, appId);
    // Logged before the publish, so a publish fault still leaves the receipt on record.
    context.logger?.[outcome.stamped > 0 ? "info" : "debug"]({
      event: "endpoint_busy_brief_receipt",
      params,
      result: {
        decision: outcome.stamped > 0 ? "receipted" : "nothing_stamped",
        stamped: outcome.stamped,
        receipted: outcome.receipted,
        stopped_at: outcome.stoppedAt,
        next_notice: outcome.wake?.deliveryId ?? null,
      },
      status: "ok",
      latency: Date.now() - startedAt,
    });
    if (outcome.wake)
      publishSessionNotice(context.db, {
        stateRoot: context.stateRoot,
        ...outcome.wake,
        wake: "next_unread",
        logger: context.logger,
      });
  } catch (error) {
    context.logger?.error({
      event: "endpoint_busy_brief_receipt",
      params,
      status: "error",
      error: error?.code ?? error?.message,
      message: error?.message,
      stack: error?.stack,
      latency: Date.now() - startedAt,
    });
  }
}

/** endpoint.state.set's `launch_token`: busy only, 1 to MAX_LAUNCH_TOKEN_LENGTH characters (R3). */
export function readLaunchToken(payload, state) {
  const token = payload.launch_token;
  if (token === undefined) return undefined;
  const valid =
    state === "busy" &&
    typeof token === "string" &&
    token.length > 0 &&
    token.length <= MAX_LAUNCH_TOKEN_LENGTH;
  if (!valid)
    throw new TightbeamError(
      "malformed_request",
      `launch_token is only valid with state "busy" and must be 1 to ${MAX_LAUNCH_TOKEN_LENGTH} characters`,
      { field: "launch_token" },
    );
  return token;
}

/** The receipt to run once the busy is recorded: none without a token or without read_inbox (R3). */
export function briefReceiptFor(
  context,
  connection,
  { endpointId, launchToken },
) {
  if (launchToken === undefined || !connection.permissions.has("read_inbox"))
    return () => {};
  return () =>
    receiptBriefBodies(context, {
      endpointId,
      launchToken,
      appId: connection.appId,
    });
}
