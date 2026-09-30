#!/usr/bin/env node
import { appendPerfEvent } from "./resource_sampler.mjs";
import { hydrateRegisteredScopes } from "./scopes.mjs";

function output(ok, data = {}, errors = []) {
  process.stdout.write(
    `${JSON.stringify({
      ok,
      command: "daemon-maintenance",
      timestamp: new Date().toISOString(),
      data,
      errors,
    })}\n`,
  );
}

async function main() {
  const command = process.argv[2] || null;
  const daemonInstanceArgIndex = process.argv.indexOf("--daemon-instance-id");
  const daemonInstanceId =
    process.env.HELM_DAEMON_INSTANCE_ID ||
    (daemonInstanceArgIndex >= 0
      ? process.argv[daemonInstanceArgIndex + 1]
      : null) ||
    null;
  const scopes = hydrateRegisteredScopes();
  if (command === "due-reconcile") {
    const { runDueProjectionReconcile } = await import(
      "./dispatch_due_reconcile.mjs"
    );
    const result = runDueProjectionReconcile({
      scopes,
      daemonInstanceId,
      sink: appendPerfEvent,
    });
    output(true, { result });
    return;
  }
  if (command === "retention-gc") {
    const { runScheduledRetention } = await import("./retention_service.mjs");
    const result = runScheduledRetention({ scopes });
    output(true, { result });
    return;
  }
  output(false, {}, [
    {
      code: "unknown_command",
      message: `unknown daemon maintenance command: ${command || ""}`,
    },
  ]);
  process.exit(2);
}

main().catch((err) => {
  output(false, {}, [
    {
      code: err?.code || "runtime_error",
      message: err?.message || String(err),
    },
  ]);
  process.exit(1);
});
