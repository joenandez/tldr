// endpoint.state.set — docs/protocol.md "Principal and endpoint
// lifecycle". Existence is checked before the authority-scoped permission
// check (the endpoint's own authority_name is required to evaluate that
// scope), which is why endpoint_unknown is a valid outcome here even
// though the analogous inbox-read ops must never reveal existence
// (docs/security-model.md Threat table: that non-leak rule is specific to
// read_inbox). A closed endpoint is terminal: any further transition
// conflicts with the recorded terminal fact and fails closed with
// identity_conflict (the state ownership contract §3 "Conflicting verified
// session facts fail closed").
//
// This operation records what the session is doing. The one other write
// it makes follows from that record: a `busy` session no longer needs the
// Stop listener that parked for it (COE-2026-09-22 defect 2), so `busy`
// ends it and hands what it was presenting to the tool-boundary doorbell.
// It does not complete a pending resume request — a request is satisfied
// when the revived session actually reads the message (message.read), not
// when something asserts a state.
//
// `dead` splits into two shapes (Project Relay parent 4.1, ENDPOINT-DEATH;
// plan «Technical Approach 5» "require death evidence to name the observed
// process generation"). With `observed_process_generation` the assert is
// POSITIVE death evidence: the shared custody-loss reconciler
// (src/daemon/custody_reconciler.mjs) decides it in one transaction —
// exact owned attempt/delegation closed failed, root left open, one parent
// custody-loss route per failed child or a root attention record for a
// chain that has none — and evidence naming any
// generation other than the recorded one is a typed conflict with zero
// writes, so a stale observation can never fail newer custody. Without the
// field the assert stays what it always was: a transport state write that
// drives no reconciliation whatsoever, because obligation age,
// acknowledgement age, silence, and missing listeners are never evidence.

import { TightbeamError } from '../../protocol/envelope.mjs';
import { withTransaction } from '../db.mjs';
import { authorityIsAllowed } from './authority_scope.mjs';
import { releaseListenersForBusySession } from './listener_operations.mjs';
import { reconcileCustodyLoss } from '../custody_reconciler.mjs';

// busy = alive and mid-turn, idle = alive and between turns, dead = the
// process is gone. `closed` is deliberately absent: it is the terminal
// "this session will never return" fact and stays reachable only through
// endpoint.close, which also records closed_at.
const KNOWN_STATES = new Set(['busy', 'idle', 'dead', 'takeover_pending']);
const WRITABLE_STATES = new Set(['busy', 'idle', 'dead']);

export const endpointStateSetOp = {
  name: 'endpoint.state.set',
  allowedScopes: ['agent'],
  permission: 'register_endpoints',
  handler(context, payload, connection) {
    const endpointId = payload && payload.endpoint_id;
    const state = payload && payload.state;
    const processGeneration = payload && payload.process_generation;
    if (typeof endpointId !== 'string' || endpointId.length === 0) {
      throw new TightbeamError('malformed_request', 'endpoint_id is required and must be a string', { field: 'endpoint_id' });
    }
    if (typeof state !== 'string' || !KNOWN_STATES.has(state)) {
      throw new TightbeamError('malformed_request', 'state must be one of "busy", "idle", "dead", "takeover_pending"', { field: 'state' });
    }
    if (!WRITABLE_STATES.has(state)) {
      throw new TightbeamError('identity_conflict', 'takeover_pending is reserved for the availability takeover transaction', { field: 'state' });
    }
    if (!Number.isInteger(processGeneration) || processGeneration < 1) {
      throw new TightbeamError('malformed_request', 'process_generation is required and must be a positive integer', { field: 'process_generation' });
    }
    // Positive death evidence names the observed process generation; no
    // other state takes one. Rejected before anything is read or written.
    let observedProcessGeneration;
    if (payload.observed_process_generation !== undefined) {
      if (state !== 'dead') {
        throw new TightbeamError('malformed_request', 'observed_process_generation is only valid with state "dead"', { field: 'observed_process_generation' });
      }
      if (!Number.isInteger(payload.observed_process_generation) || payload.observed_process_generation < 1) {
        throw new TightbeamError('malformed_request', 'observed_process_generation must be a positive integer', { field: 'observed_process_generation' });
      }
      observedProcessGeneration = payload.observed_process_generation;
    }

    const endpoint = context.db.prepare('SELECT id, authority_name, state, created_by_app_id, process_generation FROM endpoints WHERE id = ?').get(endpointId);
    if (!endpoint) {
      throw new TightbeamError('endpoint_unknown', `no endpoint registered with id "${endpointId}"`);
    }

    if (!authorityIsAllowed(connection, 'register_endpoints', endpoint.authority_name)) {
      throw new TightbeamError('permission_denied', `register_endpoints is not granted for authority "${endpoint.authority_name}"`);
    }
    // F3: two applications sharing the same authority scope must not be
    // able to modify each other's endpoints — authority scope alone is
    // not ownership.
    if (endpoint.created_by_app_id !== connection.appId) {
      throw new TightbeamError('permission_denied', `register_endpoints is not granted for authority "${endpoint.authority_name}"`);
    }
    if (endpoint.process_generation !== processGeneration) {
      throw new TightbeamError('obligation_conflict', 'process_generation does not name the endpoint\'s active process', { field: 'process_generation', reason: 'process_generation_stale' });
    }

    if (endpoint.state === 'closed' || endpoint.state === 'retiring' || endpoint.state === 'takeover_pending') {
      throw new TightbeamError('identity_conflict', `endpoint is ${endpoint.state}; state cannot be reasserted`, { field: 'endpoint_id' });
    }

    if (observedProcessGeneration !== undefined) {
      // The reconciler owns the single decision transaction: endpoint
      // fence, generation fence, exact closures, and the one route. A
      // fenced observation returns as a counted no-op and surfaces here as
      // the typed conflict — a stale observation wrote nothing anywhere.
      const outcome = reconcileCustodyLoss(context, { endpointId, evidenceKind: 'endpoint_state_dead', observedProcessGeneration });
      if (outcome.reason === 'stale_generation') {
        throw new TightbeamError(
          'obligation_conflict',
          `death evidence names process generation ${observedProcessGeneration}, but endpoint "${endpointId}" is recorded at a different generation; a stale observation cannot fail newer custody`,
          { field: 'observed_process_generation' },
        );
      }
      const recordedAt = context.db.prepare('SELECT updated_at FROM endpoints WHERE id = ?').get(endpointId).updated_at;
      return {
        result: {
          endpoint_id: endpointId,
          state: 'dead',
          updated_at: recordedAt,
          custody_lost: {
            closed_obligations: outcome.closed,
            parent_delivery_id: outcome.route?.kind === 'parent_delivery' ? outcome.route.delivery_id : null,
            // One wake per failed child: a death that closes several
            // accepted delegations routes several, so the caller learns
            // each one and not only the first.
            parent_delivery_ids: (outcome.routes ?? []).map((route) => route.delivery_id),
            // The FULL affected set, routed or not: a routed parent wake
            // covers the chain's visibility record, but the caller still
            // learns every root this custody loss touched.
            attention_roots: Array.isArray(outcome.attentionRoots) ? outcome.attentionRoots : outcome.route?.kind === 'root_attention' ? outcome.route.roots : [],
          },
        },
      };
    }

    const updatedAt = new Date().toISOString();
    withTransaction(context.db, () => {
      context.db.prepare('UPDATE endpoints SET state = ?, updated_at = ? WHERE id = ?').run(state, updatedAt, endpointId);
      if (state === 'busy') releaseListenersForBusySession(context, { endpointId, processGeneration, now: updatedAt });
    });
    if (state === 'dead') {
      context.logger?.info({
        event: 'TEMP DEATH endpoint_state_set_without_evidence',
        params: { endpoint_id: endpointId, result: 'transport_state_only' },
        status: 'ok',
      });
    }

    return { result: { endpoint_id: endpointId, state, updated_at: updatedAt } };
  },
};
