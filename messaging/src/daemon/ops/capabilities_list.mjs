// capabilities.list — docs/protocol.md "Compatibility and health".

import { BASELINE_CAPABILITIES } from '../../protocol/envelope.mjs';

export const capabilitiesListOp = {
  name: 'capabilities.list',
  allowedScopes: ['admin', 'agent'],
  permission: 'read_health',
  handler() {
    return { result: { capabilities: BASELINE_CAPABILITIES } };
  },
};
