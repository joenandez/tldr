#!/usr/bin/env node

// Bounded daemon child entrypoint for the tldr; product's poll and inbound-dispatch
// phases. Exact session resume is owned directly by resume_session.mjs.

// Must stay first: installs the node:sqlite ExperimentalWarning filter before
// any module that imports node:sqlite is evaluated.
import "./lib/node_sqlite_warning.mjs";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, output, fail } from "./lib/json_io.mjs";
import { resolveDaemonCommandScope } from "./lib/tldr_agent_daemon_scope.mjs";

const PRIVATE_INBOX_POLL_VERB = "__tldr-agent-inbox-poll";
const PRIVATE_INBOX_DISPATCH_VERB = "__tldr-agent-inbox-dispatch";
const PRIVATE_REPLY_OBLIGATIONS_VERB = "__tldr-agent-reply-obligations";

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

async function pollOwnerInbox({ flags, scope }) {
  await assertPrivateRuntimeEnabled();
  const email = await import("./lib/transports/email.mjs");
  const dispatchCaptured = flags["dispatch-captured"]
    ? async ({ scope: routedScope }) => {
        const dispatcher = await import("./lib/comms_dispatcher.mjs");
        return dispatcher.tickDispatcher({ scope: routedScope || scope });
      }
    : null;
  const result = await email.pollInbox({
    scope,
    dispatch: !flags["no-dispatch"],
    dispatchCaptured,
  });
  if (!result?.ok) {
    throw Object.assign(new Error(result?.hint || "owner inbox poll failed"), {
      code: result?.error || "inbox_poll_failed",
      details: result || {},
    });
  }
  return withScope(scope, result);
}

async function dispatchOwnerInbox({ scope }) {
  await assertPrivateRuntimeEnabled();
  const dispatcher = await import("./lib/comms_dispatcher.mjs");
  const result = await dispatcher.tickDispatcher({ scope });
  if (!result?.ok) {
    throw Object.assign(new Error(result?.error || "inbox dispatch failed"), {
      code: "inbox_dispatch_failed",
      details: result || {},
    });
  }
  return withScope(scope, {
    results: [{ ...result, cwd: scope.cwd, scope_id: scope.scope_id }],
  });
}

async function processReplyObligations({ scope }) {
  await assertPrivateRuntimeEnabled();
  const { tickReplyObligations } = await import(
    "./lib/reply_obligation_sla.mjs"
  );
  const result = await tickReplyObligations({ scope });
  return withScope(scope, {
    processed: result?.processed ?? 0,
    satisfied: result?.satisfied ?? 0,
    late_satisfied: result?.late_satisfied ?? 0,
    alive_owner_overdue: result?.alive_owner_overdue ?? 0,
    dead_owner_resumes_started: result?.dead_owner_resumes_started ?? 0,
    resume_failed_no_reply: result?.resume_failed_no_reply ?? 0,
    ack_soft_missed: result?.ack_soft_missed ?? 0,
    ack_hard_missed_alive_owner: result?.ack_hard_missed_alive_owner ?? 0,
    ack_hard_missed_alive_unknown_owner:
      result?.ack_hard_missed_alive_unknown_owner ?? 0,
    resume_failed_no_ack: result?.resume_failed_no_ack ?? 0,
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
  try {
    let data = null;
    if (command === PRIVATE_INBOX_POLL_VERB) {
      data = await pollOwnerInbox({ flags, scope });
    } else if (command === PRIVATE_INBOX_DISPATCH_VERB) {
      data = await dispatchOwnerInbox({ scope });
    } else if (command === PRIVATE_REPLY_OBLIGATIONS_VERB) {
      data = await processReplyObligations({ scope });
    }
    if (!data) {
      fail(
        "private",
        "command_removed",
        "This command is not part of tldr;.",
        withScope(scope),
        pretty,
      );
      return 2;
    }
    output(command, true, data, [], pretty);
    return 0;
  } catch (error) {
    fail(
      command || "private",
      error?.code || "runtime_error",
      "tldr; private continuity failed.",
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
