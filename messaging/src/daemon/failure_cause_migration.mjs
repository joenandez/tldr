// Schema 32 (ac-jfv.239): `deliveries.failure_cause`, a failed copy's durable cause (claims_shared.mjs
// owns the vocabulary). Before it, the only record was the delivery's latest claim outcome, so the
// migration fills every failed row from that. A channel copy with any other outcome (a pre-ac-votvj
// exhaustion left only `expired`) keeps it as legacy:<outcome>, which counts unresolved. An endpoint
// delivery has no cause unless it was skipped.
import {
  CHANNEL_COPY_CAUSES,
  CLAIM_ATTEMPTS_EXHAUSTED,
  CONSUMER_FAILED,
} from "./ops/claims_shared.mjs";

const DAEMON_CAUSES = new Set([
  ...CHANNEL_COPY_CAUSES,
  CLAIM_ATTEMPTS_EXHAUSTED,
]);
const copyCause = (outcome) =>
  outcome === "failed"
    ? CONSUMER_FAILED
    : DAEMON_CAUSES.has(outcome)
      ? outcome
      : `legacy:${outcome ?? "none"}`;
export const backfilledCause = (row, outcome) =>
  outcome?.startsWith("skipped:")
    ? outcome
    : row.channel_route_id === null
      ? null
      : copyCause(outcome);

export function applyFailureCauseMigration(db) {
  db.exec("ALTER TABLE deliveries ADD COLUMN failure_cause TEXT");
  // Ordered by id, so each delivery's last entry is its latest claim.
  const latest = new Map(
    db
      .prepare(
        "SELECT resource_id, outcome FROM claims WHERE resource_type = 'delivery' ORDER BY id",
      )
      .all()
      .map((claim) => [claim.resource_id, claim.outcome]),
  );
  const set = db.prepare(
    "UPDATE deliveries SET failure_cause = ? WHERE id = ?",
  );
  for (const row of db
    .prepare(
      "SELECT id, channel_route_id FROM deliveries WHERE state = 'failed'",
    )
    .all()) {
    const cause = backfilledCause(row, latest.get(row.id));
    if (cause !== null) set.run(cause, row.id);
  }
}
