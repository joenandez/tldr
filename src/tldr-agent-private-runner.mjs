#!/usr/bin/env node

// This private scheduler is not a messaging CLI. It only bridges the verified
// AgentMail surface to the registered Tightbeam email route.
import "./lib/node_sqlite_warning.mjs";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fail, output, parseArgs } from "./lib/json_io.mjs";
import { resolveDaemonCommandScope } from "./lib/tldr_agent_daemon_scope.mjs";

const CHANNEL_POLL_VERB = "__tldr-agent-channel-poll";

export function reportOutboundFailure(outbound) {
  if (outbound?.ok !== false || outbound.code === "claim_unavailable") return;
  throw Object.assign(new Error("Tightbeam email delivery failed"), {
    code: outbound.error || outbound.code || "email_delivery_failed",
    details: outbound,
  });
}

function withScope(scope, data = {}) {
  return {
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    storage_root: scope.storage_root,
    ...data,
  };
}

async function assertPrivateRuntimeEnabled() {
  const { assertDesiredStateAllowsStart, assertHelmHomeSafe } = await import(
    "./lib/runtime_store.mjs"
  );
  assertDesiredStateAllowsStart({ initialize: false });
  assertHelmHomeSafe();
}

export async function pollChannel({ scope, dependencies = null }) {
  await (
    dependencies?.assertPrivateRuntimeEnabled || assertPrivateRuntimeEnabled
  )();
  const loaded = dependencies
    ? dependencies
    : await Promise.all([
        import("./lib/transports/email.mjs"),
        import("./lib/tightbeam_channel.mjs"),
        import("./lib/tightbeam_email_adapter.mjs"),
      ]).then(([email, channel, adapter]) => ({
        channel: channel.createTightbeamChannel(),
        createAdapter: adapter.createTightbeamEmailAdapter,
        pollInbox: email.pollInbox,
        send: email.emailTransport.send,
      }));
  const channel = loaded.channel;
  const preflight = await channel.preflight();
  if (preflight?.ok !== true) {
    throw Object.assign(
      new Error(preflight?.error?.remediation || "Tightbeam preflight failed"),
      {
        code: preflight?.error?.code || "tightbeam_preflight_failed",
        details: {
          remediation:
            preflight?.error?.remediation || "Tightbeam preflight failed",
        },
      },
    );
  }
  const outbound = await loaded
    .createAdapter({
      channel,
      send: loaded.send,
    })
    .deliverOnce();
  const inbound = await loaded.pollInbox({
    scope,
    dispatch: true,
    tightbeamInbound: {
      findThreadBinding: channel.findThreadBinding,
      publishInboundEmail: channel.publishInboundEmail,
    },
  });
  reportOutboundFailure(outbound);
  if (!inbound?.ok) {
    throw Object.assign(
      new Error(
        inbound?.hint || outbound?.error || "Tightbeam email channel failed",
      ),
      {
        code: inbound?.error || outbound?.error || "tightbeam_channel_failed",
        details: { inbound, outbound },
      },
    );
  }
  return withScope(scope, { inbound, outbound });
}

export async function runPrivateRunner(argv = process.argv.slice(2)) {
  const { positionals, flags } = parseArgs(argv);
  const command = positionals[0] || "";
  const pretty = Boolean(flags.pretty);
  const scope = resolveDaemonCommandScope({
    cwd:
      flags.scope || flags.cwd || process.env.HELM_SCOPE_CWD || process.cwd(),
  });
  if (command !== CHANNEL_POLL_VERB) {
    fail(
      "private",
      "command_removed",
      "This command is not part of tldr;.",
      withScope(scope),
      pretty,
    );
    return 2;
  }
  try {
    output(command, true, await pollChannel({ scope }), [], pretty);
    return 0;
  } catch (error) {
    fail(
      command,
      error?.code || "runtime_error",
      error?.details?.remediation || "tldr; channel bridge failed.",
      withScope(scope, error?.details || {}),
      pretty,
    );
    return Number(error?.exitCode || 1);
  }
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
})();
if (isMain) process.exitCode = await runPrivateRunner();

export const _internals = Object.freeze({ CHANNEL_POLL_VERB });
