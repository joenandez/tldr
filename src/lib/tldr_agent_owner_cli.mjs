// tldr; has no retained Helm equivalent for this private adapter: Helm's
// CLI exposed broad scheduler/setup verbs, while tldr; owner commands must
// be thin presentation-only calls into one internal setup service.
export async function dispatchOwnerCommand({
  name,
  rest,
  deps,
  schemas,
  parseFlags,
  success,
  failure,
}) {
  const flags = parseFlags(rest, schemas[name]);
  if (!flags) return failure("ARGUMENT_INVALID");
  const ownsService = typeof deps.ownerSetupService === "function";
  if (
    name === "update" &&
    ownsService &&
    typeof deps.installLifecycle === "function"
  ) {
    return updateInstalledRuntime({ deps, failure, success });
  }
  const service = ownsService
    ? await deps.ownerSetupService()
    : deps.ownerSetupService;
  const ownerTTY =
    typeof deps.ownerTTY === "function" ? await deps.ownerTTY() : deps.ownerTTY;
  if (!service)
    return failure("NOT_CONFIGURED", { remediation: "tldr-agent setup" });
  let result;
  if (name === "setup") {
    result = await service.setup(await ownerTTY?.collectSetupInputs?.());
  } else if (name === "update") {
    result = await service.update();
  } else if (name === "uninstall") {
    result = await service.uninstall();
  } else if (name === "doctor") {
    result = await service.repair({ deep: flags["--deep"] === true });
  } else if (name === "status") {
    result = await service.status();
  } else if (name === "daemon") {
    result =
      flags["--foreground"] === true
        ? await deps.runDaemonForeground?.()
        : await service.status();
  }
  try {
    return projectResult(result, success);
  } finally {
    if (ownsService) service?.close?.();
  }
}

async function updateInstalledRuntime({ deps, failure, success }) {
  let service = null;
  try {
    const lifecycle = await deps.installLifecycle();
    if (typeof lifecycle?.update !== "function") {
      return failure("DAEMON_UNAVAILABLE");
    }
    const updated = await lifecycle.update();
    if (updated?.ok === false) return failure("DAEMON_UNAVAILABLE");
    service = await deps.ownerSetupService();
    if (!service) return failure("NOT_CONFIGURED");
    return projectResult(await service.status(), success);
  } catch (error) {
    return failure(ownerUpdateErrorCode(error));
  } finally {
    service?.close?.();
  }
}

function ownerUpdateErrorCode(error) {
  if (runtimeStoreCorrupt(error)) return "RUNTIME_STORE_CORRUPT";
  const seen = new Set();
  for (
    let current = error;
    current && !seen.has(current);
    current = current.cause
  ) {
    seen.add(current);
    if (current.code === "UPDATE_UNAVAILABLE") {
      return "UPDATE_UNAVAILABLE";
    }
    if (current.code === "DAEMON_QUIESCE_TIMEOUT") {
      return "DAEMON_QUIESCE_TIMEOUT";
    }
  }
  return "DAEMON_UNAVAILABLE";
}

function runtimeStoreCorrupt(error) {
  const seen = new Set();
  for (
    let current = error;
    current && !seen.has(current);
    current = current.cause
  ) {
    seen.add(current);
    if (
      /database disk image is malformed|file is not a database/i.test(
        String(current.message || ""),
      )
    ) {
      return true;
    }
  }
  return false;
}

function projectResult(result, success) {
  if (result?.ok === false) {
    return { ok: false, data: null, error: result.error ?? null };
  }
  return success(result?.data ?? result);
}
