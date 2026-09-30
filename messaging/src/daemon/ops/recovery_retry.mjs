// recovery.retry — public binding for the explicit administrative retry
// transition (Project Relay parent 2.3; transitions.yaml RECOVERY-RETRY,
// actor authorized_user_or_policy). Thin like message.commit: the lifecycle
// engine (src/daemon/lifecycle_transition.mjs) owns validation, custody and
// generation fencing, lifecycle_commands idempotency, and recovery routing.
// This module only binds it to the dispatch table. The permission is the
// existing obligation-administration grant — the same vocabulary that once
// gated obligation.create/resolve — so no new auth machinery is invented;
// admin scope is deliberately excluded because the recovery actor is an
// application-side policy, not a daemon operator.

import { recoveryRetry } from '../lifecycle_transition.mjs';

export const recoveryRetryOp = {
  name: 'recovery.retry',
  allowedScopes: ['agent'],
  permission: 'manage_obligations',
  handler(context, payload, connection) {
    const { result } = recoveryRetry(context, connection, payload);
    return { result };
  },
};
