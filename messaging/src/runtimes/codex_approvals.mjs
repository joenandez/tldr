// How the run host answers a server-initiated JSON-RPC request from `codex app-server`.

const APPROVALS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);

/** Accepts an approval only under a bypass launch; otherwise cancels it, and refuses any other request. */
export function answerApprovalRequest(adapter, { id, method, params }) {
  const approval = APPROVALS.has(method);
  const fields = { params: { method, item_id: params?.itemId } };
  if (approval && adapter.bypass) {
    adapter.send({ id, result: { decision: "accept" } });
    adapter.logger.warn({
      event: "run_host.approval_auto_accepted",
      ...fields,
      status: "ok",
    });
    return;
  }
  adapter.logger.error({
    event: "run_host.approval_refused",
    ...fields,
    status: "error",
  });
  if (approval) adapter.send({ id, result: { decision: "cancel" } });
  else
    adapter.send({
      id,
      error: { code: -32601, message: `run_host cannot serve ${method}` },
    });
}
