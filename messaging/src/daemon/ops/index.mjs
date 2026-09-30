// Aggregates every operation handler module into one dispatch table.
// Later workstreams add a new src/daemon/ops/<name>.mjs module and one
// registerOp(...) call here — the server loop (src/daemon/server.mjs)
// never changes.

import { TightbeamError } from '../../protocol/envelope.mjs';
import { createOpTable, registerOp, dispatch as dispatchOp } from './registry.mjs';
import { handshakeOp } from './handshake.mjs';
import { daemonStatusOp } from './daemon_status.mjs';
import { capabilitiesListOp } from './capabilities_list.mjs';
import { applicationRegisterOp } from './application_register.mjs';
import { applicationReregisterOp } from './application_reregister.mjs';
import { applicationPermissionsSetOp } from './application_permissions_set.mjs';
import { authorityRegisterOp } from './authority_register.mjs';
import { principalRegisterOp } from './principal_register.mjs';
import { principalResolveOp } from './principal_resolve.mjs';
import { endpointRegisterOp } from './endpoint_register.mjs';
import { endpointStateSetOp } from './endpoint_state_set.mjs';
import { endpointCloseOp } from './endpoint_close.mjs';
import { endpointRetirementGetOp } from './endpoint_retirement_get.mjs';
import { endpointListOp } from './endpoint_list.mjs';
import { channelRouteListOp, channelRouteRegisterOp, channelRouteRetireOp } from './channel_route.mjs';
import { conversationCreateOp } from './conversation_create.mjs';
import { conversationCloseOp } from './conversation_close.mjs';
import { messageCommitOp } from './message_commit.mjs';
import { messageDeliveryListOp } from './message_delivery_list.mjs';
import { recoveryRetryOp } from './recovery_retry.mjs';
import { recoverySwitchOp } from './recovery_switch.mjs';
import { sessionStopOp } from './session_stop.mjs';
import { lifecycleViewOp } from './lifecycle_view.mjs';
import { recoveryContextOp } from './recovery_context.mjs';
import { inboxListOp } from './inbox_list.mjs';
import { messageReadOp } from './message_read.mjs';
import { messageReceiveOp } from './message_receive.mjs';
import { messageNotificationNextOp } from './message_notification_next.mjs';
import { messageAcknowledgeOp } from './message_acknowledge.mjs';
import { deliveryClaimOp } from './delivery_claim.mjs';
import { deliveryCompleteOp } from './delivery_complete.mjs';
import { deliveryReleaseOp } from './delivery_release.mjs';
import { inboxSubscribeOp } from './inbox_subscribe.mjs';
import { resumeListOp } from './resume_list.mjs';
import { resumeClaimOp } from './resume_claim.mjs';
import { resumeCompleteOp } from './resume_complete.mjs';
import { resumeFailOp } from './resume_fail.mjs';
import { stateExportOp } from './state_export.mjs';
import { stateImportOp } from './state_import.mjs';
import { migrationStatusOp } from './migration_status.mjs';
import { runtimeRegisterOp } from './runtime_register.mjs';
import {
  channelReplyPublishOp,
  listenerAcknowledgeOp,
  listenerAttachOp,
  listenerEndOp,
  listenerHeartbeatOp,
} from './reply_listener_contract.mjs';

/**
 * The single-writer boundary (plan «Technical Approach 1», guarded
 * activation step 6): exactly one forward writer — message.commit — may
 * create or mutate lifecycle truth after the cutover. These legacy
 * lifecycle operations are therefore retired outright: no dual-writer
 * window, no capability negotiation, no version predicates on rows. Each
 * keeps its NAME in the table (an operator replaying a pre-cutover
 * command gets a precise typed diagnosis, not "unknown operation") and
 * answers only with `operation_disabled`. The handlers run before any
 * payload validation or idempotency lookup, so a pre-cutover idempotency
 * entry can never be answered by a disabled operation either.
 *
 * permission is null deliberately: the cutover applies to every caller,
 * so an agent without `manage_obligations` learns the same fact as one
 * with it instead of a misleading permission_denied.
 */
function disabledLifecycleOperation(name, guidance) {
  return {
    name,
    permission: null,
    handler() {
      throw new TightbeamError('operation_disabled', `${name} is disabled by the forward lifecycle cutover; ${guidance}`);
    },
  };
}

const MESSAGE_COMMIT_GUIDANCE = 'application-authored messages and their lifecycle effects go through message.commit';

export const DISABLED_LIFECYCLE_OPERATIONS = [
  disabledLifecycleOperation('message.send', MESSAGE_COMMIT_GUIDANCE),
  disabledLifecycleOperation('message.reply', MESSAGE_COMMIT_GUIDANCE),
  disabledLifecycleOperation('obligation.create', 'the forward obligation graph is written only through message.commit effects'),
  disabledLifecycleOperation('obligation.resolve', 'forward work closes only through message.commit close effects'),
  disabledLifecycleOperation('obligation.attempt.start', 'recovery of forward work is admitted only through explicit recovery operations on the forward graph'),
  disabledLifecycleOperation('obligation.attempt.fail', 'custody loss of forward work is recorded only through the forward graph'),
  // The Stop gate's input projection read (and with record_stop_block
  // wrote) only legacy obligation columns; the Stop decision itself moves
  // into the daemon's session.stop operation.
  disabledLifecycleOperation('obligation.list', 'the Stop decision is made by session.stop against the forward graph'),
];

export function buildOpTable() {
  const table = createOpTable();
  registerOp(table, handshakeOp);
  registerOp(table, daemonStatusOp);
  registerOp(table, capabilitiesListOp);
  registerOp(table, applicationRegisterOp);
  registerOp(table, applicationReregisterOp);
  registerOp(table, applicationPermissionsSetOp);
  registerOp(table, authorityRegisterOp);
  registerOp(table, principalRegisterOp);
  registerOp(table, principalResolveOp);
  registerOp(table, endpointRegisterOp);
  registerOp(table, endpointStateSetOp);
  registerOp(table, endpointCloseOp);
  registerOp(table, endpointRetirementGetOp);
  // The caller-scoped session read: Helm gets session facts here, through
  // the CLI, instead of from its own session hooks.
  registerOp(table, endpointListOp);
  registerOp(table, channelRouteRegisterOp);
  registerOp(table, channelRouteListOp);
  registerOp(table, channelRouteRetireOp);
  // Contract registrations keep the new planes narrow while their durable
  // authorization and listener state transitions arrive in later parents.
  registerOp(table, channelReplyPublishOp);
  registerOp(table, listenerAttachOp);
  registerOp(table, listenerHeartbeatOp);
  registerOp(table, listenerAcknowledgeOp);
  registerOp(table, listenerEndOp);
  registerOp(table, conversationCreateOp);
  registerOp(table, conversationCloseOp);
  // The single forward writer (plan «Technical Approach 1», guarded
  // activation step 6): every post-cutover application-authored message
  // reaches the graph only through this operation, with exactly one
  // required effect. The disabled legacy writers below stay name-addressable
  // for typed rejections; nothing else may write lifecycle truth.
  registerOp(table, messageCommitOp);
  registerOp(table, messageDeliveryListOp);
  // The explicit administrative recovery transitions (transitions.yaml
  // RECOVERY-RETRY / RECOVERY-SWITCH) join message.commit as the only
  // forward writers of lifecycle truth: engine-owned validation behind thin
  // wrappers, agent scope gated on the existing manage_obligations grant.
  registerOp(table, recoveryRetryOp);
  registerOp(table, recoverySwitchOp);
  // The idempotent Stop decision (transitions.yaml STOP-REQUEST): engine-
  // owned block-or-allow behind a thin wrapper, agent scope gated on the
  // endpoint-administration grant the Stop actor's identity already rests on.
  registerOp(table, sessionStopOp);
  // The forward derived projection (transitions.yaml's read side; plan
  // «Technical Approach 6»): labels derive at READ time from canonical
  // records only — no stored combined status, no listener input.
  registerOp(table, lifecycleViewOp);
  registerOp(table, recoveryContextOp);
  for (const disabled of DISABLED_LIFECYCLE_OPERATIONS) registerOp(table, disabled);
  registerOp(table, inboxListOp);
  registerOp(table, messageReadOp);
  registerOp(table, messageReceiveOp);
  registerOp(table, messageNotificationNextOp);
  registerOp(table, messageAcknowledgeOp);
  registerOp(table, deliveryClaimOp);
  registerOp(table, deliveryCompleteOp);
  registerOp(table, deliveryReleaseOp);
  registerOp(table, inboxSubscribeOp);
  registerOp(table, resumeListOp);
  registerOp(table, resumeClaimOp);
  registerOp(table, resumeCompleteOp);
  registerOp(table, resumeFailOp);
  registerOp(table, stateExportOp);
  registerOp(table, stateImportOp);
  registerOp(table, migrationStatusOp);
  registerOp(table, runtimeRegisterOp);
  return table;
}

export function createConnectionState() {
  return {
    authenticated: false,
    scope: null,
    appId: null,
    credentialHash: null,
    permissions: new Map(),
  };
}

export const dispatch = dispatchOp;
