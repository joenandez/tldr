// message.commit — the sole forward application-authored message operation
// (Project Relay parent 2.2; plan «API Design — message.commit» and
// «Technical Approach 1»). The wrapper is deliberately thin: the lifecycle
// transition engine (src/daemon/lifecycle_transition.mjs) owns addressing,
// effect validation, custody/generation fencing, idempotent replay,
// durable delivery routing, and post-commit fan-out inside one transaction.
// This module only binds that engine to the dispatch table, wiring auth
// exactly like the other authenticated message operations: agent scope,
// with send_as_principal OR publish_inbound_messages enforced inside the
// engine's callerMayActAsPrincipal check (permission is null here because
// either grant admits).

import { commitMessageWithEffect } from '../lifecycle_transition.mjs';

export const messageCommitOp = {
  name: 'message.commit',
  allowedScopes: ['agent'],
  permission: null, // send_as_principal OR publish_inbound_messages; checked in the engine.
  handler(context, payload, connection) {
    const { result } = commitMessageWithEffect(context, connection, payload);
    return { result };
  },
};
