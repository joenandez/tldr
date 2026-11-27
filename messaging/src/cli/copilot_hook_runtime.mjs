import { realpathSync } from "node:fs";

import { isCopilotPluginHooksPath } from "../runtimes/copilot_contract.mjs";
import { encodeCopilotHookEffect } from "./copilot_hook.mjs";
import { drainBackedOff } from "./drain_backoff.mjs";
import { runDetached } from "./hook_detach.mjs";
import { readUnseenNotices } from "./hook_local_notice.mjs";
import { resolveRuntime } from "./hook_identity.mjs";
import { DETACHED_IDENTITY, detachPromptBusy } from "./prompt_busy.mjs";
import {
  quotedMessagingRecipe,
  unifiedPackageCopilotPluginHooksPath,
} from "./package_context.mjs";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const RUNTIME_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

// The command prefix a Copilot recipe carries: the callback-validated current
// root session and the explicit runtime. The Copilot manifest declares no
// verified session variable, so the recipe states the binding itself. Fails closed
// on anything that is not a UUID and a safe runtime id.
export function copilotRecipePrefix(runtime, sessionId, packageRoot) {
  if (!UUID.test(sessionId) || !RUNTIME_ID.test(runtime)) {
    throw new Error(
      "Copilot recipe binding needs a session UUID and a safe runtime id",
    );
  }
  return `HELM_AGENT_SESSION_ID=${sessionId} TIGHTBEAM_RUNTIME=${runtime} ${quotedMessagingRecipe(packageRoot)}`;
}

// A plugin-registered runtime binds this package's own artifact, so hooks
// from another package root or a missing artifact never reach admission.
export function copilotArtifactBindingError(record, packageRoot) {
  const declared = record.hooksInstall?.settingsPath;
  if (!isCopilotPluginHooksPath(declared)) return null;
  const own = unifiedPackageCopilotPluginHooksPath(packageRoot);
  let reason;
  try {
    if (realpathSync(declared) === realpathSync(own)) return null;
    reason = "names another package";
  } catch (error) {
    reason = `cannot be resolved (${error.code ?? error.message})`;
  }
  return (
    `Copilot runtime ${record.id} is registered for plugin hooks ${declared}, which ${reason}; ` +
    `register this package's ${own} before loading its plugin`
  );
}

// The explicitly bound Copilot record, or null for any other runtime. An
// unregistered binding or an unbound plugin artifact refuses here, before
// any bootstrap, decode, or endpoint admission.
export function boundCopilotRuntime({ explicitRuntime, registry }) {
  if (!explicitRuntime) return null;
  if (registry) resolveRuntime({ explicit: explicitRuntime, registry });
  const record = registry?.get(explicitRuntime);
  if (record?.hooksInstall?.format !== "copilot-json") return null;
  const unbound = copilotArtifactBindingError(record);
  if (unbound) {
    const error = new Error(unbound);
    error.code = "copilot_plugin_unbound";
    throw error;
  }
  return record;
}

export function requiresExplicitCopilotRuntime({
  explicitRuntime,
  credentials,
  payload,
  env,
  registry,
}) {
  let requiresBinding = false;
  if (!explicitRuntime) {
    const credentialRuntime = credentials?.runtime
      ? registry?.get(credentials.runtime)
      : null;
    requiresBinding =
      credentialRuntime?.hooksInstall?.format === "copilot-json";

    if (!requiresBinding && registry?.list) {
      const inferredRuntime = resolveRuntime({ payload, env, registry });
      requiresBinding =
        registry.get(inferredRuntime)?.hooksInstall?.format === "copilot-json";
    }
  }
  return requiresBinding;
}

// The startup context ends with the validated session binding, so commands
// the model starts itself carry it before any message arrives.
function withSessionBinding(result, { runtime, sessionId }, context) {
  const binding = `<tightbeam_session_binding>\nStart every tldr messaging command for this session with: ${copilotRecipePrefix(runtime, sessionId)} <command>\n</tightbeam_session_binding>`;
  return {
    ...result,
    copilotOutput: encodeCopilotHookEffect({
      event: "sessionStart",
      effect: {
        authority: "startup-context",
        content: context ? `${context}\n\n${binding}` : binding,
      },
    }),
  };
}

// Resumed sessions only (placeholder or launch token): today's synchronous handler.
export async function runCopilotSessionStart(client, ctx, handlers) {
  const result = await handlers["session-start"](client, ctx);
  const recovered = result.output?.hookSpecificOutput?.additionalContext;
  if (recovered === undefined) return result;
  return withSessionBinding(
    result,
    { runtime: ctx.identity.runtime, sessionId: ctx.copilotInput.sessionId },
    recovered,
  );
}

/** A direct sessionStart: the cached catalog (or nothing) plus the binding; registration is already detached. */
export const copilotDetachedSessionStart = (started, runtime, sessionId) =>
  withSessionBinding(
    started,
    { runtime, sessionId },
    started.output?.hookSpecificOutput?.additionalContext,
  );

// Busy (prompt only) and the drain run in detached workers; the drain only
// when the daemon wrote something since the last one (or an ACK hint needs reconciling).
function detachDaemonWork(
  verb,
  ctx,
  { stateRoot, runtime, detach, drainNeeded, log },
) {
  const startedAt = Date.now();
  const busy =
    verb === "user-prompt-submit"
      ? detachPromptBusy({
          ctx,
          stateRoot,
          runtime,
          payload: ctx.payload,
          detach,
          log,
        })
      : null;
  // A backed-off drain spawns nothing; the notice was already staged from local files.
  const drain =
    drainNeeded(ctx.paths) && !drainBackedOff(ctx.paths)
      ? runDetached(
          "pre-tool-use",
          {
            session_id: ctx.identity.session_id,
            // The child has no session env and must not capture its own process tree.
            [DETACHED_IDENTITY]: { ...ctx.identity, owner_process: null },
          },
          {
            stateRoot,
            paths: ctx.paths,
            args: ["--runtime", runtime],
            ...detach,
          },
        )
      : null;
  log({
    event: "copilot_callback_detached",
    params: { verb, session_id: ctx.identity.session_id },
    result: { busy: busy?.coalesced ?? null, drain: drain?.coalesced ?? null },
    status: "ok",
    latency_ms: Date.now() - startedAt,
  });
  return busy !== null || drain !== null;
}

function copilotEffect(verb, ctx, rendered) {
  const contribution =
    rendered.output?.hookSpecificOutput?.additionalContext ?? "";
  if (verb === "user-prompt-submit") {
    const original = ctx.copilotInput.originalPrompt;
    const content = `${original}${original.endsWith("\n") ? "\n" : "\n\n"}${contribution}`;
    return {
      ...rendered,
      // An empty object keeps an earlier plugin's modifiedPrompt; the original would replace it.
      copilotOutput: contribution
        ? encodeCopilotHookEffect({
            event: "userPromptSubmitted",
            effect: { authority: "user-prompt", content },
          })
        : {},
    };
  }
  return contribution
    ? {
        ...rendered,
        copilotOutput: encodeCopilotHookEffect({
          event: "postToolUse",
          effect: { authority: "tool-result", content: contribution },
        }),
      }
    : rendered;
}

// hnbc 1.12: an unseen owner-matching notice is staged here, from the local
// notice file (zero IPC), so the render below shows it in this same callback.
// The watermark is consumed once the notice is durably staged; the shown
// ledger is written by the render's output commit, so no path repeats it.
function stageUnseenNotices(ctx, { stage, log }) {
  const read = readUnseenNotices(ctx.paths, {
    sessionId: ctx.identity.session_id,
    appId: stage.appId,
    endpoint: stage.readCache(ctx.paths),
    subagent: Boolean(ctx.payload?.agent_id),
    log,
  });
  try {
    for (const notice of read.notices) {
      // Copilot is never shown a body (and never marks one read): its notices stay bodyless.
      const entry = stage.stagedNotificationEntry(notice.attempt, notice);
      delete entry.body;
      stage.appendStagedEntry(ctx.paths, entry);
    }
    const { consumed } = read.commit({ shown: [], complete: true });
    log({
      event: "copilot_local_notice",
      params: { session_id: ctx.identity.session_id },
      result: {
        staged: read.notices.length,
        deferred: read.deferred,
        left_for_main: read.leftForMain,
        consumed,
      },
      status: "ok",
    });
  } catch (error) {
    // Unstaged notices stay unseen for the detached drain; the render still runs.
    log({
      event: "copilot_local_notice",
      params: { session_id: ctx.identity.session_id },
      status: "error",
      error: error.message,
      stack: error.stack,
    });
  } finally {
    read.release();
  }
}

/**
 * userPromptSubmitted / postToolUse, before any daemon connection: show any
 * unseen local notice, hand the daemon work to detached workers, then render
 * only what is staged locally through the unchanged Copilot output path.
 */
export async function runCopilotHook({ verb, ctx, render, handoff }) {
  // Decided before the notice consumes the watermark: the drain still admits the presentation daemon-side (receive replay needs it).
  const drainWanted = handoff.drainNeeded(ctx.paths);
  // An unchanged watermark means nothing to stage: skip the tail and ledger reads (mirrors the shell cmp gate).
  if (drainWanted) stageUnseenNotices(ctx, handoff);
  const detached = detachDaemonWork(verb, ctx, {
    ...handoff,
    drainNeeded: () => drainWanted,
  });
  ctx.recipePrefix = copilotRecipePrefix(
    ctx.identity.runtime,
    ctx.copilotInput.sessionId,
  );
  const rendered = await render(ctx);
  return {
    ...copilotEffect(verb, ctx, rendered),
    ...(detached ? { detached } : {}),
  };
}
