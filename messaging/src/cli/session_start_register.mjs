// The detached SessionStart pass (hnbc 1.4): everything a direct session used
// to do against the daemon in the foreground. Collaborators are injected by
// hook_commands.mjs, which owns registerSession and the client.
import { DEFAULT_AUTHORITY_NAME } from "./bootstrap.mjs";
import { runDetached } from "./hook_detach.mjs";
import { launchPaths } from "./takeover_launch.mjs";
import { promptBusyNeeded } from "./prompt_busy.mjs";
import { sessionPaths } from "../protocol/session_paths.mjs";
import {
  bootstrapStamp,
  renderCachedCatalog,
  renderOutboundChannelCatalog,
  readBootstrapStamp,
  writeBootstrapStamp,
  writeCatalogCache,
} from "./session_start_cache.mjs";
import { markMessagingUsed } from "../protocol/session_paths.mjs";

/** Marks the payload runDetached carries, so the worker never mistakes a raw hook payload for it. */
export const DETACHED_SESSION_START = "detached_session_start";

// shortcut: the register response carries no armed/held-work fields, so a busy
// endpoint or pending recovery stands in for them; upgrade when the daemon reports them.
export const registrationHoldsWork = (endpoint) =>
  endpoint.armed === true ||
  endpoint.holding_work === true ||
  endpoint.state === "busy" ||
  typeof endpoint.recovery_resume_request_id === "string";

/**
 * credentials+stamp check -> bootstrap only when missing/changed (else
 * ensureDaemon) -> register the foreground-captured owner -> refresh the raw
 * catalog cache -> stamp, only after all of that succeeded.
 */
export async function runSessionStartRegistration({
  job,
  stateRoot,
  socketPath,
  runtimeNames,
  wakeRuntimeIds,
  version,
  paths,
  deps,
  log,
}) {
  const startedAt = Date.now();
  const stampFor = (credentials) =>
    bootstrapStamp({
      version,
      runtimeNames,
      wakeRuntimeIds,
      authorityName: credentials?.authority_name ?? DEFAULT_AUTHORITY_NAME,
    });
  let credentials = deps.readCredentials(stateRoot);
  const stampHit =
    deps.hasUsableCredentials(stateRoot) &&
    readBootstrapStamp(stateRoot) === stampFor(credentials);
  log({
    event: "session_start_register_begin",
    params: {
      session_id: job.identity.session_id,
      path: stampHit ? "stamp_hit" : "bootstrap",
    },
  });
  try {
    if (stampHit) await deps.ensureDaemon(stateRoot, socketPath);
    else {
      await deps.bootstrap({
        stateRoot,
        socketPath,
        runtimeTypes: runtimeNames,
        wakeRuntimeTypes: wakeRuntimeIds,
      });
      credentials = deps.readCredentials(stateRoot);
    }
    const identity = {
      ...job.identity,
      authority_name: credentials.authority_name,
    };
    const client = await deps.openClient(stateRoot, {
      appId: credentials.app_id,
      appSecret: credentials.app_secret,
    });
    let endpoint;
    let deferredBusy = false;
    // The prompt record is per launch (ac-os0zc): this launch's deferred prompt, never another's.
    const ctx = {
      paths: launchPaths(paths, identity.launch_token),
      identity,
      app_id: credentials.app_id,
    };
    try {
      endpoint = await deps.register(client, ctx);
      const catalog = await client.request("channel.route.list", {
        available_only: true,
        required_capability: "send",
      });
      writeCatalogCache(stateRoot, catalog.routes);
      // A prompt that arrived before any credentials existed left its busy mark to this pass (hook_commands.mjs).
      deferredBusy = promptBusyNeeded(ctx.paths);
      if (deferredBusy) await deps.markBusy(client, ctx);
    } finally {
      await client.close();
    }
    if (registrationHoldsWork(endpoint))
      markMessagingUsed(paths, { logger: log });
    if (!stampHit) writeBootstrapStamp(stateRoot, stampFor(credentials));
    log({
      event: "session_start_register",
      params: { session_id: identity.session_id },
      result: {
        endpoint_id: endpoint.endpoint_id,
        state: endpoint.state,
        marked: registrationHoldsWork(endpoint),
        deferred_busy: deferredBusy,
      },
      status: "ok",
      latency_ms: Date.now() - startedAt,
    });
    return { registered: true, endpoint };
  } catch (error) {
    log({
      event: "session_start_register",
      params: { session_id: job.identity.session_id },
      result: { error: error.code || error.message, stack: error.stack },
      status: "error",
      latency_ms: Date.now() - startedAt,
    });
    throw error;
  }
}

/** Foreground half of a direct SessionStart: no bootstrap, no connection, nothing waits on the daemon. */
export function detachSessionStartRegistration(
  {
    stateRoot,
    flags,
    env,
    credentials,
    sessionId,
    runtime,
    payload,
    detach,
    copilotRecord = null,
  },
  { resolveIdentity, captureOwnerProcess, log },
) {
  const startedAt = Date.now();
  const paths = sessionPaths(stateRoot, sessionId);
  // The authority is unknown before the first bootstrap; the worker replaces it from the credentials.
  const identity = resolveIdentity({
    payload,
    env,
    flags,
    sessionId,
    runtime,
    verb: "session-start",
    copilotRecord,
    credentials: {
      ...credentials,
      authority_name: credentials?.authority_name ?? DEFAULT_AUTHORITY_NAME,
    },
  });
  // The runtime process is the hook's parent only here; the child's parent is the seam.
  identity.owner_process = captureOwnerProcess({
    runtime,
    copilot: identity.copilot_hook_bound,
    sessionId,
    cwd: identity.cwd,
    log: (fields) => log({ ...fields, session_id: sessionId }),
  });
  const handoff = runDetached(
    "session-start",
    { [DETACHED_SESSION_START]: true, payload, identity },
    { stateRoot, paths, args: ["--runtime", runtime], ...detach },
  );
  // No cache yet (first session on this state root): the same block, empty, until the worker writes one.
  const catalog =
    renderCachedCatalog(stateRoot, identity.academy_agent_name) ||
    renderOutboundChannelCatalog([]);
  log({
    event: "session_start_detached",
    params: { session_id: sessionId, runtime },
    result: { coalesced: handoff.coalesced, catalog_bytes: catalog.length },
    status: "ok",
    latency_ms: Date.now() - startedAt,
  });
  return {
    ...handoff,
    output: {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: catalog,
      },
    },
  };
}
