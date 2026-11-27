// Channel delivery outcome for the CLI. ac-jfv.55: a failed copy with a reason was skipped by
// policy (another channel carries the message), so it reads as skipped, never as a failure.
export const channelStates = (deliveries) =>
  deliveries
    ?.map(
      (delivery) =>
        `${delivery.label ?? delivery.selector ?? "channel"} ${delivery.state}${delivery.state === "skipped" && delivery.reason ? ` (${delivery.reason})` : ""}${delivery.state === "failed" && delivery.failure_cause ? ` (${delivery.failure_cause})` : ""}`,
    )
    .join(", ");
export const channelDeliveriesOf = (deliveries) =>
  (deliveries?.channel_deliveries ?? []).map((delivery) =>
    delivery.state === "failed" && delivery.reason
      ? { ...delivery, state: "skipped" }
      : delivery,
  );
export const TERMINAL_CHANNEL_STATES = [
  "delivered",
  "failed",
  "cancelled",
  "skipped",
];
export const skippedNote = (deliveries) =>
  deliveries?.some((delivery) => delivery.state === "skipped")
    ? ` · ${channelStates(deliveries.filter((delivery) => delivery.state === "skipped"))}`
    : "";

// Skipped copies carry nothing; with only skipped copies the message reached no channel.
const carryingDeliveries = (channelDeliveries) => {
  const carried = channelDeliveries.filter(
    (delivery) => delivery.state !== "skipped",
  );
  return carried.length > 0 || channelDeliveries.length === 0
    ? carried
    : channelDeliveries.map((delivery) => ({ ...delivery, state: "failed" }));
};

export function deliveryOutcome(channelDeliveries) {
  const deliveries = carryingDeliveries(channelDeliveries);
  const states = new Set(deliveries.map((delivery) => delivery.state));
  if (states.size < 2)
    return states.size === 0
      ? "committed"
      : states.has("delivered")
        ? "delivered"
        : [...states][0];
  // Partial needs a delivered channel beside an undelivered one; with none delivered it is failed or still pending.
  if (!states.has("delivered"))
    return [...states].every((state) => ["failed", "cancelled"].includes(state))
      ? "failed"
      : "pending";
  return "partial";
}
