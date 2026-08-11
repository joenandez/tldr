import { createHash } from "node:crypto";

function nonempty(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} is required`);
  }
  return value.trim();
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(prefix, value) {
  return `${prefix}:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

export function outboundEffectValueHash(value) {
  return hash("sha256", value);
}

export function deriveSideEffectKey({
  namespace,
  logicalEventKey,
  effect,
  channel,
  recipient,
  templateVersion = null,
} = {}) {
  return hash("side_effect_sha256", {
    namespace: nonempty(namespace, "namespace"),
    logical_event_key: nonempty(logicalEventKey, "logicalEventKey"),
    effect: nonempty(effect, "effect"),
    channel: nonempty(channel, "channel"),
    recipient: nonempty(recipient, "recipient"),
    template_version:
      templateVersion === null || templateVersion === undefined
        ? null
        : nonempty(templateVersion, "templateVersion"),
  });
}

export function outboundEffectPayloadMatches(
  row,
  { payload, renderInputs = {} } = {},
) {
  return (
    row?.payload_hash === outboundEffectValueHash(payload ?? null) &&
    row?.render_inputs_hash === outboundEffectValueHash(renderInputs ?? null)
  );
}
