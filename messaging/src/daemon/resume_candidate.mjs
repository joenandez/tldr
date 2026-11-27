// The resumer's rule for a pending launch it will select (runResumerTick's
// candidate query). One rule, two readers: the resumer itself, and the
// stalled-holder catch-all (holder_stall.mjs), which must never call work
// "stopped" while a launch the resumer will run is pending, nor "coming"
// when no such launch exists (ac-4p2j0 r9).

import { copilotWakeScopeSql } from "./copilot_wake.mjs";
import { endpointHasWakingUnreadSql } from "./lifecycle_transition.mjs";
import { expandStoredRuntimeIds } from "./ops/resume_shared.mjs";
import {
  resumableEndpointParams,
  resumableEndpointPredicate,
} from "./resumer.mjs";
import { NOT_SUPERSEDED_ENDPOINT } from "./supervised_exit.mjs";
import { isPackageBoundCopilotRecord } from "../runtimes/copilot_wake_contract.mjs";

/** The runtimes the resumer launches: daemon-strategy records plus package-bound Copilot wake records, with every stored id spelling. */
export function selectableRuntimes(registry) {
  const daemonRecords = registry
    .list()
    .filter((record) => record.resumeStrategy === "daemon");
  const wakeRecords = registry
    .list()
    .filter((record) => isPackageBoundCopilotRecord(record));
  const ids = expandStoredRuntimeIds(
    [...daemonRecords, ...wakeRecords].map((record) => record.id),
    registry.acceptedStoredIds,
  );
  return { wakeRecords, ids };
}

/**
 * The resumer's whole candidate WHERE clause (request alias `alias`,
 * endpoint alias `e`) and its params, as of `nowIso`: a pending request on a
 * resumable, unsuperseded endpoint with a waking unread delivery and a
 * selectable runtime, that is its endpoint's representative (the oldest
 * pending request, or a takeover), with no launch in flight there. A
 * sessionless placeholder qualifies: the resumer cold-starts it. An older
 * pending request that can never launch blocks every newer one, so the
 * catch-all must ask this whole question, not the endpoint predicates alone.
 */
export function selectablePendingSql(alias, runtimes, nowIso) {
  return {
    sql: `${alias}.state = 'pending'
          AND (${resumableEndpointPredicate(alias)})
          AND ${NOT_SUPERSEDED_ENDPOINT}
          AND ${endpointHasWakingUnreadSql("e.id")}
          AND e.runtime IN (${runtimes.ids.map(() => "?").join(",")})
          AND ${copilotWakeScopeSql(runtimes.wakeRecords)}
          -- One representative per endpoint keeps a large sibling backlog
          -- from consuming the materialisation bound and starving unrelated
          -- endpoints. Per-message request rows remain durable and pending.
          AND (${alias}.reason = 'availability_takeover' OR NOT EXISTS (
            SELECT 1
              FROM resume_requests earlier
             WHERE earlier.endpoint_id = ${alias}.endpoint_id
               AND earlier.state = 'pending'
               AND (earlier.created_at < ${alias}.created_at OR (earlier.created_at = ${alias}.created_at AND earlier.id < ${alias}.id))
          ))
          -- A representative already in flight is the endpoint's bounded
          -- launch fence. Its completion/failure/expiry releases eligibility
          -- without adding another lease or endpoint state.
          AND NOT EXISTS (
            SELECT 1
              FROM resume_requests active
              JOIN claims active_claim
                ON active_claim.resource_type = 'resume_request'
               AND active_claim.resource_id = active.id
               AND active_claim.state = 'claimed'
             WHERE active.endpoint_id = ${alias}.endpoint_id
               AND active.state = 'claimed'
               AND active_claim.lease_expires_at > ?
          )`,
    params: [...resumableEndpointParams(), ...runtimes.ids, nowIso],
  };
}
