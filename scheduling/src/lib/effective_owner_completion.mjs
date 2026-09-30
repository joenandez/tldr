// effective_owner_completion — shared "accepted work completed" evidence check.
//
// A run's work completion needs run-owned evidence. Delivery and conversation
// evidence remain separately projected from the report; they never establish
// work success for a missing or mismatched report.

import { join } from "node:path";

import { helmHome, readJsonIfExists, scopeHash } from "./store.mjs";

export function scopeForEffectiveOwnerCheck({
  scope = null,
  scopeId = null,
  home = helmHome(),
} = {}) {
  if (scope && scope.storage_root) return scope;
  const id = scope?.scope_id || scopeId;
  if (!id) return null;
  return {
    scope_id: id,
    cwd: scope?.cwd || id,
    storage_root:
      scope?.storage_root || join(home, "workspaces", scopeHash(id)),
  };
}

export function runSatisfiedReportSidecar({
  scope = null,
  scopeId = null,
  home = helmHome(),
  runId = null,
  jobId = null,
} = {}) {
  const resolved = scopeForEffectiveOwnerCheck({ scope, scopeId, home });
  if (!resolved) return { satisfied: false, reason: "no_scope" };
  if (!runId) return { satisfied: false, reason: "no_run_id" };
  if (!jobId) return { satisfied: false, reason: "no_job_id" };

  const report = readJsonIfExists(
    join(
      resolved.cwd || resolved.scope_id,
      ".helm",
      "runs",
      "reports",
      `${runId}.json`,
    ),
    null,
  );
  if (!report) return { satisfied: false, reason: "no_report_sidecar" };
  if (report.run_id !== runId || report.job_id !== jobId) {
    return { satisfied: false, reason: "report_identity_mismatch" };
  }
  if (report.status !== "ok") {
    return { satisfied: false, reason: "report_status_not_ok" };
  }
  return {
    satisfied: true,
    via: "report_sidecar",
    satisfying_message_id: runId,
    report_status: report.status,
    report_summary: report.summary || null,
  };
}
