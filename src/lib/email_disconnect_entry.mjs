// The signed app's Disconnect Email data path (plan Technical Approach 5):
// read the disconnect impact, then retire the tldr email route only when no
// delivery is pending or claimed. The app runs these through the installed
// runtime (`<home>/install/runtime/bin/node <home>/install/tldr-agent/src/
// starport.mjs <operation>`), removes the credential through the broker
// afterwards, and passes no credential, code, or owner address in.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { createEmailDisconnectMarker } from "./email_disconnect_marker.mjs";
import { createEmailIntentDraftStore } from "./email_intent_drafts.mjs";
import { tldrAgentHomeFor } from "./store.mjs";
import { createTightbeamChannel } from "./tightbeam_channel.mjs";
import { installedTightbeamInvocation } from "./tightbeam_channel_runtime.mjs";

const IMPACT = "email-disconnect-impact";
const RETIRE = "email-disconnect-retire";
export const EMAIL_DISCONNECT_OPERATIONS = new Set([IMPACT, RETIRE]);

function logEvent(level, event, fields) {
  try {
    process.stderr.write(
      `${JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })}\n`,
    );
  } catch {
    // Logging never changes a disconnect outcome.
  }
}

const success = (data) => Object.freeze({ ok: true, data, error: null });

function failure(code, message, { retryable, data = null }) {
  return Object.freeze({
    ok: false,
    data,
    error: Object.freeze({ code, message, retryable }),
  });
}

export function createEmailDisconnectEntry({
  tightbeam,
  drafts,
  marker,
  log = logEvent,
}) {
  async function impact() {
    const deliveries = await tightbeam.emailRouteImpact();
    if (!deliveries.ok) {
      log("warn", "email_disconnect.impact", {
        status: "unavailable",
      });
      return failure(
        "EMAIL_DISCONNECT_IMPACT_UNAVAILABLE",
        "tldr; could not read pending email deliveries.",
        { retryable: true },
      );
    }
    // Helm prompts are opaque and carry no email dependency, so scheduled
    // work is always a review warning and never a count.
    const data = Object.freeze({
      pending_intents: drafts.pendingCount(),
      active_deliveries:
        deliveries.pending_deliveries + deliveries.claimed_deliveries,
      scheduled_work_warning: true,
    });
    log("info", "email_disconnect.impact", { status: "ok", result: data });
    return success(data);
  }

  const retireUnavailable = () =>
    failure(
      "EMAIL_DISCONNECT_RETIRE_UNAVAILABLE",
      "tldr; could not retire the email route.",
      { retryable: true },
    );

  // The marker goes down before the route retires, so no window exists in
  // which the route is retired but repair may still reassert it. A refused
  // first attempt removes it again; a retry keeps the earlier one, whose
  // route already retired. Both run under the route lock, so a registration
  // already underway finishes first and is retired here.
  async function retire() {
    try {
      return await marker.withRouteLock(retireLocked);
    } catch (error) {
      if (error?.code !== "EMAIL_ROUTE_LOCK_BUSY") throw error;
      log("warn", "email_disconnect.retire", { status: "route_lock_busy" });
      return retireUnavailable();
    }
  }

  async function retireLocked() {
    const resuming = marker.isPending();
    try {
      marker.mark();
    } catch (error) {
      log("error", "email_disconnect.retire", {
        status: "marker_unwritable",
        error_code: error?.code ?? null,
        stack: error?.stack ?? null,
      });
      return retireUnavailable();
    }
    const outcome = await tightbeam.retireEmailRoute();
    if (!outcome.ok && !resuming) marker.clear();
    log(outcome.ok ? "info" : "warn", "email_disconnect.retire", {
      status: outcome.ok ? outcome.state : outcome.code,
      resuming,
    });
    if (outcome.ok) return success(Object.freeze({ state: "retired" }));
    if (outcome.code === "route_has_active_deliveries") {
      return failure(
        "EMAIL_ROUTE_HAS_ACTIVE_DELIVERIES",
        "Email deliveries are still pending; the email route stays active.",
        { retryable: true, data: Object.freeze({ state: "blocked" }) },
      );
    }
    return retireUnavailable();
  }

  return Object.freeze({ [IMPACT]: impact, [RETIRE]: retire });
}

function realpathOrNull(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

// Only the installed runtime node running the installed tldr-agent source
// qualifies; a plugin cache or checkout copy of this module does not.
export function runsFromInstalledRuntime({ home, modulePath, execPath }) {
  const install = join(home, "install");
  const sourceRoot = realpathOrNull(join(install, "tldr-agent"));
  const runtimeNode = realpathOrNull(join(install, "runtime", "bin", "node"));
  const module = realpathOrNull(modulePath);
  return (
    sourceRoot !== null &&
    runtimeNode !== null &&
    module?.startsWith(`${sourceRoot}${sep}`) === true &&
    realpathOrNull(execPath) === runtimeNode
  );
}

export async function runEmailDisconnectOperation(
  operation,
  {
    env = process.env,
    userHome = homedir(),
    modulePath = fileURLToPath(import.meta.url),
    execPath = process.execPath,
    createEntry = createEmailDisconnectEntry,
  } = {},
) {
  const home = resolve(tldrAgentHomeFor({ env, userHome }));
  if (!runsFromInstalledRuntime({ home, modulePath, execPath })) {
    logEvent("warn", "email_disconnect.entry_refused", {
      params: { operation },
      status: "unverified_runtime",
    });
    return failure(
      "EMAIL_DISCONNECT_ENTRY_UNVERIFIED",
      "Email disconnect runs only from the installed tldr; runtime.",
      { retryable: false },
    );
  }
  // Tightbeam children resolve their state from the same home.
  env.TLDR_AGENT_HOME = home;
  const entry = createEntry({
    tightbeam: createTightbeamChannel({
      home,
      ...installedTightbeamInvocation({ execPath }),
    }),
    drafts: createEmailIntentDraftStore({ home }),
    marker: createEmailDisconnectMarker({ home }),
  });
  return entry[operation]();
}
