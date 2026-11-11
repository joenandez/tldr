// job_reregistration — what `schedule --replace` and `schedule --merge` keep
// when they rewrite an existing job (see scheduleJob in job_service.mjs).

function isPlainRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] =
      isPlainRecord(value) && isPlainRecord(base[key])
        ? deepMerge(base[key], value)
        : value;
  }
  return out;
}

// `schedule --merge`: fields the caller did not pass keep their current value.
// Nested objects merge key by key (so a hand-set schedule.misfire_grace_sec or
// conditions.file_exists survives); arrays and scalars replace. Two
// redefinitions replace their section wholesale so stale keys cannot leak
// into the new shape: a schedule whose type changes, and a process whose
// command changes (its old args/stdin belong to the old command).
export function mergeJobDefinition(existing, input) {
  const { state: _state, meta: _meta, ...definition } = existing;
  const patch = { ...input };
  delete patch.id;
  delete patch.state;
  delete patch.meta;
  const merged = deepMerge(definition, patch);
  if (
    isPlainRecord(input.schedule) &&
    input.schedule.type &&
    input.schedule.type !== existing.schedule?.type
  ) {
    merged.schedule = input.schedule;
  }
  if (
    isPlainRecord(input.process) &&
    input.process.command &&
    input.process.command !== existing.process?.command
  ) {
    merged.process = input.process;
  }
  // Explicit state fields merge over the current state like everything else.
  if (isPlainRecord(input.state)) {
    merged.state = { ...(existing.state || {}), ...input.state };
  }
  if (input.process && !input.prompt) delete merged.prompt;
  if (input.prompt && !input.process) delete merged.process;
  return { ...merged, id: existing.id, meta: { ...existing.meta } };
}

// An operator pause leaves next_run_at in place; a schedule that ran out
// (a fired one-off) is disabled with next_run_at cleared. Only the former is
// a choice that re-registering must respect.
export function isOperatorPaused(state) {
  return state?.enabled === false && Boolean(state?.next_run_at);
}

// Held paths: a once-job's enabled:false means it fired (its slot is the hold), never an operator pause,
// whatever writer left a stale next_run_at on it.
export const isHeldJobPaused = (job) =>
  job.schedule?.type !== "once" && isOperatorPaused(job.state);

const isOnce = (schedule) => JSON.parse(schedule || "null")?.type === "once";

// Fired wins (fgp.66/.67): a run that fired a once-slot leaves a job whose current schedule is still once fired
// (enabled false, next null), whatever an edit during the run wrote; no re-arm is inferred mid-run. A job whose
// schedule was replaced by a recurring/interval one keeps its own enabled/next_run_at. Returns false when the
// run (`run_schedule`, `run_slot`) fired no once-slot (the caller's own path applies). Shared by every once-run
// finalize and outcome writer.
export function settleFiredOnceRun(
  job,
  { run_schedule: runSchedule, run_slot: runSlot },
  path,
) {
  if (!runSlot || !isOnce(runSchedule)) return false;
  if (job.schedule?.type !== "once") return true;
  if (runSchedule !== stableStringify(job.schedule))
    process.stderr.write(
      `[helm held] ${JSON.stringify({ event: "finalize.rearm_dropped", status: "warn", job: job.id, slot: runSlot, path, guidance: "re-arm with tasks schedule --replace after the run ends" })}\n`,
    );
  job.state.enabled = false;
  job.state.next_run_at = null;
  return true;
}

// A patch that fired no slot (an idle end-of-tick batch entry) is stale against a once schedule changed since it
// was read: its enabled/next_run_at never overwrite the new definition.
export const staleOncePatch = (
  job,
  { run_schedule: runSchedule, run_slot: runSlot },
) =>
  !runSlot &&
  isOnce(runSchedule) &&
  runSchedule !== stableStringify(job.schedule);

// Re-registering a job redefines it; it does not reset what has happened to
// it. Run history and an operator pause carry over. The schedule position
// carries over too unless the schedule itself changed (or had run out), in
// which case the new definition's computed position applies. A caller that
// passes `state` explicitly (import/restore) gets exactly that state.
export function carryRuntimeState(
  existing,
  next,
  input,
  { merge = false } = {},
) {
  if (isPlainRecord(input?.state)) return next;
  const prior = existing.state || {};
  const paused = isOperatorPaused(prior);
  const exhausted = prior.enabled === false && !paused;
  const sameSchedule =
    stableStringify(existing.schedule) === stableStringify(next.schedule);
  const state = { ...next.state, ...prior };
  // --replace re-arms a fired one-off (re-registering it means "run it
  // again"). --merge is idempotent: the same definition leaves it fired.
  if (!sameSchedule || (exhausted && !merge)) {
    state.enabled = paused ? false : next.state.enabled;
    state.next_run_at = next.state.next_run_at;
    state.deferred_since = null;
    state.deferred_reason = null;
    state.held = null;
    state.infrastructure_deferred_slot = null;
    state.infrastructure_deferred_reason = null;
  }
  next.state = state;
  return next;
}
