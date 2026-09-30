import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { writeJsonAtomic } from "./store.mjs";

function activeCauseFor(causes) {
  return (
    Object.entries(causes).find(([, entry]) => entry?.quarantined)?.[0] || null
  );
}

export function clearDaemonPhaseFailureCause({
  daemonInstanceId = null,
  phase,
  cause,
  quarantine,
  quarantinePath,
  now,
}) {
  const key = `${phase || "unknown"}:${cause || "unknown"}`;
  if (!quarantine?.causes?.[key]) return quarantine;
  const causes = { ...(quarantine.causes || {}) };
  delete causes[key];
  const activeCause = activeCauseFor(causes);
  const next = {
    version: "1.0",
    active: Boolean(activeCause),
    active_cause: activeCause,
    daemon_instance_id:
      daemonInstanceId || quarantine.daemon_instance_id || null,
    updated_at: now(),
    causes,
  };
  mkdirSync(dirname(quarantinePath), { recursive: true });
  writeJsonAtomic(quarantinePath, next);
  return next;
}
