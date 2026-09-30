// The one ownership-fact contract shared by registration and portable state.
// A tuple is either absent in full (no liveness evidence) or a complete
// runtime-hook observation bound to the endpoint generation that owns it.
//
// Item 42 C (2026-09-29): the tuple is LIVENESS evidence only. Nothing in
// Tightbeam signals an owner process any more — a live interactive owner
// keeps its session and only gets work enqueued; a gone owner is the proof
// that lets the daemon resume the session headlessly. Both built-in
// runtimes capture it from their installed hook (the hook's first
// non-shell ancestor is the runtime process that owns the transcript).

export const OWNER_PROCESS_FIELDS = Object.freeze([
  'owner_process_pid',
  'owner_process_start_identity',
  'owner_process_group_id',
  'owner_process_capture_source',
  'owner_process_generation',
]);

export const MAX_OWNER_START_IDENTITY_LENGTH = 256;
export const MAX_PROCESS_ID = 2_147_483_647;
export const CODEX_OWNER_CAPTURE_SOURCE = 'codex-hook';
export const CLAUDE_OWNER_CAPTURE_SOURCE = 'claude-hook';

// The capture source each stored runtime spelling may carry. 'claude' is
// the legacy stored alias of 'claude-code' (runtimes/builtins.mjs).
export const OWNER_CAPTURE_SOURCE_BY_RUNTIME = Object.freeze({
  codex: CODEX_OWNER_CAPTURE_SOURCE,
  'claude-code': CLAUDE_OWNER_CAPTURE_SOURCE,
  claude: CLAUDE_OWNER_CAPTURE_SOURCE,
});

export function ownerCaptureSourceForRuntime(runtime) {
  return Object.hasOwn(OWNER_CAPTURE_SOURCE_BY_RUNTIME, runtime) ? OWNER_CAPTURE_SOURCE_BY_RUNTIME[runtime] : null;
}

/**
 * The OS start identity as both sides compare it: `ps -o lstart=` under
 * LC_ALL=C, whitespace runs collapsed. The hook that captures and the
 * daemon that re-observes may run under different locales and column
 * padding, and a byte difference there must never read as a new process.
 */
export function normalizeStartIdentity(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

/**
 * Liveness of one recorded owner against one observation. The same PID
 * with the same start identity is the same process; an absent PID, or a PID
 * the OS has reused for a process that started at another instant, means
 * the recorded owner is gone. The process group is recorded for operators
 * but is not identity: a process may legitimately move groups, and a
 * non-detached child (a Subspace app-server) shares its parent's group.
 */
export function ownerProcessLiveness(row, observed) {
  if (observed?.unavailable) return 'unavailable';
  if (!observed) return 'gone';
  return observed.pid === row.owner_process_pid && normalizeStartIdentity(observed.startIdentity) === normalizeStartIdentity(row.owner_process_start_identity)
    ? 'alive'
    : 'gone';
}

function nullable(value) {
  return value === null || value === undefined;
}

export function ownerProcessTupleIsAbsent(row) {
  return OWNER_PROCESS_FIELDS.every((field) => nullable(row[field]));
}

export function ownerProcessTupleIsComplete(row) {
  return OWNER_PROCESS_FIELDS.every((field) => !nullable(row[field]));
}

export function ownerProcessTupleIssue(row, { runtime, processGeneration }) {
  if (ownerProcessTupleIsAbsent(row)) return null;
  if (!ownerProcessTupleIsComplete(row)) return 'owner process tuple must be all-null or complete';
  const expectedSource = ownerCaptureSourceForRuntime(runtime);
  if (expectedSource === null || row.owner_process_capture_source !== expectedSource) {
    return 'owner process tuple is not a supported runtime hook observation';
  }
  if (
    !Number.isInteger(row.owner_process_pid) || row.owner_process_pid < 1 || row.owner_process_pid > MAX_PROCESS_ID ||
    !Number.isInteger(row.owner_process_group_id) || row.owner_process_group_id < 1 || row.owner_process_group_id > MAX_PROCESS_ID ||
    typeof row.owner_process_start_identity !== 'string' || row.owner_process_start_identity.trim().length === 0 || row.owner_process_start_identity.length > MAX_OWNER_START_IDENTITY_LENGTH
  ) {
    return 'owner process tuple contains unsupported facts';
  }
  if (!Number.isInteger(row.owner_process_generation) || row.owner_process_generation < 1 || row.owner_process_generation !== processGeneration) {
    return 'owner_process_generation does not match process_generation';
  }
  return null;
}

export function sameOwnerProcessTuple(a, b) {
  return OWNER_PROCESS_FIELDS.every((field) => a[field] === b[field]);
}
