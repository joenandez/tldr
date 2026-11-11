// Claim and retire a pending provider-run marker (see provider_run_outcome.mjs). A marker is finalized by
// whichever observer claims it first (`<marker>.claim`, taken over when stale). Once its job update is
// written it is retired, so no observer finalizes it again (that would re-hold the slot and repeat records).
import {
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";

// A claim older than this belongs to a finalizer that died mid-way; the next
// observer takes over rather than dropping the outcome.
const STALE_CLAIM_MS = 60_000;
// Claim content of a marker whose records are written but which could not be removed, renamed or rewritten.
const RETIRED = "finalized";

const claimPath = (path) => `${path}.claim`;

/** The marker's records are written; it must never be finalized again. */
export function isRetiredByClaim(path) {
  try {
    return readFileSync(claimPath(path), "utf8") === RETIRED;
  } catch {
    return false;
  }
}

function takeOverStale(lock) {
  try {
    if (Date.now() - statSync(lock).mtimeMs < STALE_CLAIM_MS) return false;
    utimesSync(lock, new Date(), new Date());
    return true;
  } catch {
    return false;
  }
}

export function claim(path) {
  const lock = claimPath(path);
  try {
    closeSync(openSync(lock, "wx"));
    return true;
  } catch (err) {
    return (
      err?.code === "EEXIST" && !isRetiredByClaim(path) && takeOverStale(lock)
    );
  }
}

export function releaseClaim(path) {
  try {
    rmSync(claimPath(path), { force: true });
  } catch {
    /* best effort */
  }
}

function logRetireFailed(marker, err, kept) {
  process.stderr.write(
    `[helm provider-outcome] ${JSON.stringify({ event: "provider_run_retire_failed", run: marker.run_id, job: marker.job_id, claim_kept: kept, error: err?.message || String(err) })}\n`,
  );
}

/** Retire a finalized marker and drop its claim: remove it, else move it aside, else mark it finalized in
 * place (readMarker skips it). If all three fail, the claim is kept with RETIRED content instead. */
export function retireMarker(path, marker) {
  const attempts = [
    () => rmSync(path, { force: true }),
    () => renameSync(path, `${path}.quarantined`),
    () =>
      writeFileSync(
        path,
        JSON.stringify({ ...marker, finalized: true }),
        "utf8",
      ),
  ];
  let lastError;
  for (const attempt of attempts) {
    try {
      attempt();
      releaseClaim(path);
      return;
    } catch (err) {
      lastError = err;
    }
  }
  try {
    writeFileSync(claimPath(path), RETIRED, "utf8");
    logRetireFailed(marker, lastError, true);
  } catch (err) {
    logRetireFailed(marker, err, false);
  }
}
