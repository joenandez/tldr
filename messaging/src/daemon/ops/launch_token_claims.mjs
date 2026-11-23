// Who may hold a hosted run's launch token (endpoints.owner_launch_token).
// Holding it makes an endpoint eligible for hosted pushes (run_input.mjs).

import { runtimeIdEquals } from "./resume_shared.mjs";

/**
 * A Codex run host that names no session proves ownership to ANY thread under
 * its app-server (hook_process_tree findRunHost), so a second thread (a
 * subagent, if it fires SessionStart) would share the host's token and owner.
 * True when another live row of a different session already holds the token:
 * first claim wins, and the caller registers this one tokenless but keeps its owner
 * tuple (the host is alive, so the resumer's launch fence must defer its resume).
 */
export function tokenHeldByOtherSession(
  context,
  { launchToken, providerSessionId, runtime, canonicalize },
) {
  if (
    launchToken === null ||
    providerSessionId === null ||
    !runtimeIdEquals(runtime, "codex", canonicalize)
  )
    return false;
  const holder = context.db
    .prepare(
      "SELECT id FROM endpoints WHERE owner_launch_token = ? AND provider_session_id IS NOT ? AND state IN ('idle', 'busy', 'retiring') LIMIT 1",
    )
    .get(launchToken, providerSessionId);
  if (holder) {
    context.logger?.info({
      event: "endpoint_launch_token_withheld",
      params: { holder_endpoint_id: holder.id },
      result: "token_held_by_other_session",
      status: "ok",
    });
  }
  return Boolean(holder);
}

/**
 * A tokenless registration with no captured owner is not the hosted run (its
 * own hooks carry the token): the session was reopened elsewhere (pane, IDE).
 * Drop the token so hosted pushes stop; generation and epoch stay as they are.
 */
export function dropLaunchTokenOnReopen(
  context,
  existing,
  { launchMode, now },
) {
  context.db
    .prepare(
      "UPDATE endpoints SET owner_launch_token = NULL, launch_mode = COALESCE(?, launch_mode), updated_at = ? WHERE id = ?",
    )
    .run(launchMode, now, existing.id);
  if (existing.owner_launch_token !== null) {
    context.logger?.info({
      event: "endpoint_launch_token_cleared",
      endpoint_id: existing.id,
      params: { reason: "tokenless_registration_without_owner" },
      result: "hosted_push_ineligible",
      status: "ok",
    });
  }
}
