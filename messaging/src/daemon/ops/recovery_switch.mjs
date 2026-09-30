// recovery.switch — public binding for the explicit administrative switch
// transition (Project Relay parent 2.3; transitions.yaml RECOVERY-SWITCH).
// Same shape as recovery.retry: the engine owns every verdict (validation,
// fencing, subtree supersession, ledger idempotency, routing); this wrapper
// only binds it to the dispatch table under the existing
// manage_obligations grant, agent scope only.

import { recoverySwitch } from '../lifecycle_transition.mjs';

export const recoverySwitchOp = {
  name: 'recovery.switch',
  allowedScopes: ['agent'],
  permission: 'manage_obligations',
  handler(context, payload, connection) {
    const { result } = recoverySwitch(context, connection, payload);
    return { result };
  },
};
