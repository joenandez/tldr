export function createTightbeamWelcomeIdentityManager({
  readIdentity,
  persistIdentity,
  execute,
  commandFailure,
  unavailable,
  identityInvalid,
  debugIdentity,
  acquireApplicationCredential,
  application,
  authority,
}) {
  return async function ensureWelcomeIdentity() {
    let identity;
    try {
      identity = await readIdentity();
    } catch (error) {
      if (error?.code !== "TLDR_EMAIL_IDENTITY_INVALID") throw error;
      debugIdentity("identity_integrity_failed", { code: error.code });
      return identityInvalid();
    }
    if (!identity) return unavailable();

    if (!identity.welcome) {
      const acquisition = await acquireApplicationCredential(
        application,
        "welcome_sender",
      );
      const created = acquisition.result;
      if (
        commandFailure(created) ||
        typeof created.result?.app_id !== "string" ||
        typeof created.result?.app_secret !== "string"
      ) {
        if (acquisition.reregistered && created?.ok === false) return created;
        return unavailable();
      }
      identity = {
        ...identity,
        welcome: {
          app_id: created.result.app_id,
          app_secret: created.result.app_secret,
        },
      };
      await persistIdentity(identity);
    }

    const grants = await execute({
      admin: true,
      credentials: null,
      args: [
        "app",
        "set-permissions",
        identity.welcome.app_id,
        "--permissions-json",
        JSON.stringify([
          {
            permission: "register_endpoints",
            allowed_authorities: [authority],
          },
          {
            permission: "send_as_principal",
            allowed_authorities: [authority],
          },
        ]),
      ],
    });
    if (commandFailure(grants)) return unavailable();
    debugIdentity("welcome_sender_ready", { application });
    return Object.freeze({ ok: true, identity: identity.welcome });
  };
}

export function createTightbeamWelcomeDispatcher({
  registerEmailChannel,
  ensureWelcomeIdentity,
  readIdentity,
  execute,
  commandFailure,
  unavailable,
  authority,
  principalRef,
  welcomeEndpointSession,
}) {
  return async function dispatchWelcome({
    subject,
    reason,
    body,
    idempotencyKey,
  }) {
    if (
      typeof subject !== "string" ||
      subject.trim().length === 0 ||
      typeof reason !== "string" ||
      reason.trim().length === 0 ||
      typeof body !== "string" ||
      typeof idempotencyKey !== "string"
    ) {
      return Object.freeze({ ok: false, error: { code: "welcome_invalid" } });
    }
    const registered = await registerEmailChannel({
      selector: "email",
      label: "Email",
      capabilities: ["send", "reply"],
    });
    if (registered.ok !== true) return registered;
    const welcomeIdentity = await ensureWelcomeIdentity();
    if (welcomeIdentity.ok !== true) return welcomeIdentity;
    const bridgeIdentity = await readIdentity();
    if (!bridgeIdentity) return unavailable();
    const owner = await execute({
      admin: false,
      credentials: bridgeIdentity,
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
    const routes = await execute({
      admin: false,
      credentials: bridgeIdentity,
      args: ["channel", "route", "list"],
    });
    const route = routes?.result?.routes?.find(
      (candidate) => candidate?.selector === "email",
    );
    if (
      commandFailure(owner) ||
      commandFailure(routes) ||
      typeof owner.result?.principal_id !== "string" ||
      !route
    ) {
      return unavailable();
    }
    const welcome = await execute({
      admin: false,
      credentials: welcomeIdentity.identity,
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
    const endpoint = await execute({
      admin: false,
      credentials: welcomeIdentity.identity,
      args: [
        "endpoint",
        "register",
        "--authority",
        authority,
        "--principal",
        welcome.result.principal_id,
        "--runtime",
        "reference",
        "--session",
        welcomeEndpointSession,
        "--reference",
        authority,
      ],
    });
    if (
      commandFailure(endpoint) ||
      typeof endpoint.result?.endpoint_id !== "string" ||
      !Number.isInteger(endpoint.result?.process_generation)
    ) {
      return unavailable();
    }
    const conversation = await execute({
      admin: false,
      credentials: welcomeIdentity.identity,
      args: [
        "conversation",
        "create",
        "--participants",
        `${owner.result.principal_id},${welcome.result.principal_id}`,
        "--subject",
        subject,
        "--reason",
        reason,
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
      credentials: welcomeIdentity.identity,
      args: [
        "message",
        "commit",
        "--conversation",
        conversation.result.conversation_id,
        "--from",
        welcome.result.principal_id,
        "--body",
        body,
        "--key",
        idempotencyKey,
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
