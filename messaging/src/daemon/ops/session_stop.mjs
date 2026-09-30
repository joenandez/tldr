// session.stop — public binding for the idempotent Stop decision (Project
// Relay parent 3.2; transitions.yaml STOP-REQUEST). Thin like recovery:
// the lifecycle engine (src/daemon/lifecycle_transition.mjs) owns the
// endpoint fence, the block-or-allow evaluation, root_attention evidence,
// idle marking, and ledger replay. This module only binds it to the
// dispatch table.
//
// The permission is deliberately the ENDPOINT-administration grant, not
// manage_obligations: the request carries endpoint identity plus a process
// generation — never a principal action — so the authority it exercises is
// exactly what register_endpoints already governs for endpoint.state.set.
// Every Tightbeam-managed hook holds that grant (session-start cannot work
// without it), which is what keeps the gate enforced for every managed
// session instead of degrading for apps that never held obligation powers.

import { sessionStop } from '../lifecycle_transition.mjs';

export const sessionStopOp = {
  name: 'session.stop',
  allowedScopes: ['agent'],
  permission: 'register_endpoints',
  handler(context, payload, connection) {
    const { result } = sessionStop(context, connection, payload);
    return { result };
  },
};
