// Pure channel-route descriptor rules shared by registration and state
// movement. Keeping this outside either operation prevents an imported row
// from gaining a shape the authenticated registration boundary rejects.

export const CHANNEL_ROUTE_CAPABILITIES = Object.freeze(['send', 'reply']);

// Exported so message.commit's channel_selectors validation
// (lifecycle_transition.mjs) shares the exact same reserved-word set and
// selector shape as route registration, rather than maintaining a second
// copy that could silently drift.
export const RESERVED_SELECTORS = new Set(['all', 'origin']);
const VALID_CAPABILITIES = new Set(CHANNEL_ROUTE_CAPABILITIES);
export const SELECTOR_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_LABEL_LENGTH = 120;

function invalid(field, message) {
  return { ok: false, field, message };
}

export function validateChannelRouteDescriptor({ selector, label, capabilities }) {
  if (typeof selector !== 'string' || !SELECTOR_PATTERN.test(selector) || RESERVED_SELECTORS.has(selector)) {
    return invalid('selector', 'selector must be a non-reserved lowercase channel key');
  }
  if (typeof label !== 'string' || label.length === 0 || label.length > MAX_LABEL_LENGTH) {
    return invalid('label', `label must be a non-empty string up to ${MAX_LABEL_LENGTH} characters`);
  }
  if (!Array.isArray(capabilities) || capabilities.length === 0 || capabilities.some((capability) => typeof capability !== 'string' || !VALID_CAPABILITIES.has(capability))) {
    return invalid('capabilities', 'capabilities must be a non-empty subset of send and reply');
  }
  if (new Set(capabilities).size !== capabilities.length) {
    return invalid('capabilities', 'capabilities must not contain duplicates');
  }
  return { ok: true, capabilities: CHANNEL_ROUTE_CAPABILITIES.filter((capability) => capabilities.includes(capability)) };
}

export function validateStoredChannelRouteDescriptor(route) {
  if (typeof route.capabilities !== 'string') {
    return invalid('capabilities', 'capabilities must be canonical JSON for a non-empty subset of send and reply');
  }
  let capabilities;
  try {
    capabilities = JSON.parse(route.capabilities);
  } catch {
    return invalid('capabilities', 'capabilities must be canonical JSON for a non-empty subset of send and reply');
  }
  const descriptor = validateChannelRouteDescriptor({ selector: route.selector, label: route.label, capabilities });
  if (!descriptor.ok) return descriptor;
  if (route.capabilities !== JSON.stringify(descriptor.capabilities)) {
    return invalid('capabilities', 'capabilities must use canonical send/reply ordering');
  }
  return descriptor;
}
