export function createTightbeamWelcomeDispatcher({
  registerEmailChannel,
  readIdentity,
  execute,
  commandFailure,
  unavailable,
  authority,
  principalRef,
  endpointSession,
}) {
  return async function dispatchWelcome({ body, idempotencyKey }) {
    if (typeof body !== "string" || typeof idempotencyKey !== "string") {
      return Object.freeze({ ok: false, error: { code: "welcome_invalid" } });
    }
    const registered = await registerEmailChannel({
      selector: "email",
      label: "Email",
      capabilities: ["send", "reply"],
    });
    if (registered.ok !== true) return registered;
    const identity = await readIdentity();
    if (!identity) return unavailable();
    const owner = await execute({
      admin: false,
      credentials: identity,
      args: [
        "principal",
        "register",
        "--authority",
        authority,
        "--external-ref",
        principalRef,
        "--display-name",
        "Owner",
      ],
    });
    const endpoint = await execute({
      admin: false,
      credentials: identity,
      args: [
        "endpoint",
        "register",
        "--authority",
        authority,
        "--principal",
        owner.result?.principal_id,
        "--runtime",
        "reference",
        "--session",
        endpointSession,
        "--reference",
        authority,
      ],
    });
    const routes = await execute({
      admin: false,
      credentials: identity,
      args: ["channel", "route", "list"],
    });
    const route = routes?.result?.routes?.find(
      (candidate) => candidate?.selector === "email",
    );
    if (
      commandFailure(owner) ||
      commandFailure(endpoint) ||
      commandFailure(routes) ||
      typeof endpoint.result?.process_generation !== "number" ||
      !route
    ) {
      return unavailable();
    }
    const welcome = await execute({
      admin: false,
      credentials: identity,
      args: [
        "principal",
        "register",
        "--authority",
        authority,
        "--external-ref",
        "tldr-welcome",
        "--display-name",
        "tldr;",
      ],
    });
    if (
      commandFailure(welcome) ||
      typeof welcome.result?.principal_id !== "string"
    ) {
      return unavailable();
    }
    const conversation = await execute({
      admin: false,
      credentials: identity,
      args: [
        "conversation",
        "create",
        "--participants",
        `${owner.result.principal_id},${welcome.result.principal_id}`,
      ],
    });
    if (
      commandFailure(conversation) ||
      typeof conversation.result?.conversation_id !== "string"
    ) {
      return unavailable();
    }
    const committed = await execute({
      admin: false,
      credentials: identity,
      args: [
        "message",
        "commit",
        "--conversation",
        conversation.result.conversation_id,
        "--from",
        owner.result.principal_id,
        "--body",
        body,
        "--key",
        idempotencyKey,
        "--origin-channel-route",
        route.route_id,
        "--channel-selector",
        "email",
        "--effect",
        "none",
        "--sender-endpoint",
        endpoint.result.endpoint_id,
        "--process-generation",
        String(endpoint.result.process_generation),
      ],
    });
    return commandFailure(committed)
      ? Object.freeze({ ok: false, error: { code: "welcome_publish_failed" } })
      : Object.freeze({ ok: true, data: committed.result });
  };
}
