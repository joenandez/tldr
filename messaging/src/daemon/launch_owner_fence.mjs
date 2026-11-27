// ac-os0zc: every launch of a provider session shares the hook's endpoint cache
// (sessions/<id>/endpoint.json), so a launch can learn another launch's process
// generation: a predecessor still running after an availability takeover reads
// its successor's. The generation alone then cannot tell the two apart, so a
// request that changes or drains the endpoint may name the launch making it
// (`caller_launch_token`: the launch's token, or null for a launch with none).
//
// It is refused, atomically with the handler's write, when the endpoint's owner
// is another launch that the daemon observes alive right now. Everything else
// answers as before:
//   - field absent: an older client; nothing to compare.
//   - no owner token on the row (an interactive owner, or a token registration
//     dropped): the generation is the fence, as before.
//   - owner exited (persisted, or the endpoint is dead) or freshly observed
//     gone: a resume whose SessionStart register was lost uses the cache after
//     its writer exited, as on main (Codex r1 F2).
//   - owner liveness unknown (no owner tuple), or `ps` unavailable: nothing may
//     ever prove it gone (a host where ps keeps failing would wedge a resume for
//     good, Codex r2), so it never refuses a request that main accepted.
// A pending observation refuses: the process table's first look at a new owner
// is always pending (process_table.mjs), so failing open there would let the
// predecessor's first hook through. It heals once a snapshot lands (seconds).
import { TightbeamError } from "../protocol/envelope.mjs";
import { MAX_LAUNCH_TOKEN_LENGTH } from "./ops/endpoint_register.mjs";
import { observeOwnerLiveness, readOwnerFence } from "./owner_liveness.mjs";
import { processObserverFor } from "./process_table.mjs";

export const CALLER_LAUNCH_FIELD = "caller_launch_token";
const REFUSING = new Set(["alive", "pending"]);

/** The request's caller launch: undefined (not sent), null (a launch with no token) or the token. */
export function readCallerLaunch(payload) {
  if (!Object.hasOwn(payload ?? {}, CALLER_LAUNCH_FIELD)) return undefined;
  const value = payload[CALLER_LAUNCH_FIELD];
  if (
    value !== null &&
    (typeof value !== "string" ||
      value.length === 0 ||
      value.length > MAX_LAUNCH_TOKEN_LENGTH)
  ) {
    throw new TightbeamError(
      "malformed_request",
      `${CALLER_LAUNCH_FIELD} must be null or a non-empty string of at most ${MAX_LAUNCH_TOKEN_LENGTH} characters`,
      { field: CALLER_LAUNCH_FIELD },
    );
  }
  return value;
}

/** Throws launch_not_owner when another launch owns the endpoint and is not known to have exited. */
export function refuseUnlessOwnerLaunch(
  context,
  { endpointId, callerLaunch, op },
) {
  if (callerLaunch === undefined) return;
  const owner = readOwnerFence(context.db, endpointId);
  if (!owner?.owner_launch_token || owner.owner_launch_token === callerLaunch)
    return;
  const exited =
    owner.state === "dead" ||
    context.db
      .prepare("SELECT owner_process_exited_at FROM endpoints WHERE id = ?")
      .get(endpointId)?.owner_process_exited_at;
  const observeProcess = context.observeProcess ?? processObserverFor(context);
  const { liveness } = exited
    ? { liveness: "exited" }
    : observeOwnerLiveness(owner, observeProcess);
  if (!REFUSING.has(liveness)) {
    context.logger?.info({
      event: "launch_owner_fence_open",
      params: {
        endpoint_id: endpointId,
        op,
        caller_launch: callerLaunch === null ? "none" : "other",
      },
      result: { liveness },
      status: "ok",
    });
    return;
  }
  context.logger?.warn({
    event: "launch_owner_fence_refused",
    params: {
      endpoint_id: endpointId,
      op,
      caller_launch: callerLaunch === null ? "none" : "other",
    },
    result: { liveness },
    status: "refused",
  });
  throw new TightbeamError(
    "identity_conflict",
    "another launch of this session owns the endpoint and has not exited; this launch does not report or drain its state",
    { field: CALLER_LAUNCH_FIELD, reason: "launch_not_owner" },
  );
}
