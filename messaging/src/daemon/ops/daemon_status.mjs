// daemon.status — docs/protocol.md "Compatibility and health". Requires
// authentication like every other operation (no unauthenticated ping).

export const daemonStatusOp = {
  name: 'daemon.status',
  allowedScopes: ['admin', 'agent'],
  permission: 'read_health',
  handler(context) {
    return {
      result: {
        status: 'ok',
        uptime_ms: Date.now() - context.startedAt,
        protocol_version: context.protocolVersion,
        state_schema_version: context.schemaVersion,
        daemon_version: context.daemonVersion,
      },
    };
  },
};
