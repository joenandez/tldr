// Origin-pinned user effects (ack, terminal outcome) fan out to every selected
// channel route, but only the immutable origin route's delivery is typed: the
// other routes receive plain copies that can confirm, close, or fail nothing.
// Every copy still gets its own reply binding to the sending agent endpoint.

import { TightbeamError } from "../../protocol/envelope.mjs";
import { createDeliveriesForChannelRoutes } from "./message_shared.mjs";

export function requireOriginRoute(routes, originRouteId) {
  if (originRouteId && !routes.some((route) => route.id === originRouteId)) {
    throw new TightbeamError(
      "obligation_conflict",
      "a user terminal outcome or acknowledgement must include its immutable origin route",
      { field: "channel_selectors" },
    );
  }
}

export function createChannelDeliveries(
  db,
  { routes, routeReason, sourceObligationId, originRouteId, ...rest },
) {
  if (!originRouteId)
    return createDeliveriesForChannelRoutes(db, {
      ...rest,
      routes,
      routeReason,
      sourceObligationId,
    });
  const typed = createDeliveriesForChannelRoutes(db, {
    ...rest,
    routes: routes.filter((route) => route.id === originRouteId),
    routeReason,
    sourceObligationId,
  });
  const copies = createDeliveriesForChannelRoutes(db, {
    ...rest,
    routes: routes.filter((route) => route.id !== originRouteId),
  });
  return {
    liveDeliveries: [...typed.liveDeliveries, ...copies.liveDeliveries],
  };
}
