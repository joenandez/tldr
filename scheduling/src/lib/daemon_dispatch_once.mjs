import {
  buildChildSampleRecord,
  classifyChildKind,
} from "./perf_attribution.mjs";

export async function launchDispatchOnceForAirlock({
  dispatchScopes,
  schedulerScriptPath,
  daemonInstanceId,
  spawnDispatchChild,
  appendPerfEvent,
}) {
  // The once-path always spawns dispatch children — argv[1] === "dispatch" —
  // so child_kind is always "dispatch_evaluator". We classify via the shared
  // helper to remain consistent with the main daemon path and satisfy AC 0.1.3.
  const childArgv = [schedulerScriptPath, "dispatch"];
  const childKind = classifyChildKind(childArgv);

  return Promise.all(
    dispatchScopes.map(
      (scope) =>
        new Promise((done) => {
          const launched = spawnDispatchChild(
            scope,
            schedulerScriptPath,
            daemonInstanceId,
          );
          if (launched.skipped) {
            done(launched);
            return;
          }
          const { child } = launched;
          const launchedAtMs = Date.now();
          const launchRecord = buildChildSampleRecord({
            lifecycle: "launch",
            scope_id: scope.scope_id,
            cwd: scope.cwd,
            pid: child.pid || null,
            child_kind: childKind,
            daemon_instance_id: daemonInstanceId,
            single_flight_enabled: false,
          });
          if (launchRecord) appendPerfEvent(launchRecord);
          child.stderr.on("data", (chunk) => process.stderr.write(chunk));
          child.on("error", (err) => {
            const errorRecord = buildChildSampleRecord({
              lifecycle: "error",
              scope_id: scope.scope_id,
              cwd: scope.cwd,
              pid: child.pid || null,
              child_kind: childKind,
              daemon_instance_id: daemonInstanceId,
              duration_ms: Date.now() - launchedAtMs,
              error: err.message,
            });
            if (errorRecord) appendPerfEvent(errorRecord);
            done({
              scope,
              code: 1,
              signal: null,
              ok: false,
              error: err.message,
            });
          });
          child.on("close", (code, signal) => {
            const closeRecord = buildChildSampleRecord({
              lifecycle: "close",
              scope_id: scope.scope_id,
              cwd: scope.cwd,
              pid: child.pid || null,
              child_kind: childKind,
              daemon_instance_id: daemonInstanceId,
              duration_ms: Date.now() - launchedAtMs,
              code,
              signal,
              single_flight_release_status: "not_enabled",
            });
            if (closeRecord) appendPerfEvent(closeRecord);
            done({ scope, code, signal, ok: code === 0 });
          });
        }),
    ),
  );
}
