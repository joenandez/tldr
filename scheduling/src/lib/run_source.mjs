function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function conflict(runId, field, values) {
  return Object.assign(
    new Error(
      `run ${runId} has conflicting ${field} values: ${values.join(", ")}`,
    ),
    { code: "run_source_conflict", run_id: runId, field, values },
  );
}

export function resolveRunSource(runId, events) {
  const scopeIds = new Set();
  const cwds = new Set();
  for (const event of events) {
    const explicit =
      Object.hasOwn(event, "source_scope_id") ||
      Object.hasOwn(event, "source_cwd");
    if (event.payload?.ledger === true && !explicit) continue;
    const scopeId = nonEmptyString(
      explicit ? event.source_scope_id : event.scope_id,
    );
    const cwd = nonEmptyString(explicit ? event.source_cwd : event.cwd);
    if (scopeId) scopeIds.add(scopeId);
    if (cwd) cwds.add(cwd);
  }
  if (scopeIds.size > 1) {
    throw conflict(runId, "source_scope_id", [...scopeIds]);
  }
  if (cwds.size > 1) throw conflict(runId, "source_cwd", [...cwds]);
  return {
    source_scope_id: [...scopeIds][0] || null,
    source_cwd: [...cwds][0] || null,
  };
}
