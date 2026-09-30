// In-memory, best-effort live-notification subscriber registry
// (docs/protocol.md "Live notification and event frames" — a protocol
// amendment this repository originates; see the internal provenance record). Deliberately
// not persisted: a subscription is connection-scoped and is lost on
// disconnect or daemon restart by design, matching the documented
// "events are best-effort, the durable inbox is the sole authority"
// contract (adapted from Helm's inbox.mjs degradable-pump pattern,
// the behavior inventory §3).

export function createEventBus() {
  const subscribersByPrincipal = new Map();
  // listener.v1 is intentionally a different registry from inbox.subscribe:
  // it proves only that one fenced listener is attached to one connection.
  const listenerConnections = new Map();
  const disconnectedListeners = new Map();

  const listenerKey = (listenerId, listenerGeneration) => `${listenerId}\u0000${listenerGeneration}`;

  return {
    subscribe(principalId, connection) {
      let subscribers = subscribersByPrincipal.get(principalId);
      if (!subscribers) {
        subscribers = new Set();
        subscribersByPrincipal.set(principalId, subscribers);
      }
      subscribers.add(connection);
    },

    unsubscribeConnection(connection) {
      for (const subscribers of subscribersByPrincipal.values()) subscribers.delete(connection);
      for (const [key, attached] of listenerConnections) {
        if (attached === connection) {
          listenerConnections.delete(key);
          const [listenerId, listenerGeneration] = key.split('\u0000');
          disconnectedListeners.set(key, { listenerId, listenerGeneration: Number(listenerGeneration) });
        }
      }
    },

    /**
     * Pushes eventName/payload to every connection currently subscribed
     * to principalId. A single connection's push failure is logged and
     * swallowed — never thrown back to the caller, which is always a
     * post-commit fan-out step for a durable write that has already
     * succeeded.
     */
    publish(principalId, eventName, payload, logger) {
      const subscribers = subscribersByPrincipal.get(principalId);
      if (!subscribers || subscribers.size === 0) return 0;
      let delivered = 0;
      for (const connection of subscribers) {
        try {
          connection.pushEvent(eventName, payload);
          delivered += 1;
        } catch (err) {
          logger?.warn?.({ event: 'event_push_failed', principal_id: principalId, event_name: eventName, message: err.message });
        }
      }
      return delivered;
    },

    attachListener(listenerId, listenerGeneration, connection) {
      const key = listenerKey(listenerId, listenerGeneration);
      const current = listenerConnections.get(key);
      if (current && current !== connection) return false;
      listenerConnections.set(key, connection);
      return true;
    },

    canAttachListener(listenerId, listenerGeneration, connection) {
      const current = listenerConnections.get(listenerKey(listenerId, listenerGeneration));
      return !current || current === connection;
    },

    hasListener(listenerId, listenerGeneration, connection) {
      return listenerConnections.get(listenerKey(listenerId, listenerGeneration)) === connection;
    },

    takeDisconnectedListeners() {
      const listeners = [...disconnectedListeners.values()];
      disconnectedListeners.clear();
      return listeners;
    },

    publishListener(listenerId, listenerGeneration, eventName, payload, logger) {
      const connection = listenerConnections.get(listenerKey(listenerId, listenerGeneration));
      if (!connection) return 0;
      try {
        connection.pushEvent(eventName, payload);
        return 1;
      } catch (err) {
        logger?.warn?.({ event: 'listener_event_push_failed', event_name: eventName, message: err.message });
        return 0;
      }
    },
  };
}
