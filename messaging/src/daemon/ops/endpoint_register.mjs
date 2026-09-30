// endpoint.register — docs/protocol.md "Principal and endpoint lifecycle".
// Same authority/registration discipline as principal.register. Conflicting
// verified session facts (an already-bound (authority_name,
// provider_session_id) pair reasserted under a different principal,
// runtime, or authority_reference) fail closed with identity_conflict
// rather than silently overwriting the prior binding — adapted from
// tldr;'s thread_ownership.mjs fail-closed pattern
// (the behavior inventory §4), mediated through the structural unique
// index (the state ownership contract §3). Detected by catching the
// unique-constraint failure on insert, not by a pre-check-then-insert
// race.
//
// An identical reassertion of the same session by the application that
// registered it is a replay, not a conflict: it returns the existing
// endpoint_id and state with idempotent_replay: true, so a hook that fires
// twice for one session does not need to remember whether it already
// registered. `launch_mode` is the one field a replay may change — it is a
// per-start value (a session that started interactively and is later
// resumed with -p reports a different one), so a replay overwrites it
// instead of rejecting it. Because that makes a replay both a write and a
// disclosure, it runs under the same ownership and terminal-state guards as
// endpoint.state.set and endpoint.close rather than beside them. The one
// exception (item 42 C): a registration carrying a daemon launch token is
// the daemon's own headless resume, and never changes the recorded mode —
// resuming an interactive session in the background must not relabel it.
//
// `runtime` is the resume axis (claude-code, codex) and `authority_name`
// the trust axis; they are required to be stated separately because
// inferring one from the other is the conflation this operation used to
// force on every caller. The value is not checked against a runtime
// catalog here — an unknown runtime must fail loudly at resume time, not
// silently at registration.
//
// R3 «adoption». Case D(b) is an endpoint an application registered with
// NO provider_session_id: a target it knows about with no session behind
// it. A message to that principal writes its delivery row and its resume
// request against THAT placeholder row, and the daemon spawns a session.
// The spawned session must adopt this exact row before message.receive can
// bind its process/session receipt to the claimed request. resumeBrief
// deliberately carries no message body, so a sibling endpoint cannot
// receive the placeholder's delivery.
//
// A first registration therefore ADOPTS the placeholder the daemon
// spawned it for instead of inserting beside it. Adoption is a write on
// an existing row, so it runs inside the guard sequence (after the
// authority check and under the same ownership rule as the replay path)
// and only on a precise match — see ADOPTABLE_PLACEHOLDER.
//
// Adoption also refreshes the compatibility watermark from the delivery the
// placeholder holds. It never authorizes receipt; exact message.receive does.
//
// Process-generation lifecycle (Project Relay parent 4.1; plan
// «Technical Approach 5» "Increment it when a new or adopted runtime
// process owns the endpoint"): every seam where a runtime process takes
// ownership stamps `endpoints.process_generation`, and death evidence is
// fenced against that recording. A first registration with a session
// behind it stamps generation 1; a placeholder adoption stamps
// COALESCE(generation, 0) + 1; a re-registration arriving while the
// session records DEAD is a NEW process reviving a dead identity (the
// resume-after-death form) and advances the generation before returning
// idle — an old process's exit evidence names a lower generation and can
// never fail the revived custodian. A replay against a live (busy/idle)
// row is the same process re-asserting itself and moves nothing.
//
// Owner epoch (schema v11, the launch-collision repair): generation alone
// cannot separate two supervised launches of one endpoint made before
// either registered — both capture the same predicted next generation, so
// a zombie sibling's exit would pass the equality fence against whichever
// sibling actually stamped it. Every seam above therefore advances
// `endpoints.owner_epoch` alongside the generation (a sessionless
// placeholder inserts at 0; a session-backed first stamp inserts at 1),
// and the custody fence additionally requires evidence to name the epoch
// it was captured under. A NULL-generation row still has an epoch.
//
// Owner launch token (schema v12, the repair completed): the epoch alone
// fences the WINNING launch out of its own death too — both siblings
// captured the pre-registration epoch, so the launch that registered
// cannot name the epoch its own registration produced. `launch_token` is
// therefore an OPTIONAL registration field: the daemon mints one per
// launch and hands it to the child it starts (src/daemon/resumer.mjs
// childEnv), the child's hook forwards it here, and every seam above
// stamps it on the row it takes ownership of. The recorded token names
// the launch that owns the CURRENT regime, so each stamping seam writes
// it unconditionally — a session arriving without a token clears it
// rather than inheriting a superseded launch's identity. A live replay
// stamps nothing, token included: same process, same owner. The custody
// fence compares against this column with positive-staleness rules only
// (src/daemon/custody_reconciler.mjs): a launch that never re-stamped it
// still speaks for custody nobody else has taken.

import { TightbeamError } from '../../protocol/envelope.mjs';
import { generateId } from '../../protocol/ids.mjs';
import { withTransaction } from '../db.mjs';
import { authorityIsAllowed, isUniqueConstraintError } from './authority_scope.mjs';
import { refreshWatermarkForAdoptedSession } from './message_shared.mjs';
import { expandStoredRuntimeIds, runtimeContract, runtimeIdEquals } from './resume_shared.mjs';
import { MAX_OWNER_START_IDENTITY_LENGTH, MAX_PROCESS_ID, normalizeStartIdentity, ownerCaptureSourceForRuntime } from '../owner_process_contract.mjs';

const LAUNCH_MODES = new Set(['interactive', 'non_interactive']);

// The resumer mints 32 hex characters (src/daemon/resumer.mjs). The bound
// is generous enough for any future minting shape and still a bound.
const MAX_LAUNCH_TOKEN_LENGTH = 128;
function normalizeOwnerProcess(ownerProcess, storedRuntime, providerSessionId) {
  if (ownerProcess === undefined || ownerProcess === null) return null;
  if (!ownerProcess || typeof ownerProcess !== 'object' || Array.isArray(ownerProcess) || providerSessionId === null) {
    throw new TightbeamError('malformed_request', 'owner_process requires a session-backed complete proven owner snapshot', { field: 'owner_process' });
  }
  const fields = ['pid', 'start_identity', 'process_group_id', 'capture_source'];
  if (Object.keys(ownerProcess).length !== fields.length || Object.keys(ownerProcess).some((field) => !fields.includes(field))) {
    throw new TightbeamError('malformed_request', 'owner_process contains unsupported or partial facts', { field: 'owner_process' });
  }
  const expectedSource = ownerCaptureSourceForRuntime(storedRuntime);
  if (
    expectedSource === null ||
    ownerProcess.capture_source !== expectedSource ||
    !Number.isInteger(ownerProcess.pid) || ownerProcess.pid < 1 || ownerProcess.pid > MAX_PROCESS_ID ||
    !Number.isInteger(ownerProcess.process_group_id) || ownerProcess.process_group_id < 1 || ownerProcess.process_group_id > MAX_PROCESS_ID ||
    typeof ownerProcess.start_identity !== 'string' || ownerProcess.start_identity.trim().length === 0 || ownerProcess.start_identity.length > MAX_OWNER_START_IDENTITY_LENGTH
  ) {
    throw new TightbeamError('malformed_request', 'owner_process is not a complete supported runtime hook observation', { field: 'owner_process' });
  }
  return {
    pid: ownerProcess.pid,
    start_identity: normalizeStartIdentity(ownerProcess.start_identity),
    process_group_id: ownerProcess.process_group_id,
    capture_source: expectedSource,
  };
}

function sameOwnerProcess(endpoint, ownerProcess) {
  return (
    endpoint.owner_process_pid === ownerProcess.pid &&
    endpoint.owner_process_start_identity === ownerProcess.start_identity &&
    endpoint.owner_process_group_id === ownerProcess.process_group_id &&
    endpoint.owner_process_capture_source === ownerProcess.capture_source
  );
}

// The observed process generation, disclosed on every success path so the
// managed hooks can cache exactly what the row holds (hook_commands
// registerSession) and session.stop can fence the exact process. A
// registration response that omitted it would strand every later Stop:
// the hook would send a null generation against a stamped row and take
// obligation_conflict instead of a decision.
function generationOf(db, endpointId) {
  return db.prepare('SELECT process_generation FROM endpoints WHERE id = ?').get(endpointId)?.process_generation ?? null;
}

// SessionStart is replayable.  If it was interrupted after adopting the
// replacement placeholder but before the hook made recovery.retry, the
// same provider session must receive the same durable action identity on
// its next registration; otherwise a crash silently strands an actionable
// root without ever selecting a sibling.
function pendingRecoveryRequestForEndpoint(db, endpointId) {
  return (
    db
      .prepare(
        `SELECT replacement.id
           FROM resume_requests replacement
           JOIN resume_requests original ON original.id = replacement.replacement_for_request_id
           JOIN endpoints endpoint ON endpoint.id = replacement.endpoint_id
          WHERE replacement.endpoint_id = ?
            AND replacement.recovery_mode = 'replacement'
            AND replacement.state IN ('pending', 'claimed')
            AND original.recovery_mode = 'exact_resume'
            AND original.state = 'failed'
            AND original.replacement_endpoint_id = endpoint.id
            AND original.replacement_session_id = endpoint.provider_session_id
          ORDER BY replacement.created_at ASC, replacement.id ASC
          LIMIT 1`,
      )
      .get(endpointId)?.id ?? null
  );
}

// The one shape a first registration may adopt rather than insert beside.
// Every clause is an identity guard:
//   - principal/authority/runtime: the three axes that make this the same
//     endpoint at all; runtime is the resume axis, never a detail to
//     overwrite.
//   - provider_session_id IS NULL: only a placeholder is adoptable. A row
//     with a session id behind it is another live session.
//   - state not closed or retiring: terminal and retirement rows take no
//     write, adoption included.
//   - created_by_app_id: authority scope is not ownership — the same rule
//     the replay path enforces below.
//   - a non-terminal resume request: this is what ties adoption to "the
//     daemon actually spawned a session for this placeholder" rather than
//     to any sessionless row an application happens to keep.
// Oldest first, so the message that has waited longest is the one the new
// session can receive exactly.
//
// The runtime clause is parameterized over the CLAIMED runtime's whole
// stored-spelling class (expandStoredRuntimeIds), so a hook registering
// under the canonical id adopts placeholders persisted as legacy 'claude'
// rows — and vice versa — without rewriting either cell (plan W1
// «Canonical ids and legacy equivalence»).
const ADOPTABLE_PLACEHOLDER = `SELECT e.id AS id
     FROM endpoints e
    WHERE e.principal_id = ?
      AND e.authority_name = ?
      AND e.runtime IN (__RUNTIME_PLACEHOLDERS__)
      AND e.provider_session_id IS NULL
      AND e.state NOT IN ('closed', 'retiring', 'takeover_pending')
      AND e.created_by_app_id = ?
      AND EXISTS (SELECT 1 FROM resume_requests r WHERE r.endpoint_id = e.id AND r.state IN ('pending', 'claimed'))
    ORDER BY e.created_at ASC, e.id ASC`;

// Everything except launch_mode: a replay must match the prior binding on
// each of these or it is a conflicting claim (docs/security-model.md).
// The runtime field compares through the injected canonicalization
// contract (runtimeIdEquals), not exact string equality.
const IDENTITY_FIELDS = ['principal_id', 'authority_name', 'authority_reference', 'runtime'];

// The availability decision already owns the new epoch/token.  SessionStart
// is allowed to advance only the process generation under that durable
// decision; it must not look at process evidence or mint a second regime.
function adoptAvailabilityTakeover(db, { endpoint, providerSessionId, launchToken, ownerProcess, now }) {
  if (endpoint.state !== 'takeover_pending' || launchToken !== endpoint.owner_launch_token) return null;
  const request = db.prepare(
    `SELECT r.id, d.admission_process_generation
       FROM resume_requests r
       JOIN deliveries d ON d.endpoint_id = r.endpoint_id AND d.message_id = r.message_id
       JOIN claims c ON c.resource_type = 'resume_request' AND c.resource_id = r.id AND c.state = 'claimed'
      WHERE r.endpoint_id = ? AND r.message_id = d.message_id
        AND r.reason = 'availability_takeover' AND r.state = 'claimed'
        AND r.session_id = ?
        AND d.state != 'failed' AND d.read_at IS NULL AND d.admitted_at IS NULL
        AND d.takeover_decided_at IS NOT NULL
        AND d.admission_process_generation = ?
        AND d.admission_provider_session_id IS ?
        AND d.admission_owner_epoch = ? - 1
        AND d.admission_owner_launch_token IS NOT ?
        AND NOT EXISTS (
          SELECT 1 FROM listeners newer
           WHERE newer.endpoint_id = r.endpoint_id
             AND newer.process_generation > ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM deliveries earlier
           WHERE earlier.endpoint_id = d.endpoint_id AND earlier.state != 'failed'
             AND earlier.read_at IS NULL
             AND (earlier.created_at < d.created_at OR (earlier.created_at = d.created_at AND earlier.id < d.id))
        )
      ORDER BY r.created_at ASC, r.id ASC
      LIMIT 1`,
  ).get(endpoint.id, providerSessionId, endpoint.process_generation, providerSessionId, endpoint.owner_epoch, endpoint.owner_launch_token, endpoint.process_generation);
  if (!request) return null;
  const changed = db.prepare(
    `UPDATE endpoints
        SET state = 'idle', process_generation = process_generation + 1,
            launch_mode = 'non_interactive',
            owner_process_pid = ?, owner_process_start_identity = ?, owner_process_group_id = ?, owner_process_capture_source = ?,
            owner_process_generation = CASE WHEN ? IS NULL THEN NULL ELSE process_generation + 1 END,
            owner_process_exited_at = NULL,
            updated_at = ?
      WHERE id = ? AND state = 'takeover_pending' AND process_generation = ?
        AND provider_session_id IS ? AND owner_epoch = ? AND owner_launch_token = ?`,
  ).run(
    ownerProcess?.pid ?? null, ownerProcess?.start_identity ?? null, ownerProcess?.process_group_id ?? null, ownerProcess?.capture_source ?? null,
    ownerProcess?.pid ?? null, now, endpoint.id, endpoint.process_generation, providerSessionId, endpoint.owner_epoch, launchToken,
  );
  if (changed.changes !== 1) return null;
  return { endpointId: endpoint.id, processGeneration: endpoint.process_generation + 1, requestId: request.id };
}

function availabilityTakeoverReplay(db, { endpoint, providerSessionId, launchToken }) {
  if (endpoint.state !== 'idle' || launchToken !== endpoint.owner_launch_token) return null;
  return db.prepare(
    `SELECT r.id
       FROM resume_requests r
       JOIN deliveries d ON d.endpoint_id = r.endpoint_id AND d.message_id = r.message_id
      WHERE r.endpoint_id = ? AND r.reason = 'availability_takeover'
        AND r.session_id = ? AND d.takeover_decided_at IS NOT NULL
        AND d.admission_process_generation = ? - 1
        AND d.admission_provider_session_id IS ?
        AND d.admission_owner_epoch = ? - 1
        AND d.admission_owner_launch_token IS NOT ?
        AND ((r.state = 'claimed' AND EXISTS (
              SELECT 1 FROM claims c WHERE c.resource_type = 'resume_request' AND c.resource_id = r.id AND c.state = 'claimed'
            )) OR (r.state = 'completed' AND r.admitted_process_generation = ? AND r.admitted_provider_session_id IS ?))
      LIMIT 1`,
  ).get(endpoint.id, providerSessionId, endpoint.process_generation, providerSessionId, endpoint.owner_epoch, endpoint.owner_launch_token, endpoint.process_generation, providerSessionId);
}

export const endpointRegisterOp = {
  name: 'endpoint.register',
  allowedScopes: ['agent'],
  permission: 'register_endpoints',
  handler(context, payload, connection) {
    const authorityName = payload && payload.authority_name;
    const principalId = payload && payload.principal_id;
    if (typeof authorityName !== 'string' || authorityName.length === 0) {
      throw new TightbeamError('malformed_request', 'authority_name is required and must be a string', { field: 'authority_name' });
    }
    if (typeof principalId !== 'string' || principalId.length === 0) {
      throw new TightbeamError('malformed_request', 'principal_id is required and must be a string', { field: 'principal_id' });
    }
    for (const field of ['provider_session_id', 'authority_reference', 'launch_token', 'academy_agent_name']) {
      const value = payload[field];
      if (value !== undefined && value !== null && typeof value !== 'string') {
        throw new TightbeamError('malformed_request', `${field} must be a string when present`, { field });
      }
    }
    // A launch token is an opaque per-launch nonce the daemon minted, not
    // a caller-chosen identity: bound its length so a registration cannot
    // stamp an arbitrarily large blob into the ownership column.
    if (typeof payload.launch_token === 'string' && (payload.launch_token.length === 0 || payload.launch_token.length > MAX_LAUNCH_TOKEN_LENGTH)) {
      throw new TightbeamError('malformed_request', `launch_token must be 1 to ${MAX_LAUNCH_TOKEN_LENGTH} characters`, { field: 'launch_token' });
    }
    const runtime = payload && payload.runtime;
    if (typeof runtime !== 'string' || runtime.length === 0) {
      throw new TightbeamError('malformed_request', 'runtime is required and must be a string', { field: 'runtime' });
    }
    const launchMode = payload.launch_mode ?? null;
    if (launchMode !== null && !LAUNCH_MODES.has(launchMode)) {
      throw new TightbeamError('malformed_request', 'launch_mode must be "interactive" or "non_interactive" when present', {
        field: 'launch_mode',
      });
    }

    if (!authorityIsAllowed(connection, 'register_endpoints', authorityName)) {
      throw new TightbeamError('permission_denied', `register_endpoints is not granted for authority "${authorityName}"`);
    }

    // R5a: authority scope is not ownership — the rule endpoint.state.set,
    // endpoint.close, and the replay path below already state, and the one
    // FIRST registration used to skip. A same-authority application could
    // otherwise attach its own endpoint and working directory to another
    // application's principal, changing that principal's delivery fan-out
    // and creating resume work on its traffic.
    //
    // A foreign principal answers exactly as an unknown id does, so the
    // operation is not a principal-existence oracle either
    // (docs/security-model.md «Threat table», the same non-leaking rule
    // inbox.list and message.read apply).
    const principal = context.db.prepare('SELECT id, authority_name, created_by_app_id FROM principals WHERE id = ?').get(principalId);
    if (!principal || principal.created_by_app_id !== connection.appId) {
      throw new TightbeamError('malformed_request', `no principal registered with id "${principalId}"`, { field: 'principal_id' });
    }
    if (principal.authority_name !== authorityName) {
      throw new TightbeamError('malformed_request', 'principal_id does not belong to authority_name', { field: 'principal_id' });
    }

    const providerSessionId = payload.provider_session_id ?? null;
    const authorityReference = payload.authority_reference ?? null;
    const launchToken = payload.launch_token ?? null;
    const academyAgentName = payload.academy_agent_name ?? null;
    if (academyAgentName !== null && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(academyAgentName)) {
      throw new TightbeamError('malformed_request', 'academy_agent_name must be a valid Academy specialist name when present', { field: 'academy_agent_name' });
    }
    // The canonicalization contract is injected from the registry snapshot
    // on the context (plan W1 «Canonical ids and legacy equivalence»).
    // New rows store the CANONICAL id when the runtime is known; an
    // unknown runtime stores verbatim — registration stays catalog-free,
    // and it must fail loudly at resume time instead (header comment).
    const { canonicalize, acceptedStoredIds } = runtimeContract(context);
    const storedRuntime = canonicalize(runtime) ?? runtime;
    const ownerProcess = normalizeOwnerProcess(payload.owner_process, storedRuntime, providerSessionId);
    const initialState = providerSessionId === null ? 'dead' : 'idle';
    const endpointId = generateId('endpoint');
    const now = new Date().toISOString();

    let adopted = null;
    let candidateCount = 0;
    let watermarkDeliveryId = null;
    let recoveryResumeRequestId = null;
    // A takeover token is not a general launch credential.  Before the
    // ordinary insert path can run, fence a SessionStart that presents the
    // rotated token under any identity other than the durable takeover it
    // names; otherwise a wrong provider session could create a sibling row
    // without ever reaching the unique-session replay path below.
    if (launchToken) {
      const pendingTakeover = context.db.prepare(
        `SELECT e.id, e.principal_id, e.authority_name, e.provider_session_id, e.runtime, e.authority_reference, e.created_by_app_id
           FROM endpoints e
           JOIN resume_requests r ON r.endpoint_id = e.id AND r.reason = 'availability_takeover'
           JOIN deliveries d ON d.endpoint_id = e.id AND d.message_id = r.message_id
          WHERE e.owner_launch_token = ? AND d.takeover_decided_at IS NOT NULL
          LIMIT 1`,
      ).get(launchToken);
      if (pendingTakeover && (
        pendingTakeover.created_by_app_id !== connection.appId ||
        pendingTakeover.principal_id !== principalId ||
        pendingTakeover.authority_name !== authorityName ||
        pendingTakeover.provider_session_id !== providerSessionId ||
        pendingTakeover.authority_reference !== authorityReference ||
        !runtimeIdEquals(pendingTakeover.runtime, storedRuntime, canonicalize)
      )) {
        throw new TightbeamError('identity_conflict', 'launch_token is bound to a different pending availability takeover', { field: 'launch_token' });
      }
    }
    try {
      adopted = withTransaction(context.db, () => {
        // Adoption is attempted first and inside the same transaction as
        // the insert, so the choice between them is made against state no
        // other connection can move underneath it. The match spans the
        // claimed runtime's whole stored-spelling class: legacy alias rows
        // are adoptable by canonical sessions and never rewritten.
        const candidates =
          providerSessionId === null
            ? []
            : (() => {
                const storedSpellings = expandStoredRuntimeIds([storedRuntime], acceptedStoredIds);
                return context.db
                  .prepare(ADOPTABLE_PLACEHOLDER.replace('__RUNTIME_PLACEHOLDERS__', storedSpellings.map(() => '?').join(',')))
                  .all(principalId, authorityName, ...storedSpellings, connection.appId);
              })();
        candidateCount = candidates.length;
        if (candidates.length > 0) {
          // The UPDATE re-asserts the two clauses a concurrent writer
          // could have falsified between the SELECT and here; 0 rows
          // changed means it did, and this registration inserts instead.
          // A session id already bound elsewhere fails the partial unique
          // index here and lands in the identity_conflict path below,
          // exactly as an insert would.
          const changed = context.db
            .prepare(
              `UPDATE endpoints SET provider_session_id = ?, state = 'idle', launch_mode = ?, academy_agent_name = COALESCE(academy_agent_name, ?),
                    process_generation = COALESCE(process_generation, 0) + 1,
                    owner_epoch = owner_epoch + 1, owner_launch_token = ?,
                    owner_process_pid = ?, owner_process_start_identity = ?, owner_process_group_id = ?, owner_process_capture_source = ?,
                    owner_process_generation = CASE WHEN ? IS NULL THEN NULL ELSE COALESCE(process_generation, 0) + 1 END,
                    owner_process_exited_at = NULL, updated_at = ?
                WHERE id = ? AND provider_session_id IS NULL AND state NOT IN ('closed', 'retiring', 'takeover_pending')`,
            )
            .run(
              providerSessionId, launchMode, academyAgentName, launchToken,
              ownerProcess?.pid ?? null, ownerProcess?.start_identity ?? null, ownerProcess?.process_group_id ?? null, ownerProcess?.capture_source ?? null,
              ownerProcess?.pid ?? null, now, candidates[0].id,
            );
          if (changed.changes === 1) {
            // A controlled replacement is the one sessionless placeholder
            // that carries a replacement-mode request.  Bind the freshly
            // observed provider session to its already-failed exact-resume
            // predecessor in this same adoption transaction; a later
            // SessionStart can therefore ask only for the matching context.
            const replacement = context.db
              .prepare(
                `SELECT replacement.id, replacement.replacement_for_request_id
                   FROM resume_requests replacement
                   JOIN resume_requests original ON original.id = replacement.replacement_for_request_id
                  WHERE replacement.endpoint_id = ?
                    AND replacement.recovery_mode = 'replacement'
                    AND original.recovery_mode = 'exact_resume'
                    AND original.replacement_endpoint_id = ?
                    AND original.replacement_session_id IS NULL
                    AND original.state = 'failed'
                    AND replacement.state IN ('pending', 'claimed')
                  ORDER BY replacement.created_at ASC, replacement.id ASC
                  LIMIT 1`,
              )
              .get(candidates[0].id, candidates[0].id);
            if (replacement) {
              context.db
                .prepare('UPDATE resume_requests SET replacement_session_id = ?, replacement_admitted_at = ?, updated_at = ? WHERE id = ? AND replacement_session_id IS NULL')
                .run(providerSessionId, now, now, replacement.replacement_for_request_id);
              recoveryResumeRequestId = replacement.id;
            }
            // Adoption is the first moment a session id exists for this
            // durable row, so refresh its compatibility notification in the
            // same transaction. The marker never authorizes receipt and a
            // write failure never rolls back adoption.
            watermarkDeliveryId = refreshWatermarkForAdoptedSession(context.db, {
              stateRoot: context.stateRoot,
              endpointId: candidates[0].id,
              sessionId: providerSessionId,
              logger: context.logger,
            });
            return candidates[0].id;
          }
        }
        context.db
          .prepare(
            `INSERT INTO endpoints
              (id, principal_id, authority_name, provider_session_id, state, runtime, launch_mode, authority_reference, academy_agent_name, created_by_app_id, process_generation, owner_epoch, owner_launch_token,
               owner_process_pid, owner_process_start_identity, owner_process_group_id, owner_process_capture_source, owner_process_generation, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          // A session-backed first registration is a live runtime taking
          // ownership: generation 1 and epoch 1. A sessionless placeholder
          // has no observed process yet; adoption stamps its first
          // generation and advances the epoch off its insert baseline.
          // A sessionless placeholder is nobody's launch yet, so it carries
          // no owner token either; the adoption seam above stamps one.
          .run(
            endpointId, principalId, authorityName, providerSessionId, initialState, storedRuntime, launchMode, authorityReference, academyAgentName, connection.appId,
            providerSessionId === null ? null : 1, providerSessionId === null ? 0 : 1, providerSessionId === null ? null : launchToken,
            ownerProcess?.pid ?? null, ownerProcess?.start_identity ?? null, ownerProcess?.process_group_id ?? null, ownerProcess?.capture_source ?? null, ownerProcess ? 1 : null,
            now, now,
          );
        return null;
      });
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      const existing = context.db
        .prepare(
          `SELECT id, principal_id, authority_name, authority_reference, runtime, state, created_by_app_id, academy_agent_name,
                  process_generation, owner_epoch, owner_launch_token,
                  owner_process_pid, owner_process_start_identity, owner_process_group_id, owner_process_capture_source
             FROM endpoints WHERE authority_name = ? AND provider_session_id = ?`,
        )
        .get(authorityName, providerSessionId);
      // The replayed claim carries the canonical id a new row would store;
      // identity compares it to the STORED cell through the equivalence
      // contract, so re-asserting a legacy-spelled session under its
      // canonical spelling is a replay, not a conflict.
      const claim = { principal_id: principalId, authority_name: authorityName, authority_reference: authorityReference, runtime: storedRuntime };
      if (!existing || IDENTITY_FIELDS.some((field) => (field === 'runtime' ? !runtimeIdEquals(existing[field], claim[field], canonicalize) : existing[field] !== claim[field]))) {
        throw new TightbeamError(
          'identity_conflict',
          `endpoint (${authorityName}, ${providerSessionId}) is already registered under a different claim`,
          { field: 'provider_session_id' },
        );
      }
      // F3: two applications sharing the same authority scope must not be
      // able to modify each other's endpoints — authority scope alone is
      // not ownership. A replay is a write (launch_mode) and a disclosure
      // (endpoint_id, state), so it answers a foreign app exactly as
      // endpoint.state.set and endpoint.close do.
      if (existing.created_by_app_id !== connection.appId) {
        throw new TightbeamError('permission_denied', `register_endpoints is not granted for authority "${existing.authority_name}"`);
      }
      const takeover = withTransaction(context.db, () => adoptAvailabilityTakeover(context.db, {
        endpoint: existing,
        providerSessionId,
        launchToken,
        ownerProcess,
        now,
      }));
      if (takeover) {
        return {
          result: {
            endpoint_id: takeover.endpointId,
            state: 'idle',
            process_generation: takeover.processGeneration,
            idempotent_replay: false,
          },
        };
      }
      if (availabilityTakeoverReplay(context.db, { endpoint: existing, providerSessionId, launchToken })) {
        return {
          result: {
            endpoint_id: existing.id,
            state: 'idle',
            process_generation: existing.process_generation,
            idempotent_replay: true,
          },
        };
      }
      if (existing.state === 'takeover_pending') {
        throw new TightbeamError('identity_conflict', `endpoint (${authorityName}, ${providerSessionId}) has an unavailable takeover admission`, { field: 'launch_token' });
      }
      // A closed endpoint is terminal: the unique index carries no state
      // predicate, so the closed row still holds this (authority,
      // provider session) pair, and reasserting it conflicts with the
      // recorded terminal fact exactly as it does on endpoint.state.set.
      if (existing.state === 'closed') {
        throw new TightbeamError(
          'identity_conflict',
          `endpoint (${authorityName}, ${providerSessionId}) is closed; the session cannot be re-registered`,
          { field: 'provider_session_id' },
        );
      }
      let replayState = existing.state;
      if (existing.state === 'dead') {
        const superseded = context.db.prepare(
          `SELECT 1 FROM resume_requests
            WHERE endpoint_id = ? AND state = 'failed' AND recovery_mode = 'exact_resume'
              AND replacement_endpoint_id IS NOT NULL
            LIMIT 1`,
        ).get(existing.id);
        if (superseded) {
          throw new TightbeamError(
            'identity_conflict',
            `endpoint (${authorityName}, ${providerSessionId}) was superseded by controlled recovery and cannot revive`,
            { field: 'provider_session_id' },
          );
        }
        // A register arriving while the session records DEAD is a NEW
        // process reviving the identity (the resume-after-death form):
        // advance the generation so any older process's exit evidence
        // fences inert against the revived custody, and return the row to
        // idle. A live row's replay below stays write-free besides
        // launch_mode — that is the same process re-asserting itself.
        //
        // Item 42 C: a registration carrying a daemon launch token is the
        // daemon's own headless resume. It never changes the recorded
        // launch mode — the mode describes the SESSION, not this one
        // headless turn — so resuming an interactive session in the
        // background cannot relabel it non_interactive forever.
        context.db
          .prepare(
            `UPDATE endpoints SET state = 'idle', process_generation = COALESCE(process_generation, 0) + 1, owner_epoch = owner_epoch + 1, owner_launch_token = ?,
                 launch_mode = CASE WHEN ? IS NOT NULL THEN launch_mode ELSE COALESCE(?, launch_mode) END,
                 owner_process_pid = ?, owner_process_start_identity = ?, owner_process_group_id = ?, owner_process_capture_source = ?,
                 owner_process_generation = CASE WHEN ? IS NULL THEN NULL ELSE COALESCE(process_generation, 0) + 1 END,
                 owner_process_exited_at = NULL, updated_at = ? WHERE id = ? AND state = 'dead'`,
          )
          .run(
            launchToken, launchToken, launchMode,
            ownerProcess?.pid ?? null, ownerProcess?.start_identity ?? null, ownerProcess?.process_group_id ?? null, ownerProcess?.capture_source ?? null,
            ownerProcess?.pid ?? null, now, existing.id,
          );
        replayState = 'idle';
        context.logger?.info({
          event: 'endpoint_process_generation_advanced',
          endpoint_id: existing.id,
          provider_session_id: providerSessionId,
          params: { headless_daemon_launch: launchToken !== null, owner_process_recorded: ownerProcess !== null },
          result: 'revived_from_dead',
          status: 'ok',
        });
      } else if (
        ownerProcess !== null &&
        Number.isInteger(existing.process_generation) &&
        (existing.owner_process_pid === null || !sameOwnerProcess(existing, ownerProcess))
      ) {
        // Item 42 C: a DIFFERENT OS process registering a live session has
        // taken it over (a pane reopened on the same thread, a resumed
        // headless turn replaying against an idle row). Owner facts are
        // liveness evidence only — nothing signals an owner — so the newest
        // registrant is recorded as the live owner, bound to the current
        // generation, and any earlier exit proof is cleared. Recording the
        // older process instead would read its exit as the session's death
        // while this one is still running. The launch token follows the
        // owner for the same reason: it names the launch that owns the row.
        // A retiring row is released: a live owner just proved itself.
        const restamped = context.db
          .prepare(
            `UPDATE endpoints
                SET owner_process_pid = ?, owner_process_start_identity = ?, owner_process_group_id = ?, owner_process_capture_source = ?,
                    owner_process_generation = process_generation, owner_process_exited_at = NULL,
                    owner_launch_token = ?,
                    launch_mode = CASE WHEN ? IS NULL OR ? IS NOT NULL THEN launch_mode ELSE ? END,
                    state = CASE WHEN state = 'retiring' THEN 'idle' ELSE state END,
                    updated_at = ?
              WHERE id = ? AND process_generation = ? AND state IN ('idle', 'busy', 'retiring')`,
          )
          .run(
            ownerProcess.pid, ownerProcess.start_identity, ownerProcess.process_group_id, ownerProcess.capture_source,
            launchToken, launchMode, launchToken, launchMode, now, existing.id, existing.process_generation,
          ).changes === 1;
        if (restamped && existing.state === 'retiring') replayState = 'idle';
        context.logger?.info({
          event: 'endpoint_owner_process_restamped',
          endpoint_id: existing.id,
          params: {
            reason: existing.owner_process_pid === null ? 'owner_absent' : 'owner_changed',
            prior_state: existing.state,
            process_generation: existing.process_generation,
            headless_daemon_launch: launchToken !== null,
          },
          result: restamped ? 'restamped' : 'row_moved',
          status: 'ok',
        });
      } else if (launchMode !== null && launchToken === null) {
        context.db.prepare('UPDATE endpoints SET launch_mode = ?, updated_at = ? WHERE id = ?').run(launchMode, now, existing.id);
      }
      if (academyAgentName !== null) {
        context.db.prepare('UPDATE endpoints SET academy_agent_name = COALESCE(academy_agent_name, ?) WHERE id = ?').run(academyAgentName, existing.id);
      }
      const replayRecoveryRequestId = pendingRecoveryRequestForEndpoint(context.db, existing.id);
      return {
        result: {
          endpoint_id: existing.id,
          state: replayState,
          process_generation: generationOf(context.db, existing.id),
          idempotent_replay: true,
          ...(replayRecoveryRequestId ? { recovery_resume_request_id: replayRecoveryRequestId } : {}),
        },
      };
    }

    if (adopted !== null) {
      context.logger?.info({
        event: 'endpoint_placeholder_adopted',
        endpoint_id: adopted,
        principal_id: principalId,
        // The STORED spelling (canonicalized at insert), matching the row.
        runtime: storedRuntime,
        provider_session_id: providerSessionId,
        // More than one placeholder matched: the oldest was adopted and
        // the rest still hold their own delivery rows, which no session
        // is draining. Visible, never silent.
        candidates: candidateCount,
        // The delivery this session was started for, now pointed at by
        // its watermark. null means the placeholder held nothing unread,
        // which is the only case where the hook is right to stay quiet.
        watermark_delivery_id: watermarkDeliveryId,
      });
      // Not a replay: this is the first registration of THIS session. The
      // row it landed on is older than the session only because the
      // application named the target before a session existed.
      return {
        result: {
          endpoint_id: adopted,
          state: 'idle',
          process_generation: generationOf(context.db, adopted),
          idempotent_replay: false,
          ...(recoveryResumeRequestId ? { recovery_resume_request_id: recoveryResumeRequestId } : {}),
        },
      };
    }
    return {
      result: {
        endpoint_id: endpointId,
        state: initialState,
        process_generation: generationOf(context.db, endpointId),
        idempotent_replay: false,
      },
    };
  },
};
