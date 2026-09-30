import { existsSync } from "node:fs";
import { runtimeStorePath } from "./runtime_store.mjs";
import { helmHome } from "./store.mjs";
import { withRuntimeStoreTransactionRetry } from "./runtime_store_retry.mjs";

function nowIso() {
  return new Date().toISOString();
}

function emitWarn(event, context, err) {
  process.stderr.write(
    JSON.stringify({
      level: "warn",
      event,
      context,
      error: err?.message ?? String(err),
      ts: nowIso(),
    }) + "\n",
  );
}

export function deleteDueProjectionForScope(scopeId, opts = {}) {
  const home = opts.home ?? helmHome();
  const storePath = runtimeStorePath(home);
  if (!existsSync(storePath)) return;

  const result = withRuntimeStoreTransactionRetry(
    { home, path: storePath },
    { context: { stage: "dispatch_due_projection_delete", scope_id: scopeId } },
    (db) => {
      const changes = db
        .prepare("DELETE FROM dispatch_due_index WHERE scope_id = ?")
        .run(scopeId).changes;
      return { deleted: changes };
    },
  );

  if (!result.ok) {
    emitWarn(
      "dispatch_due_projection_delete_failed",
      { scope_id: scopeId },
      result.error,
    );
  }
}
