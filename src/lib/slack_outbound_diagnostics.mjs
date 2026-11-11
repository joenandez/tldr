import { appendActivityEvent } from "./tldr_agent_diagnostics.mjs";
import { stderrLogger } from "./tightbeam_slack_adapter.mjs";

// The events an operator needs on disk: a post whose answer was lost, and a claim released
// before any Slack request (pre-flight, not counted), which tells it from a cut post.
const DIAGNOSTIC_EVENTS = new Map([
  ["slack_post_recovered", "success"],
  ["slack_post_lookup_failed", "retry"],
  ["slack_delivery_abort_released", "retry"],
]);

export function outboundLogger(home) {
  return (entry) => {
    stderrLogger(entry);
    if (DIAGNOSTIC_EVENTS.has(entry.event)) {
      appendActivityEvent(
        {
          event_type: entry.event,
          // A failed release must not read as a normal retry.
          status:
            entry.status === "error"
              ? "error"
              : DIAGNOSTIC_EVENTS.get(entry.event),
          cause: entry.params?.cause,
          result: entry.result,
        },
        { home },
      );
    }
  };
}
