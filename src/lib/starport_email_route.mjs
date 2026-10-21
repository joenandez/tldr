// Setup and repair activate the tldr email route here. Their observation of a
// verified owner may predate an app disconnect, so when the disconnect marker
// is wired in, registration runs under the route lock the retire entry also
// takes, and the marker and broker are read again right before registering:
// a registration either finishes before retirement starts (and is retired) or
// is withheld.
export const EMAIL_ROUTE = Object.freeze({
  selector: "email",
  label: "Email",
  capabilities: Object.freeze(["send", "reply"]),
});

const OWNER_VERIFIED = "ready";

export function createEmailRouteActivator({
  tightbeam,
  native,
  emailDisconnect,
  log,
}) {
  const register = () => tightbeam.registerEmailChannel(EMAIL_ROUTE);

  // null means withhold.
  function registerUnlessDisconnecting() {
    if (typeof emailDisconnect?.withRouteLock !== "function") return register();
    return emailDisconnect.withRouteLock(async () => {
      if (emailDisconnect.isPending()) return null;
      const current = await native.status();
      return current?.data?.status === OWNER_VERIFIED ? register() : null;
    });
  }

  // Idempotent: Tightbeam replays the same route for a repeated register.
  return async function activateEmailRoute(operation) {
    if (typeof tightbeam?.registerEmailChannel !== "function") {
      return { registered: false, failure: null };
    }
    const result = await registerUnlessDisconnecting();
    if (result === null) {
      log("info", "starport_email_route_withheld", {
        operation,
        reason: "disconnect_raced",
      });
      return { registered: false, failure: null, withheld: true };
    }
    if (result?.ok === false) {
      log("warn", "starport_email_route_failed", {
        operation,
        error_code: result.error?.code ?? null,
      });
      return { registered: false, failure: result };
    }
    log("info", "starport_email_route_active", {
      operation,
      idempotent_replay: result?.data?.idempotent_replay === true,
    });
    return { registered: true, failure: null };
  };
}
