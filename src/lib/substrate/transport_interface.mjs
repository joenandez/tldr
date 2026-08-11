// PRFAQ-0 Phase 1 — transport interface (Tasks 1.3).
// TransportDriver contract type definition + registry helper. Phase 1
// tldr; registers one private owner-email scheme.
//
// TransportDriver shape:
//   send(canonicalRow, ctx) -> { external_id?, deliveryState, error? }
//   inboundWebhook(rawPayload, ctx) -> canonicalRow
//   subscribe(workspaceId, kinds[], cb)
//   probe() -> { available, version?, hint? }

const REGISTERED_SCHEMES = Object.freeze(["email"]);

const drivers = new Map();

export function registerTransport(scheme, driver) {
  if (typeof scheme !== "string" || scheme.length === 0) {
    throw new TypeError("registerTransport: scheme must be a non-empty string");
  }
  if (!REGISTERED_SCHEMES.includes(scheme)) {
    throw new Error(
      `registerTransport: scheme '${scheme}' is not in the v1 registry: ${REGISTERED_SCHEMES.join(", ")}`,
    );
  }
  if (!driver || typeof driver.send !== "function") {
    throw new TypeError(
      `registerTransport: driver for scheme '${scheme}' must expose a 'send' function`,
    );
  }
  drivers.set(scheme, driver);
  return driver;
}

export function unregisterTransport(scheme) {
  drivers.delete(scheme);
}

export function getTransport(scheme) {
  return drivers.get(scheme) || null;
}

export function listRegisteredSchemes() {
  return Array.from(REGISTERED_SCHEMES);
}

export function listLoadedSchemes() {
  return Array.from(drivers.keys());
}

// Test-only escape hatch — Production code MUST NOT call this.
export function _resetForTests() {
  drivers.clear();
}

export { REGISTERED_SCHEMES };
