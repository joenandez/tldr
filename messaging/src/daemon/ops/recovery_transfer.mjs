// recovery.transfer — a holder hands its open work to another session. Same
// grant and scope as recovery.switch; the engine (lifecycle_transfer.mjs)
// checks that the caller holds the work.

import { transferWork } from "../lifecycle_transfer.mjs";

export const recoveryTransferOp = {
  name: "recovery.transfer",
  allowedScopes: ["agent"],
  permission: "manage_obligations",
  handler(context, payload, connection) {
    const { result } = transferWork(context, connection, payload);
    return { result };
  },
};
