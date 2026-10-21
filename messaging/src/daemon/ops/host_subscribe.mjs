// host.subscribe — session_hosts.v1. Registers the CURRENT connection as a
// live session host under its own application id; Tightbeam pushes
// host.wake_requested events to it. Connection-scoped and in-memory, like
// inbox.subscribe: the host reconnects and subscribes again after a restart.

import { requestHostCatchUpWakes } from '../session_host.mjs';

export const hostSubscribeOp = {
  name: 'host.subscribe',
  allowedScopes: ['agent'],
  permission: 'host_sessions',
  handler(context, payload, connection) {
    context.eventBus?.subscribeHost(connection.appId, connection);
    requestHostCatchUpWakes(context, connection.appId);
    return { result: { subscribed: true } };
  },
};
