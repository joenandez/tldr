export const FOLLOWUP_COMMANDS = Object.freeze([
  "followup require",
  "followup complete",
  "followup cancel",
]);

export const FOLLOWUP_COMMAND_SCHEMAS = Object.freeze({
  "followup require": Object.freeze([
    "--registration-key",
    "--thread",
    "--subject",
    "--summary",
    "--json",
    "--help",
    "--help-json",
  ]),
  "followup complete": Object.freeze([
    "--obligation",
    "--outcome",
    "--body",
    "--body-file",
    "--json",
    "--help",
    "--help-json",
  ]),
  "followup cancel": Object.freeze([
    "--obligation",
    "--reason",
    "--revocation-ref",
    "--json",
    "--help",
    "--help-json",
  ]),
});

export const FOLLOWUP_ERROR_CATALOG = Object.freeze({
  FOLLOWUP_REGISTRATION_CONFLICT: [
    "This registration key conflicts with an existing followup.",
    false,
  ],
  FOLLOWUP_NOT_FOUND: ["No matching followup obligation was found.", false],
  FOLLOWUP_NOT_CONFIRMED: [
    "The followup confirmation has not been accepted.",
    true,
  ],
  FOLLOWUP_TERMINAL_CONFLICT: [
    "This terminal outcome conflicts with the existing followup.",
    false,
  ],
  FOLLOWUP_ALREADY_RESOLVED: [
    "This followup obligation is already resolved.",
    false,
  ],
  FOLLOWUP_REVOCATION_REQUIRED: [
    "Cancellation requires an explicit revocation reason and reference.",
    false,
  ],
  FOLLOWUP_DELIVERY_AMBIGUOUS: [
    "Delivery is ambiguous; the followup remains pending.",
    false,
  ],
  FOLLOWUP_STORE_BUSY: ["The followup store is temporarily busy.", true],
});

export const FOLLOWUP_CONTENT_VALUE_FLAGS = Object.freeze([
  "--registration-key",
  "--summary",
  "--obligation",
  "--outcome",
  "--reason",
  "--revocation-ref",
]);

const TERMINAL_OUTCOMES = new Set(["success", "failure", "blocked"]);

export function commandFromTldrAgentArgs(args) {
  if (args[0] === "inbox" && args[1] === "get") {
    return { name: "inbox get", rest: args.slice(2) };
  }
  if (args[0] === "followup" && args[1]) {
    return { name: `followup ${args[1]}`, rest: args.slice(2) };
  }
  return { name: args[0] || "", rest: args.slice(1) };
}

function contextError(context, failure, { ownerRequired }) {
  if (context?.runtimeUnsupported) return failure("RUNTIME_UNSUPPORTED");
  if (ownerRequired && !context?.owner) {
    return failure("NOT_CONFIGURED", { remediation: "tldr-agent setup" });
  }
  if (!context?.sessionId) return failure("SESSION_IDENTITY_MISSING");
  if (context.runtimeReady === false) {
    return failure("RUNTIME_NOT_READY", {
      remediation: "tldr-agent doctor",
    });
  }
  return null;
}

function serviceError(result, failure) {
  return failure(result?.error?.code ?? result?.code);
}

function thrownServiceError(error, failure) {
  const projected = serviceError(error, failure);
  if (
    projected.error.code === "ARGUMENT_INVALID" &&
    error?.code !== "ARGUMENT_INVALID"
  ) {
    return failure("PROVIDER_UNAVAILABLE");
  }
  return projected;
}

async function invokeService(call, failure) {
  try {
    return await call();
  } catch (error) {
    return thrownServiceError(error, failure);
  }
}

function value(data, publicName, internalName) {
  return data?.[publicName] ?? data?.[internalName] ?? null;
}

async function dispatchRequire(flags, deps, { success, failure }) {
  const registrationKey = flags["--registration-key"];
  const summary = flags["--summary"];
  const originThreadId = flags["--thread"] ?? null;
  const subject = flags["--subject"] ?? null;
  if (!registrationKey || !summary || (originThreadId && subject)) {
    return failure("ARGUMENT_INVALID");
  }
  const context = await deps.resolveContext();
  const invalidContext = contextError(context, failure, {
    ownerRequired: true,
  });
  if (invalidContext) return invalidContext;
  const result = await invokeService(
    () =>
      deps.requireBeaconFollowup({
        scope: context.scope,
        sessionId: context.sessionId,
        owner: context.owner,
        registrationKey,
        originThreadId,
        subject,
        summary,
      }),
    failure,
  );
  if (!result?.ok) return serviceError(result, failure);
  const data = result.data ?? result;
  return success({
    obligation_id: value(data, "obligation_id", "obligationId"),
    bound_thread_id: value(data, "bound_thread_id", "boundThreadId"),
    confirmation_message_id: value(
      data,
      "confirmation_message_id",
      "confirmationMessageId",
    ),
    status: "pending",
  });
}

function terminalBody(flags, readBodyFile) {
  const inline = flags["--body"];
  const file = flags["--body-file"];
  if (Boolean(inline) === Boolean(file)) return null;
  try {
    return inline ?? readBodyFile(file);
  } catch {
    return null;
  }
}

async function dispatchComplete(flags, deps, { success, failure }) {
  const obligationId = flags["--obligation"];
  const outcome = flags["--outcome"];
  const body = terminalBody(flags, deps.readBodyFile);
  if (!obligationId || !TERMINAL_OUTCOMES.has(outcome) || body === null) {
    return failure("ARGUMENT_INVALID");
  }
  const context = await deps.resolveContext();
  const invalidContext = contextError(context, failure, {
    ownerRequired: true,
  });
  if (invalidContext) return invalidContext;
  const result = await invokeService(
    () =>
      deps.completeBeaconFollowup({
        scope: context.scope,
        sessionId: context.sessionId,
        owner: context.owner,
        obligationId,
        outcome,
        body,
      }),
    failure,
  );
  if (!result?.ok) return serviceError(result, failure);
  const data = result.data ?? result;
  return success({
    obligation_id: value(data, "obligation_id", "obligationId"),
    terminal_message_id: value(
      data,
      "terminal_message_id",
      "terminalMessageId",
    ),
    outcome,
    status: "fulfilled",
  });
}

async function dispatchCancel(flags, deps, { success, failure }) {
  const obligationId = flags["--obligation"];
  const reason = flags["--reason"];
  const revocationRef = flags["--revocation-ref"];
  if (!obligationId) return failure("ARGUMENT_INVALID");
  if (!reason || !revocationRef) {
    return failure("FOLLOWUP_REVOCATION_REQUIRED");
  }
  const context = await deps.resolveContext();
  const invalidContext = contextError(context, failure, {
    ownerRequired: false,
  });
  if (invalidContext) return invalidContext;
  const result = await invokeService(
    () =>
      deps.cancelBeaconFollowup({
        scope: context.scope,
        sessionId: context.sessionId,
        obligationId,
        reason,
        revocationRef,
      }),
    failure,
  );
  if (!result?.ok) return serviceError(result, failure);
  const data = result.data ?? result;
  return success({
    obligation_id: value(data, "obligation_id", "obligationId"),
    status: "cancelled",
  });
}

export async function dispatchTldrAgentFollowup(
  name,
  rest,
  deps,
  { parseFlags, success, failure },
) {
  const flags = parseFlags(rest, FOLLOWUP_COMMAND_SCHEMAS[name]);
  if (!flags) return failure("ARGUMENT_INVALID");
  if (name === "followup require") {
    return dispatchRequire(flags, deps, { success, failure });
  }
  if (name === "followup complete") {
    return dispatchComplete(flags, deps, { success, failure });
  }
  return dispatchCancel(flags, deps, { success, failure });
}
