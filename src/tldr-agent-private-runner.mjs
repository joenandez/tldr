#!/usr/bin/env node

// This private scheduler is not a messaging CLI. It only bridges the verified
// AgentMail surface to the registered Tightbeam email route.
import "./lib/node_sqlite_warning.mjs";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fail, output, parseArgs } from "./lib/json_io.mjs";
import { resolveDaemonCommandScope } from "./lib/tldr_agent_daemon_scope.mjs";
import { tldrAgentPhaseTimeout } from "./lib/tldr_agent_daemon_phase_timeouts.mjs";

const CHANNEL_POLL_VERB = "__tldr-agent-channel-poll";

// A single poison delivery must never occupy the whole tick: drain every
// claimable delivery (bounded) instead of stopping after the first one.
export const MAX_OUTBOUND_DELIVERIES_PER_POLL = 10;

// With the inbound result, the failed tick keeps both sides' counts and causes
// (the same { inbound, outbound } details an inbound failure reports).
export function reportOutboundFailure(outbound, inbound = undefined) {
  if (outbound?.ok !== false || outbound.code === "claim_unavailable") return;
  throw Object.assign(new Error("Tightbeam email delivery failed"), {
    code: outbound.error || outbound.code || "email_delivery_failed",
    details: inbound === undefined ? outbound : { inbound, outbound },
  });
}

// Item 41: the daemon kills the poll child at its phase timeout, counted from
// the spawn. The inbox poll gets that deadline so its one list retry never
// pushes the tick past it. Outside the daemon no such timeout applies.
export function pollTickDeadlineMs({
  env = process.env,
  startedAtMs = performance.timeOrigin,
} = {}) {
  if (env.HELM_DAEMON !== "1") return null;
  return (
    startedAtMs +
    tldrAgentPhaseTimeout("inbox_poll", {
      phaseTimeoutMs: env.HELM_DAEMON_PHASE_TIMEOUT_MS,
    })
  );
}

function outboundErrorCode(rawCode) {
  return rawCode === "invalid_claimed_delivery"
    ? "tightbeam_invalid_claimed_delivery"
    : "tightbeam_delivery_failed";
}

async function drainOutboundDeliveries({ adapter, onReplyBindingRecorded }) {
  const counts = { attempted: 0, delivered: 0, failed: 0 };
  let lastFailure = null;
  let thrown = null;
  for (
    let attempt = 0;
    attempt < MAX_OUTBOUND_DELIVERIES_PER_POLL;
    attempt += 1
  ) {
    let outcome;
    try {
      // eslint-disable-next-line no-await-in-loop
      outcome = await adapter.deliverOnce({
        afterReplyBindingRecorded: onReplyBindingRecorded,
      });
    } catch (error) {
      thrown = error;
      break;
    }
    if (outcome?.ok !== true && outcome?.code === "claim_unavailable") break;
    counts.attempted += 1;
    if (outcome?.ok === true) counts.delivered += 1;
    else {
      counts.failed += 1;
      lastFailure = outcome;
      // Item 49: a failed claim (not an empty queue) is an outbound failure,
      // and claiming again in the same tick would only repeat it.
      if (outcome?.code === "claim_failed") break;
    }
  }
  return { counts, lastFailure, thrown };
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
  const { assertLifecycleDesiredStateAllowsStart, assertLifecycleHomeSafe } =
    await import("./lib/tldr_agent_lifecycle_store.mjs");
  assertLifecycleDesiredStateAllowsStart();
  assertLifecycleHomeSafe();
}

// One poll child is one tick. Its Tightbeam calls share one payload
// verification (item 38 option E; see tightbeam_verified_runtime.mjs).
export async function loadPollDependencies() {
  const [email, channel, adapter, verified] = await Promise.all([
    import("./lib/transports/email.mjs"),
    import("./lib/tightbeam_channel.mjs"),
    import("./lib/tightbeam_email_adapter.mjs"),
    import("./lib/tightbeam_verified_runtime.mjs"),
  ]);
  return {
    channel: channel.createTightbeamChannel({
      run: verified.createTickVerifiedTightbeamRun(),
    }),
    createAdapter: adapter.createTightbeamEmailAdapter,
    pollInbox: email.pollInbox,
    send: email.emailTransport.send,
  };
}

export async function pollChannel({
  scope,
  dependencies = null,
  deadlineMs = pollTickDeadlineMs(),
}) {
  await (
    dependencies?.assertPrivateRuntimeEnabled || assertPrivateRuntimeEnabled
  )();
  const loaded = dependencies ? dependencies : await loadPollDependencies();
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
  let replyBindingDigest = null;
  const adapter = loaded.createAdapter({ channel, send: loaded.send });
  // Outbound draining is caught in full: a claim that cannot be sent must
  // never stop the inbound poll from running on this tick.
  const { counts, lastFailure, thrown } = await drainOutboundDeliveries({
    adapter,
    onReplyBindingRecorded: ({ claim }) => {
      // The poll receipt proves that a delivery claim produced an opaque
      // binding without exporting the bearer token outside the adapter.
      replyBindingDigest = createHash("sha256")
        .update(claim.reply_binding)
        .digest("hex");
    },
  });
  const inbound = await loaded.pollInbox({
    scope,
    dispatch: true,
    deadlineMs,
    tightbeamInbound: {
      findThreadBinding: channel.findThreadBinding,
      publishInboundEmail: channel.publishInboundEmail,
    },
  });
  const outbound = thrown
    ? {
        ok: false,
        error: outboundErrorCode(thrown.code),
        ...counts,
      }
    : lastFailure
      ? {
          ok: false,
          error: outboundErrorCode(lastFailure.error),
          delivery_id: lastFailure.delivery_id,
          ...(lastFailure.code === "claim_failed"
            ? {
                cause: "claim_failed",
                tightbeam_code: lastFailure.tightbeam_code ?? null,
              }
            : {}),
          ...counts,
        }
      : { ok: true, ...counts };
  reportOutboundFailure(outbound, inbound);
  if (!inbound?.ok) {
    throw Object.assign(
      new Error(
        inbound?.hint || outbound?.error || "Tightbeam email channel failed",
      ),
      {
        code: inbound?.error || outbound?.error || "inbound_poll_failed",
        details: { inbound, outbound },
      },
    );
  }
  return withScope(scope, {
    inbound,
    outbound: {
      ...outbound,
      ...(replyBindingDigest
        ? { reply_binding_digest: `sha256:${replyBindingDigest}` }
        : {}),
    },
  });
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
