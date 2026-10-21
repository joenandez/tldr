// Confirms one reviewed email-intent draft at most once. The caller has
// already shown the user the draft and received a fresh decision; this never
// runs on its own. The draft is claimed `committing` so only one confirmer
// proceeds, the commit is keyed by the draft id, and the draft resolves only
// after the observed commit outcome. A crash between commit and resolve
// leaves the claim to a dead process; the next confirm recovers it and
// re-drives the same keyed commit, which replays instead of duplicating.
import { logDraftEvent } from "./email_intent_drafts.mjs";

// Refusals that prove the current attempt committed nothing. Only a
// first-attempt claim returns to pending on one: a recovered claim follows an
// attempt that may have committed, so it stays committing with its recorded
// workspace and is reported retryable, never as unsent.
const PRE_COMMIT_REFUSALS = new Set([
  "no_outbound_channels",
  "channel_unavailable",
  "session_unavailable",
  "usage_error",
  "validation_failed",
  "DRAFT_JOB_SPEC_REQUIRED",
]);

const CLAIM_REFUSALS = Object.freeze({
  not_found: "DRAFT_NOT_FOUND",
  in_progress: "DRAFT_IN_PROGRESS",
});

export async function confirmDraft({ store, id, commit, commitCwd }) {
  const claim = store.claimCommitting(id, { commitCwd });
  if (!claim.claimed) {
    return {
      ok: false,
      code: CLAIM_REFUSALS[claim.reason],
      state: claim.reason,
    };
  }
  const { draft } = claim;
  const logged = {
    draft_id: id,
    action_kind: draft.action_kind,
    recovered: Boolean(claim.recovered),
  };
  let outcome;
  try {
    outcome = await commit(draft);
  } catch (error) {
    const definite = !claim.recovered && PRE_COMMIT_REFUSALS.has(error?.code);
    if (definite) store.release(id);
    logDraftEvent(
      definite ? "warn" : "error",
      "email_intent_draft.commit_refused",
      {
        params: logged,
        status: definite ? "released" : "committing",
        result: { code: error?.code ?? "COMMIT_FAILED" },
        ...(definite ? {} : { stack: error?.stack }),
      },
    );
    return {
      ok: false,
      code: error?.code ?? "COMMIT_FAILED",
      message: error?.message,
      state: definite ? "pending" : "committing",
      ...(definite ? {} : { retryable: true }),
    };
  }
  store.resolve(id);
  logDraftEvent("info", "email_intent_draft.committed", {
    params: logged,
    status: "resolved",
  });
  return { ok: true, state: "resolved", outcome };
}
