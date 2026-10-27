// One capability projection for messaging, tasks, and email, shared by the
// installed and cold status paths. It is pure and emits only the constants
// below, so no input string (owner address, key, route id, component name)
// can reach user-facing output. Each capability is derived from its own
// evidence only: an email fault never demotes messaging or tasks, and welcome
// delivery never demotes a verified active route.

const READY = Object.freeze({
  state: "ready",
  next_action: null,
  remediation: null,
});

const CORE_REPAIR = Object.freeze({
  messaging: Object.freeze({
    state: "needs_attention",
    next_action: "repair-messaging",
    remediation: "tldr-agents messaging bootstrap",
  }),
  tasks: Object.freeze({
    state: "needs_attention",
    next_action: "repair-tasks",
    remediation: "tldr-agents tasks up",
  }),
});

const EMAIL = Object.freeze({
  not_connected: Object.freeze({
    next_action: "connect-email",
    remediation: "tldr-agents setup --json",
  }),
  pending: Object.freeze({
    next_action: "continue-email-setup",
    remediation: "tldr-agents setup --json",
  }),
  connected: Object.freeze({ next_action: null, remediation: null }),
  needs_attention: Object.freeze({
    next_action: "repair-email",
    remediation: "tldr-agents repair --json",
  }),
});

// Slack state is read offline from the credential file and the last observed
// Slack health; the live check is `tldr-agents status --channel slack`.
const SLACK = Object.freeze({
  not_connected: Object.freeze({
    next_action: "connect-slack",
    remediation: "tldr-agents setup --channel slack",
  }),
  connected: Object.freeze({ next_action: null, remediation: null }),
  needs_attention: Object.freeze({
    next_action: "repair-slack",
    remediation: "tldr-agents repair --channel slack",
  }),
});

// The app's disconnect retired the route but the credential is still there:
// only the app's Retry finishes it; repair would reassert the route.
const EMAIL_DISCONNECT_UNFINISHED = Object.freeze({
  next_action: "finish-email-disconnect",
  remediation: "tldr-agents configure --json",
});

const WELCOME_DELIVERY = Object.freeze({
  accepted: "accepted",
  failed: "failed",
  ambiguous: "ambiguous",
});

const PENDING_NATIVE = new Set([
  "pending_verification",
  "confirmation-required",
]);
const OWNER_VERIFIED = new Set(["connected", "needs_attention"]);
// Broker policy is unconfigured but a disconnect left protected email files.
const DISCONNECT_INCOMPLETE = "disconnect_incomplete";

function coreCapability(name, health) {
  return health?.ok === true ? READY : CORE_REPAIR[name];
}

function hasActiveEmailRoute(emailRoutes) {
  return (
    emailRoutes?.ok === true &&
    Array.isArray(emailRoutes.routes) &&
    emailRoutes.routes.some(
      (route) => route?.selector === "email" && route.available === true,
    )
  );
}

function emailState({
  nativeStatus,
  appInstalled,
  emailRoutes,
  emailDisconnectPending,
}) {
  if (nativeStatus === "unconfigured") return "not_connected";
  if (nativeStatus === "unavailable" && appInstalled !== true) {
    return "not_connected";
  }
  if (PENDING_NATIVE.has(nativeStatus)) return "pending";
  if (nativeStatus !== "ready" || emailDisconnectPending) {
    return "needs_attention";
  }
  return hasActiveEmailRoute(emailRoutes) ? "connected" : "needs_attention";
}

export function projectCapabilities({
  messaging,
  tasks,
  nativeStatus,
  appInstalled,
  emailRoutes,
  welcome,
  emailDisconnectPending = false,
  slack = "not_connected",
} = {}) {
  const state = emailState({
    nativeStatus,
    appInstalled,
    emailRoutes,
    emailDisconnectPending,
  });
  const action =
    nativeStatus === DISCONNECT_INCOMPLETE ||
    (emailDisconnectPending && nativeStatus === "ready")
      ? EMAIL_DISCONNECT_UNFINISHED
      : EMAIL[state];
  // Welcome evidence is only meaningful once an owner was verified; before
  // that a session-less reader reports "failed", which would be a false claim.
  const welcomeDelivery = OWNER_VERIFIED.has(state)
    ? (WELCOME_DELIVERY[welcome] ?? "not_sent")
    : "not_sent";
  return Object.freeze({
    messaging: coreCapability("messaging", messaging),
    slack: Object.freeze({ state: slack, ...SLACK[slack] }),
    tasks: coreCapability("tasks", tasks),
    email: Object.freeze({
      state,
      ...action,
      welcome_delivery: welcomeDelivery,
    }),
  });
}
