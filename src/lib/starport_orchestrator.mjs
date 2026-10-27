import {
  EMAIL_ROUTE,
  createEmailRouteActivator,
} from "./starport_email_route.mjs";
import { uninstallStarport } from "./starport_native_lifecycle.mjs";
import { readSlackCapabilityState } from "./tldr_capability_readers.mjs";
import { projectCapabilities } from "./tldr_capabilities.mjs";

const COMPONENTS = Object.freeze([
  "plugin",
  "runtime",
  "service",
  "aegis",
  "outbound",
]);

const OWNER_VERIFIED = "ready";
// The broker's cleanup-complete signal: credential removal has not finished.
const DISCONNECT_INCOMPLETE = "disconnect_incomplete";
// Native stages the signed app can resume without reinstalling itself.
const OWNER_STAGES = new Set([
  OWNER_VERIFIED,
  "unconfigured",
  "pending_verification",
  "confirmation-required",
]);
const WELCOME_SETTLED = new Set([
  "onboarding-verified",
  "onboarding-reconciling",
  "welcome-delivery-failed",
]);
const CORE_CAPABILITIES = Object.freeze(["messaging", "tasks"]);

function success(state, components, nextAction, remediation = null) {
  return Object.freeze({
    ok: true,
    data: Object.freeze({
      state,
      components: Object.freeze([...components]),
      next_action: nextAction,
      remediation,
    }),
    error: null,
  });
}

function missingOnlyOptionalEmailApp(inspected) {
  return (
    inspected?.aegis === false &&
    inspected?.plugin === true &&
    inspected?.runtime === true
  );
}

function nativeProjection(status, inspected) {
  if (status === "pending_verification" || status === "confirmation-required") {
    return success(
      "confirmation-required",
      ["aegis"],
      "confirm-owner-email",
      "Continue setting up tldr;",
    );
  }
  if (status === "unconfigured") {
    return success(
      "secure-setup-required",
      ["aegis"],
      "complete-secure-setup",
      "Continue setting up tldr;",
    );
  }
  if (status === "incompatible") {
    return success("repair-required", ["aegis"], "repair", "Repair tldr;");
  }
  if (status === "unavailable") {
    if (missingOnlyOptionalEmailApp(inspected)) {
      return success(
        "setup-required",
        ["aegis"],
        "setup",
        "tldr-agents setup --json",
      );
    }
    return success("unavailable", ["aegis"], "repair", "Repair tldr;");
  }
  if (status !== "ready") {
    return success("repair-required", ["aegis"], "repair", "Repair tldr;");
  }
  return null;
}

// Status is JSON on stdout, so logs go to stderr: lifecycle detail only when
// asked for, reader failures always. Fields are sanitized states and codes.
function logStatusEvent(level, event, fields) {
  if (level === "info" && process.env.TLDR_AGENT_DEBUG_CAPABILITIES !== "1") {
    return;
  }
  try {
    process.stderr.write(
      `${JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })}\n`,
    );
  } catch {
    // Logging never changes a status outcome.
  }
}

function needsSourceInstall({ inspected, nativeStatus }) {
  return (
    !OWNER_STAGES.has(nativeStatus) ||
    COMPONENTS.some((name) => inspected?.[name] !== true)
  );
}

async function observe(capability, reader) {
  if (typeof reader !== "function") return null;
  try {
    return await reader();
  } catch (error) {
    logStatusEvent("warn", "capability_reader_failed", {
      capability,
      error_code: typeof error?.code === "string" ? error.code : null,
      error_name: error?.name ?? null,
    });
    return Object.freeze({ ok: false });
  }
}

export function createStarportOrchestrator({
  inspectComponents,
  native,
  onboarding,
  source,
  tightbeam = null,
  readMessagingHealth = null,
  readTasksHealth = null,
  readEmailRoutes = null,
  emailDisconnect = null,
} = {}) {
  if (
    typeof inspectComponents !== "function" ||
    typeof native?.status !== "function" ||
    typeof onboarding?.status !== "function"
  ) {
    throw new TypeError("Starport orchestrator dependencies are incomplete");
  }

  async function preflightTightbeam() {
    if (typeof tightbeam?.preflight !== "function") return null;
    const result = await tightbeam.preflight();
    return result?.ok === false ? result : null;
  }

  const activateEmailRoute = createEmailRouteActivator({
    tightbeam,
    native,
    emailDisconnect,
    log: logStatusEvent,
  });

  function lifecycleStatus(inspected, nativeStatus, welcome) {
    const projectedNative = nativeProjection(nativeStatus, inspected);
    if (projectedNative) return projectedNative;
    const unhealthy = COMPONENTS.filter((name) => inspected?.[name] !== true);
    if (unhealthy.length > 0) {
      return success("repair-required", unhealthy, "repair", "Repair tldr;");
    }
    if (welcome?.status === "accepted") {
      return success("onboarding-verified", COMPONENTS, "use-tldr-agent");
    }
    if (welcome?.status === "ambiguous") {
      return success(
        "onboarding-reconciling",
        COMPONENTS,
        "check-status",
        "Check tldr;",
      );
    }
    if (
      welcome?.status === "failed" &&
      typeof welcome.remediation === "string" &&
      welcome.remediation.length > 0
    ) {
      return success(
        "welcome-delivery-failed",
        COMPONENTS,
        "start-supported-session",
        welcome.remediation,
      );
    }
    return success(
      "ready-unverified",
      COMPONENTS,
      "send-welcome-email",
      "Send my tldr; welcome email",
    );
  }

  // An app disconnect whose credential removal has not finished. The broker
  // says so itself (`disconnect_incomplete`); once it reads unconfigured the
  // protected files are gone, and only then does the marker go.
  function disconnectUnfinished(nativeStatus) {
    if (nativeStatus === DISCONNECT_INCOMPLETE) return true;
    if (emailDisconnect?.isPending() !== true) return false;
    if (nativeStatus !== "unconfigured") return nativeStatus === OWNER_VERIFIED;
    emailDisconnect.clear();
    logStatusEvent("info", "email_disconnect_marker_cleared", {
      native_status: nativeStatus,
    });
    return false;
  }

  // One observation of the install: the projected status plus the raw native
  // status and component health that setup/repair use to pick their stage.
  async function observeInstall() {
    const startedAt = Date.now();
    logStatusEvent("info", "starport_status_started", {});
    const inspected = await inspectComponents();
    const nativeResult = await native.status();
    const nativeStatus = nativeResult?.data?.status;
    const emailDisconnectPending = disconnectUnfinished(nativeStatus);
    // Readers run together; each is observational and fails closed to its
    // own capability only.
    const [welcome, messaging, tasks, emailRoutes] = await Promise.all([
      onboarding.status(),
      observe("messaging", readMessagingHealth),
      observe("tasks", readTasksHealth),
      nativeStatus === OWNER_VERIFIED
        ? observe("email_routes", readEmailRoutes)
        : Promise.resolve(null),
    ]);
    const lifecycle = emailDisconnectPending
      ? success(
          "email-disconnect-incomplete",
          ["aegis"],
          "finish-email-disconnect",
          "Finish disconnecting email in tldr;",
        )
      : lifecycleStatus(inspected, nativeStatus, welcome);
    const capabilities = projectCapabilities({
      emailDisconnectPending,
      messaging,
      tasks,
      nativeStatus,
      appInstalled: inspected?.aegis === true,
      emailRoutes,
      welcome: welcome?.status,
      slack: readSlackCapabilityState(),
    });
    logStatusEvent("info", "starport_status_result", {
      state: lifecycle.data.state,
      messaging: capabilities.messaging.state,
      tasks: capabilities.tasks.state,
      email: capabilities.email.state,
      welcome_delivery: capabilities.email.welcome_delivery,
      latency_ms: Date.now() - startedAt,
    });
    const result = Object.freeze({
      ...lifecycle,
      data: Object.freeze({ ...lifecycle.data, capabilities }),
    });
    return { result, inspected, nativeStatus, emailDisconnectPending };
  }

  async function status() {
    return (await observeInstall()).result;
  }

  function logStage(operation, stage, observed) {
    logStatusEvent("info", "starport_stage", {
      operation,
      stage,
      native_status: observed.nativeStatus ?? null,
      state: observed.result.data.state,
    });
  }

  // The owner is verified (native safe status `ready`), so the route may be
  // activated. Only then does the source install run when components need it
  // (the daemon claims deliveries on this route) and does setup welcome once.
  async function activateVerifiedOwner(operation, observed, sourceInstalled) {
    if (observed.emailDisconnectPending) {
      logStage(operation, "email_route_withheld_disconnect_pending", observed);
      return observed.result;
    }
    const route = await activateEmailRoute(operation);
    if (route.failure) return route.failure;
    if (route.withheld) return status();
    if (WELCOME_SETTLED.has(observed.result.data.state)) {
      logStage(operation, "verified_route_reasserted", observed);
      return route.registered ? status() : observed.result;
    }
    if (!sourceInstalled && needsSourceInstall(observed)) {
      logStage(operation, "source_install_after_route", observed);
      await source?.install?.();
    }
    const current = await status();
    if (operation !== "setup" || current.data.state !== "ready-unverified") {
      return current;
    }
    logStage(operation, "welcome_send", { ...observed, result: current });
    await onboarding.send?.();
    return status();
  }

  // Resume at the observed native stage: install only what is missing, hand
  // off to the signed app, and activate the route only if the app reports a
  // verified owner afterwards. A closed, canceled, or invalid verification
  // leaves the route unregistered.
  async function resumeOwnerStage(operation, before, handoff) {
    if (before.emailDisconnectPending) {
      logStage(operation, "email_disconnect_unfinished", before);
      return before.result;
    }
    if (before.nativeStatus === OWNER_VERIFIED) {
      return activateVerifiedOwner(operation, before, false);
    }
    const sourceInstalled = needsSourceInstall(before);
    logStage(
      operation,
      sourceInstalled ? "source_install_then_native" : "native_handoff",
      before,
    );
    if (sourceInstalled) await source?.install?.();
    await handoff();
    const after = await observeInstall();
    if (after.nativeStatus !== OWNER_VERIFIED) {
      logStage(operation, "email_route_withheld", after);
      return after.result;
    }
    return activateVerifiedOwner(operation, after, sourceInstalled);
  }

  async function setup() {
    const preflightFailure = await preflightTightbeam();
    if (preflightFailure) return preflightFailure;
    const before = await observeInstall();
    // A runtime swap re-enters setup, and a verified install skips the source
    // install, so settle the swap's replacement evidence first. It is a no-op
    // until the lifecycle store is ready.
    await source?.reconcile?.();
    return resumeOwnerStage("setup", before, () => native.setup?.());
  }

  // Email never connected: repair is core-only and never installs or opens
  // the signed app; each unhealthy capability names its own command.
  function coreOnlyRepair(observed) {
    const { capabilities } = observed.result.data;
    const unhealthy = CORE_CAPABILITIES.filter(
      (name) => capabilities[name].state !== "ready",
    );
    logStatusEvent("info", "starport_stage", {
      operation: "repair",
      stage: "core_only",
      unhealthy,
    });
    if (unhealthy.length === 0) return observed.result;
    const first = capabilities[unhealthy[0]];
    return Object.freeze({
      ok: true,
      data: Object.freeze({
        state: "repair-required",
        components: Object.freeze(unhealthy),
        next_action: first.next_action,
        remediation: first.remediation,
        capabilities,
      }),
      error: null,
    });
  }

  async function repair() {
    const before = await observeInstall();
    if (before.result.data.capabilities.email.state === "not_connected") {
      return coreOnlyRepair(before);
    }
    const preflightFailure = await preflightTightbeam();
    if (preflightFailure) return preflightFailure;
    return resumeOwnerStage("repair", before, () => native.repair?.());
  }

  return Object.freeze({
    setup,
    status,
    async configure() {
      return native.configure();
    },
    repair,
    uninstall: () =>
      uninstallStarport({
        inspectComponents,
        native,
        source,
        result: success,
        log: logStatusEvent,
      }),
  });
}

export const _internals = Object.freeze({ COMPONENTS, EMAIL_ROUTE });
