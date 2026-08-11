import { reconcileBeaconStopIndex } from "./tldr_agent_beacon_stop_index.mjs";
import { bootstrapBlockedUnreadMarker } from "./substrate/blocked_unread.mjs";

export function initializeProductionReadBoundary(
  home,
  {
    bootstrapBlockedUnreadMarker:
      bootstrapUnread = bootstrapBlockedUnreadMarker,
    reconcileBeaconStopIndex: reconcileStopIndex = reconcileBeaconStopIndex,
  } = {},
) {
  const unread = bootstrapUnread(null, { home });
  if (unread?.ok !== true) return unread;
  reconcileStopIndex({ home });
  return unread;
}
