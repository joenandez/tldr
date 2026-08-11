export async function dispatchTldrAgentDiagnostics({
  name,
  rest,
  deps,
  schema,
  parseFlags,
  success,
  failure,
}) {
  const flags = parseFlags(rest, schema);
  if (!flags) return failure("ARGUMENT_INVALID");
  if (name === "logs") {
    const limit = Number(flags["--limit"] ?? 100);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      return failure("ARGUMENT_INVALID");
    }
    return success(await deps.inspectDiagnosticsLogs({ limit }));
  }
  if (name === "logs purge") {
    return success(await deps.purgeDiagnosticsLogs());
  }
  if (name === "diagnostics create") {
    const result = await deps.createDiagnosticReport();
    return result?.ok === true ? success(result) : failure("ARGUMENT_INVALID");
  }
  const diagnosticId = flags["--id"] ?? null;
  if (diagnosticId && !/^diag_[a-z0-9_-]+$/.test(diagnosticId)) {
    return failure("ARGUMENT_INVALID");
  }
  const result = await deps.inspectDiagnosticReport({ diagnosticId });
  return result?.ok === true ? success(result) : failure("ARGUMENT_INVALID");
}
