import { startRun } from "./dispatch_service.mjs";

// Dispatches a held slot through the normal startRun path, so the concurrency
// cap and the ledger's duplicate / identity_in_flight guards still apply.
// startRun never checks job.state.enabled, so a once-job (enabled:false after
// its first failure) dispatches here for this slot only.
//
// Returns startRun's result unchanged: a running handle ({runId, completion,
// ...}), { skipped: true, reason, ledgerClaim, ... } when the ledger refuses
// (identity_in_flight, duplicate_logical_run, retry_exhausted), or null when
// the concurrency cap defers the run.
export function startHeldRun(scope, job, { slot, heldAttempt } = {}) {
  if (!slot) throw new Error("startHeldRun requires the held slot");
  return startRun(scope, job, {
    reason: "held_release",
    scheduledAt: slot,
    heldAttempt,
    // The completion persist gives up by the hold's deadline (fgp.48).
    heldDeadline: job.state?.held?.deadline ?? null,
  });
}
