const COMPONENTS = Object.freeze([
  "plugin",
  "runtime",
  "hooks",
  "service",
  "aegis",
  "outbound",
]);

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

function nativeProjection(status) {
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
    return success("unavailable", ["aegis"], "repair", "Repair tldr;");
  }
  if (status !== "ready") {
    return success("repair-required", ["aegis"], "repair", "Repair tldr;");
  }
  return null;
}

export function createStarportOrchestrator({
  inspectComponents,
  native,
  onboarding,
  source,
} = {}) {
  if (
    typeof inspectComponents !== "function" ||
    typeof native?.status !== "function" ||
    typeof onboarding?.status !== "function"
  ) {
    throw new TypeError("Starport orchestrator dependencies are incomplete");
  }

  async function status() {
    const inspected = await inspectComponents();
    const nativeResult = await native.status();
    const projectedNative = nativeProjection(nativeResult?.data?.status);
    if (projectedNative) return projectedNative;

    const unhealthy = COMPONENTS.filter((name) => inspected?.[name] !== true);
    if (unhealthy.length > 0) {
      return success("repair-required", unhealthy, "repair", "Repair tldr;");
    }

    const welcome = await onboarding.status();
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
    return success(
      "ready-unverified",
      COMPONENTS,
      "send-welcome-email",
      "Send my tldr; welcome email",
    );
  }

  async function setup() {
    const before = await status();
    if (before.data.state === "onboarding-verified") {
      const configured = await native.configure?.();
      if (configured?.ok === false) return configured;
      return status();
    }
    if (
      before.data.state === "ready-unverified" ||
      before.data.state === "onboarding-reconciling"
    ) {
      await onboarding.send?.();
      return status();
    }
    await source?.install?.();
    await native.setup?.();
    const after = await status();
    if (after.data.state === "ready-unverified") {
      await onboarding.send?.();
      return status();
    }
    return after;
  }

  return Object.freeze({
    setup,
    status,
    async configure() {
      const configured = await native.configure?.();
      if (configured?.ok === false) return configured;
      return status();
    },
    async repair() {
      await source?.install?.();
      await native.repair?.();
      return status();
    },
    async uninstall() {
      const result = await native.uninstall?.();
      if (result?.ok === false || result?.data?.status !== "uninstalled") {
        return success(
          "uninstall-incomplete",
          ["aegis", "service", "runtime"],
          "retry-uninstall",
          "Uninstall tldr;",
        );
      }
      try {
        await source?.uninstall?.();
      } catch {
        return success(
          "uninstall-incomplete",
          ["hooks", "service", "runtime"],
          "retry-uninstall",
          "Uninstall tldr;",
        );
      }
      return success(
        "uninstalled",
        [],
        "remove-plugin",
        "claude plugin uninstall tldr@codename",
      );
    },
  });
}

export const _internals = Object.freeze({ COMPONENTS });
