import { realpathSync } from "node:fs";

import { isCopilotPluginHooksPath } from "../runtimes/copilot_contract.mjs";
import { encodeCopilotHookEffect } from "./copilot_hook.mjs";
import { resolveRuntime } from "./hook_identity.mjs";
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
async function runCopilotSessionStart(client, ctx, handlers) {
  const result = await handlers["session-start"](client, ctx);
  const recovered = result.output?.hookSpecificOutput?.additionalContext;
  if (recovered === undefined) return result;
  const prefix = copilotRecipePrefix(
    ctx.identity.runtime,
    ctx.copilotInput.sessionId,
  );
  const content = `${recovered}\n\n<tightbeam_session_binding>\nStart every tldr messaging command for this session with: ${prefix} <command>\n</tightbeam_session_binding>`;
  return {
    ...result,
    copilotOutput: encodeCopilotHookEffect({
      event: "sessionStart",
      effect: { authority: "startup-context", content },
    }),
  };
}

export async function runCopilotHook({ client, verb, ctx, handlers, render }) {
  if (verb === "session-start")
    return runCopilotSessionStart(client, ctx, handlers);

  if (verb === "user-prompt-submit") await handlers[verb](client, ctx);
  await handlers["pre-tool-use"](client, ctx);
  ctx.recipePrefix = copilotRecipePrefix(
    ctx.identity.runtime,
    ctx.copilotInput.sessionId,
  );
  const rendered = await render(ctx);
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
