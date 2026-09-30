// Shared table schema, scoping, and canonical-hashing helpers for
// state.export / state.import (ws-10, docs/protocol.md "State movement";
// the product plan «Migration Plan» principles: bounded records, hashed
// manifest, atomic import, idempotent repeat, preserved original IDs, no
// secrets migrated). Not an op module itself — imported by
// src/daemon/ops/state_export.mjs and src/daemon/ops/state_import.mjs.
//
// ---------------------------------------------------------------------
// Decisions made where the docs are silent (reported per ws-10 brief):
//
// 1. Exported/imported tables: every table in schema.mjs EXCEPT the three
//    named in NON_EXPORTED_TABLES below, which records WHY each one stays
//    behind. The split is no longer maintained by hand alone:
//    findExportAllowlistDrift() compares this module against what the live
//    database reports (PRAGMA table_list / PRAGMA table_info), and
//    state.export refuses to emit a document when they disagree — a table
//    or column that is in neither list is a drift, not a decision.
//    `applications` IS included (see below) so FK integrity holds on
//    import (schema.mjs declares `principals.created_by_app_id` and
//    `messages.app_id` as literal SQL REFERENCES applications(id), and
//    PRAGMA foreign_keys = ON — src/daemon/db.mjs) and so the preserved
//    app_id (plan: "Preserve original IDs as namespaced provenance")
//    stays a live, usable identity on the target daemon — see (2).
//
// 2. Secret redaction: docs/protocol.md "Diagnostics rule" states
//    state.export "never includes secret_hash, app_secret, or admin nonce
//    material". This module REMOVES the `secret_hash` key entirely from
//    every exported `applications` row (redactApplicationRow, below) —
//    not merely blanked, not a placeholder string, since even a marker
//    string living under the key name `secret_hash` still contains the
//    substring "secret"; omission is the strictest reading available.
//    state.import then mints a brand-new working secret per imported
//    application row before the actual INSERT, regardless of whether the
//    presented row had a secret_hash key at all — see
//    src/daemon/ops/state_import.mjs's mintFreshApplicationSecrets() for
//    the full rationale (in short: leaving the row permanently
//    unauthenticatable would strand every imported principal's inbox,
//    since read_inbox — ws-7 — gates on `created_by_app_id ===
//    connection.appId`, and the preserved app_id, per (1), is meant to
//    keep working, not just exist as inert history). The original secret
//    itself never crosses the export/import boundary at any point — the
//    minted replacement is generated fresh, on the target, by
//    state.import.
//
// 3. Import into a non-empty database: docs/protocol.md is silent.
//    state.import always runs its INSERTs as plain INSERT (never INSERT
//    OR REPLACE) inside one transaction. A genuinely new import into an
//    empty (or disjoint) database succeeds normally; an import whose rows
//    collide on a primary key with existing, differently-sourced state
//    hits a UNIQUE constraint violation, which the transaction rolls back
//    whole and which src/daemon/ops/state_import.mjs reports as
//    migration_incompatible — i.e. "fail closed unless the import is
//    identical-idempotent" (the identical-idempotent case is detected
//    earlier, by content_hash, and never reaches the INSERT phase at
//    all).

import { createHash } from 'node:crypto';
import { validateStoredChannelRouteDescriptor } from './channel_route_contract.mjs';
import { ownerProcessTupleIsAbsent, ownerProcessTupleIssue, sameOwnerProcessTuple } from './owner_process_contract.mjs';

// The tables a state movement deliberately leaves behind, each with the
// reason it stays. This is the OTHER half of the export allowlist: a table
// that appears in neither this set nor TABLE_ORDER is an omission nobody
// decided, and findExportAllowlistDrift() (below) refuses to let it pass as
// one. Silencing a new table by listing it here is a recorded decision with
// a name attached; forgetting it is not possible.
export const NON_EXPORTED_TABLES = Object.freeze({
  claims:
    'bounded dispatch/resume leases held by one specific live client process; a lease has no meaning once replayed into a different daemon, and re-claiming is exactly what a resumed consumer does anyway',
  schema_migrations:
    "this daemon's own forward-migration bookkeeping for THIS state root, not migrated application content; the target root records its own",
  import_manifests:
    "the target root's own import provenance and idempotency ledger; carrying a source root's manifests would make the target claim imports it never applied",
});

// Insertion order matters: every REFERENCES target must be inserted
// before the row(s) that reference it (PRAGMA foreign_keys = ON). The
// lifecycle cutover (schema 7) made this order matter in a new way:
// `deliveries.source_obligation_id` now references obligations, so the
// forward graph is inserted BEFORE deliveries (the reverse of the legacy
// layout, where deliveries carried no obligation reference and
// obligations referenced nothing of them). `message_effects` (references
// messages + obligations) and `handoff_watches` (references obligations +
// deliveries) follow both of their targets.
export const TABLE_ORDER = Object.freeze([
  'applications',
  'application_permissions',
  'authorities',
  'principals',
  'endpoints',
  // Routes reference an application-owned principal and endpoint, and
  // messages/deliveries may attribute history to them.
  'channel_routes',
  'conversations',
  'conversation_participants',
  'messages',
  'obligations',
  'root_attention',
  // References applications + obligations, so it follows both.
  'lifecycle_commands',
  'deliveries',
  'message_effects',
  'handoff_watches',
  'resume_requests',
  // Schema 15's reply authority is portable only as durable records and
  // token digests. These follow every FK target they name.
  'reply_bindings',
  'reply_binding_tokens',
  'reply_binding_events',
  'reply_waits',
  'listeners',
  'endpoint_retirements',
  'listener_presentations',
]);

// Column lists, verbatim from the tables the database actually reports
// (PRAGMA table_info) at the FORWARD schema (src/daemon/schema.mjs v1
// CREATE_STATEMENTS plus every later migration through the guarded
// lifecycle cutover). Verified against a real migrated database by
// test/unit/ops_state_migration.test.mjs's "TABLE_COLUMNS matches every
// real table exactly" case, because a list that lags the schema silently
// deletes columns on the ONE rollback path this product has (the state
// ownership contract: no down migration, only "whole-state-root copy
// before activation; restoring it restores the old daemon and old state
// as a unit"). The legacy obligation columns ended at schema 7 and are
// deliberately absent here: a document carrying them is not importable
// forward state (src/daemon/ops/state_import.mjs rejects pre-cutover
// exports outright). Order matches the real table order.
export const TABLE_COLUMNS = Object.freeze({
  applications: ['id', 'name', 'secret_hash', 'status', 'created_at', 'disabled_at'],
  application_permissions: ['app_id', 'permission', 'allowed_authorities', 'allowed_runtime_types', 'created_at'],
  authorities: ['name', 'description', 'created_at'],
  principals: ['id', 'authority_name', 'external_principal_ref', 'display_name', 'created_by_app_id', 'created_at'],
  endpoints: [
    'id',
    'principal_id',
    'authority_name',
    'provider_session_id',
    'state',
    'authority_reference',
    'created_by_app_id',
    'created_at',
    'updated_at',
    'closed_at',
    // Schema 2 appended these two, in this order (ALTER TABLE ADD COLUMN).
    'runtime',
    'launch_mode',
    // Schema 7 added the observed-process generation runtime adoption
    // stamps for exact custody fencing.
    'process_generation',
    // Schema 11 added the ownership-regime discriminator that fences a
    // zombie sibling launch's evidence beside the generation rule.
    'owner_epoch',
    // Schema 12 NAMES the regime: the launch token of the registration that
    // currently owns the row (NULL when its owner arrived without one).
    // Dropping it would move an endpoint whose supervised-death fence has
    // forgotten which launch owns it.
    'owner_launch_token',
    // Schema 18 records the minimal external owner identity the retirement
    // executor revalidates. NULL is an explicit "unverified" fact, not an
    // invitation for import or retirement to infer an owner.
    'owner_process_pid',
    'owner_process_start_identity',
    'owner_process_group_id',
    'owner_process_capture_source',
    'owner_process_generation',
    'tachyon_armed_process_generation',
    // Schema 24 records only forward Academy launcher ownership. NULL is
    // legacy direct-provider behavior and must remain portable.
    'academy_agent_name',
    // Schema 25 (item 42 C): the confirmed exit of the recorded owner of the
    // current generation — the proof that permits a headless resume of an
    // interactive session. It travels with the owner tuple it describes.
    'owner_process_exited_at',
  ],
  channel_routes: [
    'id',
    'app_id',
    'principal_id',
    'endpoint_id',
    'selector',
    'label',
    'capabilities',
    // Schema 14 added the retirement lifecycle: a retired route's selector
    // and endpoint claims stop counting toward the active-only unique
    // indexes, and retired_at records when.
    'state',
    'retired_at',
    'created_at',
    'updated_at',
  ],
  conversations: ['id', 'created_by_app_id', 'binding_kind', 'owner_principal_id', 'metadata', 'created_at', 'closed_at'],
  conversation_participants: ['conversation_id', 'principal_id', 'role', 'added_at'],
  messages: [
    'id',
    'conversation_id',
    'app_id',
    'sender_principal_id',
    'kind',
    'body',
    'metadata',
    'idempotency_key',
    'payload_hash',
    'created_at',
    // Schema 7 appended this (ALTER TABLE ADD COLUMN, NOT NULL DEFAULT
    // 'agent'): the author-origin axis stamped by grant path.
    'origin',
    // Schema 13 records the trusted channel route that supplied inbound
    // content; it is nullable but must survive a portability round-trip.
    'origin_channel_route_id',
    // Schema 16's immutable direct-parent edge is canonical message
    // causality, not adapter/provider threading state.
    'in_reply_to_message_id',
  ],
  deliveries: [
    'id',
    'message_id',
    'endpoint_id',
    'state',
    'read_at',
    'acknowledged_at',
    'created_at',
    'updated_at',
    // Schema 7 typed recovery routes; ordinary message routes leave both
    // NULL, so the pair always round-trips together or not at all.
    'route_reason',
    'source_obligation_id',
    // Schema 13 ties a normal delivery to its resolved route without
    // creating a parallel delivery state machine.
    'channel_route_id',
    // Schema 22 owns truthful notification/admission timing on the durable
    // delivery rather than on a transient listener presentation.
    'admission_opened_at',
    'admission_process_generation',
    'admission_provider_session_id',
    'admission_owner_epoch',
    'admission_owner_launch_token',
    'admitted_at',
    'retry_armed_at',
    'takeover_decided_at',
  ],
  // The forward canonical work graph only (schema 7 rebuild). Legacy
  // columns (kind/state/ack_state/durable satisfaction/registration keys/
  // parent_obligation_id tree facts) do not exist past the cutover.
  obligations: [
    'id',
    'conversation_id',
    'parent_id',
    'role',
    'status',
    'generation',
    'accountable_principal_id',
    'custodian_endpoint_id',
    'first_progress_message_id',
    'first_progress_at',
    'resolution',
    'resolution_message_id',
    'resolution_outcome',
    'resolution_reason',
    'resolution_source',
    'resolution_replacement_id',
    'created_at',
    'updated_at',
    // Schema 17 Gate A acknowledgement projection. ALTER TABLE appends
    // these columns after the pre-existing timestamps; historical rows
    // carry explicit NULLs rather than an inferred acknowledgement.
    'ack_due_at',
    'ack_message_id',
    'ack_delivery_id',
    'ack_accepted_at',
  ],
  message_effects: [
    'id',
    'message_id',
    'effect',
    'effect_payload',
    'obligation_id',
    'obligation_generation',
    'created_at',
  ],
  // Schema 9/10: the durable replay identity of every administrative command
  // that has no message row to hang a key on (recovery.retry,
  // recovery.switch, session.stop). This IS the idempotency of those
  // commands — a movement that dropped it would let an identical retried
  // command re-decide and re-mutate on the target, and consume the Stop
  // anti-wedge budget a second time.
  lifecycle_commands: [
    'id',
    'app_id',
    'operation',
    'idempotency_key',
    'payload_hash',
    'root_obligation_id',
    'result_payload',
    'created_at',
  ],
  // Schema 10 bounded Stop-block escape evidence: one row per blocked root
  // (work left open AND made visible, plus the anti-wedge counter).
  root_attention: [
    'root_obligation_id',
    'stop_block_count',
    'attention_source',
    'first_marked_at',
    'last_block_at',
    'updated_at',
  ],
  handoff_watches: [
    'id',
    'delegation_id',
    'state',
    'acceptance_deadline_at',
    'outcome',
    'parent_delivery_id',
    'created_at',
    'updated_at',
    'closed_at',
  ],
  resume_requests: [
    'id',
    'endpoint_id',
    'principal_id',
    'session_id',
    'conversation_id',
    'message_id',
    'reason',
    'authority_reference',
    'state',
    'created_at',
    'updated_at',
    // Schema 17 controlled-replacement lineage. ALTER TABLE appends these
    // after the historical request facts; existing exact-resume records
    // intentionally retain NULLs for every new field.
    'recovery_mode',
    'replacement_for_request_id',
    'replacement_endpoint_id',
    'replacement_session_id',
    'replacement_admitted_at',
    'replacement_failure_reason',
    // Schema 21 binds an ordinary daemon recovery receipt to the exact
    // registered process/session that consumed it. All-null means no
    // provider-owned ordinary receipt was recorded.
    'admitted_at',
    'admitted_process_generation',
    'admitted_provider_session_id',
  ],
  reply_bindings: [
    'id',
    'app_id',
    'channel_route_id',
    'conversation_id',
    'source_message_id',
    'source_delivery_id',
    'target_endpoint_id',
    'source_provider_session_id',
    'source_process_generation',
    'created_at',
    'expires_at',
    'state',
    'retired_at',
    'retired_reason',
  ],
  // This table deliberately has a digest column and no token column. A
  // backup may preserve the validation material but cannot mint a usable
  // rpb_ capability by itself.
  reply_binding_tokens: ['token_digest', 'binding_id', 'issued_at', 'retired_at'],
  reply_binding_events: [
    'binding_id',
    'external_event_id',
    'payload_hash',
    'committed_message_id',
    'result_payload',
    'created_at',
    'updated_at',
  ],
  reply_waits: [
    'id',
    'binding_id',
    'endpoint_id',
    'provider_session_id',
    'process_generation',
    'state',
    'terminal_reason',
    'created_at',
    'updated_at',
    'closed_at',
  ],
  listeners: [
    'id',
    'reply_wait_id',
    'endpoint_id',
    'provider_session_id',
    'process_generation',
    'listener_generation',
    'state',
    'lease_expires_at',
    'park_deadline_at',
    'terminal_reason',
    'created_at',
    'updated_at',
    'ended_at',
  ],
  endpoint_retirements: [
    'id',
    'endpoint_id',
    'process_generation',
    'listener_id',
    'listener_generation',
    'state',
    'cause',
    'owner_process_pid',
    'owner_process_start_identity',
    'owner_process_group_id',
    'owner_process_capture_source',
    'owner_process_generation',
    'failure_reason',
    'confirmed_exit_at',
    'confirmed_exit_reason',
    'created_at',
    'updated_at',
    'closed_at',
    // Schema 20 appends admission-time custody fences after the original
    // retirement record.  They must stay in physical SQLite order.
    'owner_epoch',
    'owner_launch_token',
    'provider_session_id',
  ],
  listener_presentations: [
    'id',
    'listener_id',
    'listener_generation',
    'message_id',
    'target_delivery_id',
    'state',
    'ack_deadline_at',
    'acked_at',
    'missed_at',
    'fallback_resume_request_id',
    'fallback_reason',
    'created_at',
    'updated_at',
    // Schema 18 appends these presentation facts after the historical
    // timestamps, matching SQLite's ALTER TABLE column order.
    'reply_wait_id',
    'staged_at',
    'admitted_at',
  ],
});

// Sort key used both for deterministic hashing and for readable exports.
const TABLE_SORT_KEY = Object.freeze({
  applications: (r) => r.id,
  application_permissions: (r) => `${r.app_id}\u0000${r.permission}`,
  authorities: (r) => r.name,
  principals: (r) => r.id,
  endpoints: (r) => r.id,
  channel_routes: (r) => r.id,
  conversations: (r) => r.id,
  conversation_participants: (r) => `${r.conversation_id}\u0000${r.principal_id}`,
  messages: (r) => r.id,
  deliveries: (r) => r.id,
  obligations: (r) => r.id,
  root_attention: (r) => r.root_obligation_id,
  lifecycle_commands: (r) => r.id,
  resume_requests: (r) => r.id,
  reply_bindings: (r) => r.id,
  reply_binding_tokens: (r) => r.token_digest,
  reply_binding_events: (r) => `${r.binding_id}\u0000${r.external_event_id}`,
  reply_waits: (r) => r.id,
  listeners: (r) => r.id,
  endpoint_retirements: (r) => r.id,
  listener_presentations: (r) => r.id,
});

/**
 * The export allowlist versus the database itself: every real table must be
 * either exported (TABLE_ORDER + TABLE_COLUMNS) or recorded as deliberately
 * excluded (NON_EXPORTED_TABLES), and every exported table's declared
 * columns must be exactly the columns the table actually has, in order.
 *
 * This exists because both halves of the allowlist are hand-written, and
 * the ONE path where a stale list does damage is invisible: a document that
 * silently omits a table or a column looks exactly like a complete one, and
 * the export IS the rollback (the state ownership contract has no down
 * migration, only export-then-import into a fresh root on the older
 * binary). Comparing against PRAGMA turns "somebody forgot" into a loud,
 * named failure at the moment the incomplete document would have been
 * produced.
 *
 * Returns a list of human-readable drift descriptions; empty means aligned.
 */
export function findExportAllowlistDrift(db) {
  const drift = [];

  const liveTables = db
    .prepare('PRAGMA table_list')
    .all()
    .filter((entry) => entry.schema === 'main' && entry.type === 'table' && !entry.name.startsWith('sqlite_'))
    .map((entry) => entry.name);
  const liveTableSet = new Set(liveTables);

  for (const table of liveTables) {
    if (TABLE_COLUMNS[table] || table in NON_EXPORTED_TABLES) continue;
    drift.push(
      `table "${table}" exists in the schema but is neither exported (TABLE_ORDER/TABLE_COLUMNS) nor recorded in NON_EXPORTED_TABLES; ` +
        'add it to the export or record why it stays behind',
    );
  }

  for (const table of TABLE_ORDER) {
    if (!TABLE_COLUMNS[table]) {
      drift.push(`table "${table}" is in TABLE_ORDER but declares no columns in TABLE_COLUMNS`);
      continue;
    }
    if (!liveTableSet.has(table)) {
      drift.push(`table "${table}" is exported but no longer exists in the schema`);
      continue;
    }
    const actual = db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
    const declared = TABLE_COLUMNS[table];
    const missing = actual.filter((name) => !declared.includes(name));
    const unknown = declared.filter((name) => !actual.includes(name));
    if (missing.length > 0) {
      drift.push(`table "${table}" has column(s) the export would silently drop: ${missing.join(', ')}`);
    }
    if (unknown.length > 0) {
      drift.push(`table "${table}" declares column(s) the schema does not have: ${unknown.join(', ')}`);
    }
    if (missing.length === 0 && unknown.length === 0 && declared.join(',') !== actual.join(',')) {
      drift.push(`table "${table}" declares its columns in a different order than the schema reports`);
    }
  }

  for (const table of Object.keys(TABLE_COLUMNS)) {
    if (!TABLE_ORDER.includes(table)) drift.push(`table "${table}" declares columns but is missing from TABLE_ORDER, so it is never read or written`);
  }

  return drift;
}

/**
 * Redaction is by OMISSION, not a placeholder value: an exported
 * `applications` row simply has no `secret_hash` key at all. This is
 * stricter than a sentinel string ('REDACTED' would itself contain no
 * secret material, but the *column name* `secret_hash` does contain the
 * substring "secret" — docs/protocol.md "Diagnostics rule"'s requirement
 * is read here as "no secret material, full stop", so the safest
 * implementation removes the field rather than merely emptying it).
 * state.import always mints a fresh secret_hash for every imported
 * application row regardless of what (if anything) is present in the
 * incoming record — see src/daemon/ops/state_import.mjs
 * mintFreshApplicationSecrets() — so a missing key here never blocks
 * import (TABLE_COLUMNS' NOT NULL applications.secret_hash column is
 * always populated from the freshly minted value, never from the export
 * document).
 */
function redactApplicationRow(row) {
  const { secret_hash: _omitted, ...rest } = row;
  return rest;
}

/**
 * Reads every exportable table in full (no scoping applied yet).
 */
function fetchAllTables(db) {
  const all = {};
  for (const table of TABLE_ORDER) {
    const cols = TABLE_COLUMNS[table];
    all[table] = db.prepare(`SELECT ${cols.join(', ')} FROM ${table}`).all().map((row) => ({ ...row }));
  }
  return all;
}

/**
 * Restricts `all` (fetchAllTables' output) to the transitive closure of
 * everything reachable from appId: rows the app directly owns, plus
 * anything those rows reference (and anything that references them back
 * into scope), iterated to a fixed point so the returned subset is always
 * self-contained (never violates a REFERENCES constraint on import).
 *
 * F4 fix: ownership expansion (principals/conversations "owned by this
 * app_id") runs ONLY for the scoped `appId` itself. A foreign app_id
 * discovered incidentally — e.g. via a message written by a different
 * application into an in-scope conversation, or a principal referenced by
 * that message that a different application happens to own — is never fed
 * back into the ownership-expansion passes above; re-entering those passes
 * for a foreign app_id is exactly what pulled in that app's entire
 * unrelated principal/endpoint/message graph before this fix. Such a
 * foreign app is included in the output ONLY as its own (redacted)
 * `applications` row, and only when something already in scope actually
 * REFERENCES it (principals.created_by_app_id, messages.app_id — the two
 * columns schema.mjs declares as literal SQL REFERENCES applications(id)
 * — see this module's header note (1)); its application_permissions are
 * never exported for a foreign app.
 */
function scopeToApp(all, appId) {
  const includedPrincipalIds = new Set();
  const includedConversationIds = new Set();
  const includedMessageIds = new Set();
  const includedEndpointIds = new Set();

  let changed = true;
  while (changed) {
    changed = false;

    for (const p of all.principals) {
      if (p.created_by_app_id === appId && !includedPrincipalIds.has(p.id)) {
        includedPrincipalIds.add(p.id);
        changed = true;
      }
    }
    for (const c of all.conversations) {
      if (c.created_by_app_id === appId && !includedConversationIds.has(c.id)) {
        includedConversationIds.add(c.id);
        changed = true;
      }
    }
    for (const cp of all.conversation_participants) {
      if (includedPrincipalIds.has(cp.principal_id) && !includedConversationIds.has(cp.conversation_id)) {
        includedConversationIds.add(cp.conversation_id);
        changed = true;
      }
      if (includedConversationIds.has(cp.conversation_id) && !includedPrincipalIds.has(cp.principal_id)) {
        includedPrincipalIds.add(cp.principal_id);
        changed = true;
      }
    }
    for (const m of all.messages) {
      const relevant =
        m.app_id === appId || includedConversationIds.has(m.conversation_id) || includedPrincipalIds.has(m.sender_principal_id);
      if (relevant) {
        if (!includedMessageIds.has(m.id)) {
          includedMessageIds.add(m.id);
          changed = true;
        }
        if (!includedConversationIds.has(m.conversation_id)) {
          includedConversationIds.add(m.conversation_id);
          changed = true;
        }
        if (!includedPrincipalIds.has(m.sender_principal_id)) {
          includedPrincipalIds.add(m.sender_principal_id);
          changed = true;
        }
      }
    }
    for (const e of all.endpoints) {
      if (includedPrincipalIds.has(e.principal_id) && !includedEndpointIds.has(e.id)) {
        includedEndpointIds.add(e.id);
        changed = true;
      }
    }
  }

  // FK integrity only (see this function's header note): the specific
  // foreign applications rows that included principals/messages actually
  // reference, and nothing more.
  const referencedForeignAppIds = new Set();
  for (const p of all.principals) {
    if (includedPrincipalIds.has(p.id) && p.created_by_app_id !== appId) referencedForeignAppIds.add(p.created_by_app_id);
  }
  for (const m of all.messages) {
    if (includedMessageIds.has(m.id) && m.app_id !== appId) referencedForeignAppIds.add(m.app_id);
  }

  // Forward-schema closure over the canonical work graph. An obligation's
  // live references are its conversation, accountable principal,
  // custodian endpoint, first-progress message, resolution message,
  // parent, and superseded replacement. Requiring the whole reference set
  // (rather than widening the closure until it holds) keeps an
  // out-of-scope endpoint or message from dragging its principal, thread,
  // and messages along with it — a leak wearing a foreign key's clothes.
  // An obligation whose references are not all inside this scope belongs
  // to another application's session and stays out.
  const obligationReferencesInScope = (o) =>
    includedConversationIds.has(o.conversation_id) &&
    includedPrincipalIds.has(o.accountable_principal_id) &&
    (!o.custodian_endpoint_id || includedEndpointIds.has(o.custodian_endpoint_id)) &&
    [o.first_progress_message_id, o.resolution_message_id].every((id) => !id || includedMessageIds.has(id));
  const eligibleObligations = all.obligations.filter(
    (o) =>
      (includedConversationIds.has(o.conversation_id) ||
        includedMessageIds.has(o.first_progress_message_id) ||
        includedMessageIds.has(o.resolution_message_id)) &&
      obligationReferencesInScope(o),
  );
  const eligibleObligationIds = new Set(eligibleObligations.map((o) => o.id));
  // A scoped tree is valid only when every emitted child carries its
  // immediate parent. Start from eligible roots and add children once the
  // parent row is already included; this preserves self-FK integrity without
  // using a visible parent to pull foreign child references into scope.
  const includedObligationIds = new Set(eligibleObligations.filter((o) => !o.parent_id).map((o) => o.id));
  let addedObligation = true;
  while (addedObligation) {
    addedObligation = false;
    for (const obligation of eligibleObligations) {
      if (
        !includedObligationIds.has(obligation.id) &&
        obligation.parent_id &&
        eligibleObligationIds.has(obligation.parent_id) &&
        includedObligationIds.has(obligation.parent_id)
      ) {
        includedObligationIds.add(obligation.id);
        addedObligation = true;
      }
    }
  }
  // A delivery rides its message or endpoint, but a typed recovery route
  // may not outlive the obligation it names: emitting a delivery whose
  // source_obligation_id stayed outside the closure above would dangle its
  // REFERENCES on import and roll the whole import back. Same guard shape
  // as the effect filter above and the watch filter below. Computed after
  // the closure so it can consult it.
  const includedDeliveryIds = new Set(
    all.deliveries
      .filter(
        (d) =>
          (includedMessageIds.has(d.message_id) || includedEndpointIds.has(d.endpoint_id)) &&
          (!d.source_obligation_id || includedObligationIds.has(d.source_obligation_id)),
      )
      .map((d) => d.id),
  );
  // A route descriptor belongs with its owning app's scoped state, and
  // must also accompany any included message or delivery that attributes
  // history to it. Foreign route dependencies add only their exact
  // principal/endpoint/app records; they do not restart ownership expansion
  // and therefore cannot pull in that app's unrelated graph.
  const includedRouteIds = new Set(
    all.channel_routes
      .filter(
        (route) =>
          route.app_id === appId
          || all.messages.some((message) => includedMessageIds.has(message.id) && message.origin_channel_route_id === route.id)
          || all.deliveries.some((delivery) => includedDeliveryIds.has(delivery.id) && delivery.channel_route_id === route.id),
      )
      .map((route) => route.id),
  );
  const channelRoutes = all.channel_routes.filter((route) => includedRouteIds.has(route.id));
  for (const route of channelRoutes) {
    includedPrincipalIds.add(route.principal_id);
    includedEndpointIds.add(route.endpoint_id);
    if (route.app_id !== appId) referencedForeignAppIds.add(route.app_id);
  }
  for (const principal of all.principals) {
    if (includedPrincipalIds.has(principal.id) && principal.created_by_app_id !== appId) {
      referencedForeignAppIds.add(principal.created_by_app_id);
    }
  }
  // One effect per message: an effect is in scope when its message is and
  // the obligation it names (if any) survived the closure above.
  const messageEffects = all.message_effects.filter(
    (fx) => includedMessageIds.has(fx.message_id) && (!fx.obligation_id || includedObligationIds.has(fx.obligation_id)),
  );
  // A watch rides its delegation: include it only when the delegation is
  // in scope AND its immediate-parent delivery route (if one was ever
  // recorded) is too, so the import never dangles.
  const handoffWatches = all.handoff_watches.filter(
    (w) => includedObligationIds.has(w.delegation_id) && (!w.parent_delivery_id || includedDeliveryIds.has(w.parent_delivery_id)),
  );
  // An administrative command belongs to the app that issued it, and the
  // root it names (recovery does; a Stop does not) must have survived the
  // closure or the row would dangle on import. A foreign app's commands are
  // never exported, exactly like its application_permissions.
  const lifecycleCommands = all.lifecycle_commands.filter(
    (command) => command.app_id === appId && (!command.root_obligation_id || includedObligationIds.has(command.root_obligation_id)),
  );
  const includedResumeRequestIds = new Set(
    all.resume_requests.filter((r) => includedEndpointIds.has(r.endpoint_id) || includedConversationIds.has(r.conversation_id)).map((r) => r.id),
  );
  // A reply binding belongs to the authenticated route application. Its
  // source and target facts must travel as one self-contained graph; a
  // scoped export that omitted the binding would silently revoke an
  // otherwise valid provider mapping after import. Bindings owned by a
  // different application remain outside this app's export.
  const replyBindings = all.reply_bindings.filter(
    (binding) =>
      binding.app_id === appId &&
      includedRouteIds.has(binding.channel_route_id) &&
      includedConversationIds.has(binding.conversation_id) &&
      includedMessageIds.has(binding.source_message_id) &&
      includedDeliveryIds.has(binding.source_delivery_id) &&
      includedEndpointIds.has(binding.target_endpoint_id),
  );
  const includedBindingIds = new Set(replyBindings.map((binding) => binding.id));
  const replyBindingTokens = all.reply_binding_tokens.filter((token) => includedBindingIds.has(token.binding_id));
  const replyBindingEvents = all.reply_binding_events.filter(
    (event) => includedBindingIds.has(event.binding_id) && (!event.committed_message_id || includedMessageIds.has(event.committed_message_id)),
  );
  const replyWaits = all.reply_waits.filter(
    (wait) => includedBindingIds.has(wait.binding_id) && includedEndpointIds.has(wait.endpoint_id),
  );
  const includedReplyWaitIds = new Set(replyWaits.map((wait) => wait.id));
  const listeners = all.listeners.filter(
    (listener) =>
      includedEndpointIds.has(listener.endpoint_id) &&
      (!listener.reply_wait_id || includedReplyWaitIds.has(listener.reply_wait_id)),
  );
  const includedListenerIds = new Set(listeners.map((listener) => listener.id));
  const endpointRetirements = all.endpoint_retirements.filter(
    (retirement) =>
      includedEndpointIds.has(retirement.endpoint_id) &&
      includedListenerIds.has(retirement.listener_id),
  );
  const listenerPresentations = all.listener_presentations.filter(
    (presentation) =>
      includedListenerIds.has(presentation.listener_id) &&
      includedMessageIds.has(presentation.message_id) &&
      includedDeliveryIds.has(presentation.target_delivery_id) &&
      (!presentation.fallback_resume_request_id || includedResumeRequestIds.has(presentation.fallback_resume_request_id)),
  );

  return {
    applications: all.applications.filter((a) => a.id === appId || referencedForeignAppIds.has(a.id)).map(redactApplicationRow),
    application_permissions: all.application_permissions.filter((p) => p.app_id === appId),
    authorities: all.authorities, // shared reference data, not app-owned
    principals: all.principals.filter((p) => includedPrincipalIds.has(p.id)),
    endpoints: all.endpoints.filter((e) => includedEndpointIds.has(e.id)),
    channel_routes: channelRoutes,
    conversations: all.conversations.filter((c) => includedConversationIds.has(c.id)),
    conversation_participants: all.conversation_participants.filter((cp) => includedConversationIds.has(cp.conversation_id)),
    messages: all.messages.filter((m) => includedMessageIds.has(m.id)),
    deliveries: all.deliveries.filter((d) => includedDeliveryIds.has(d.id)),
    obligations: all.obligations.filter((o) => includedObligationIds.has(o.id)),
    // Attention evidence rides its root obligation like a watch rides its
    // delegation — an out-of-scope row would dangle its REFERENCES on import.
    root_attention: all.root_attention.filter((a) => includedObligationIds.has(a.root_obligation_id)),
    lifecycle_commands: lifecycleCommands,
    message_effects: messageEffects,
    handoff_watches: handoffWatches,
    resume_requests: all.resume_requests.filter((r) => includedResumeRequestIds.has(r.id)),
    reply_bindings: replyBindings,
    reply_binding_tokens: replyBindingTokens,
    reply_binding_events: replyBindingEvents,
    reply_waits: replyWaits,
    listeners,
    endpoint_retirements: endpointRetirements,
    listener_presentations: listenerPresentations,
  };
}

/**
 * Fetches the exportable record set. { appId: null | undefined } means a
 * full export (docs/protocol.md state.export: "scope optional; omitted
 * means a full export"); every `applications` row is always secret-redacted.
 */
export function fetchExportRecords(db, { appId } = {}) {
  const all = fetchAllTables(db);
  if (!appId) {
    return { ...all, applications: all.applications.map(redactApplicationRow) };
  }
  return scopeToApp(all, appId);
}

/**
 * Fills in any TABLE_ORDER key missing from `records` with an empty
 * array, so an import payload that omits an empty table hashes/compares
 * identically to an export that included it explicitly as [].
 */
export function normalizeRecords(records) {
  const source = records && typeof records === 'object' && !Array.isArray(records) ? records : {};
  const out = {};
  for (const table of TABLE_ORDER) out[table] = Array.isArray(source[table]) ? source[table] : source[table] ?? [];
  return out;
}

/**
 * A state import is self-contained provenance, not a patch against the
 * target database. A child may therefore name only a parent carried by
 * the same import; otherwise SQLite could resolve its self-FK against an
 * unrelated pre-existing target row and attach cross-provenance custody.
 */
export function findMissingObligationParent(records) {
  const obligations = records.obligations ?? [];
  const importedIds = new Set(obligations.map((row) => row.id));
  return obligations.find(
    (row) => row.parent_id !== undefined && row.parent_id !== null && !importedIds.has(row.parent_id),
  ) ?? null;
}

/**
 * Validates portable immutable message causality before INSERTs. SQLite's
 * self-FK protects a live database, but an import is an independent graph:
 * validate the complete document first so a child cannot attach to unrelated
 * target state, and so a cycle never depends on input-array ordering.
 */
export function findInvalidReplyCausality(records, { schemaVersion }) {
  const messages = records.messages ?? [];
  const byId = new Map(messages.map((row) => [row.id, row]));
  const parentById = new Map();

  for (const message of messages) {
    const hasParent = Object.hasOwn(message, 'in_reply_to_message_id');
    if (schemaVersion >= 16 && !hasParent) {
      return `message "${message.id}" omits required in_reply_to_message_id for schema ${schemaVersion}`;
    }
    const parentId = message.in_reply_to_message_id;
    if (parentId === undefined || parentId === null) continue;
    if (typeof parentId !== 'string' || parentId.length === 0) {
      return `message "${message.id}" has an invalid in_reply_to_message_id`;
    }
    if (parentId === message.id) {
      return `message "${message.id}" cannot name itself as in_reply_to_message_id`;
    }
    const parent = byId.get(parentId);
    if (!parent) {
      return `message "${message.id}" references parent "${parentId}" absent from the import`;
    }
    if (parent.conversation_id !== message.conversation_id) {
      return `message "${message.id}" parent is not in the same conversation`;
    }
    parentById.set(message.id, parentId);
  }

  const colors = new Map(); // 1 = active stack, 2 = complete
  for (const message of messages) {
    if (colors.get(message.id) === 2) continue;
    const stack = [{ id: message.id, complete: false }];
    while (stack.length > 0) {
      const frame = stack.pop();
      const color = colors.get(frame.id) ?? 0;
      if (frame.complete) {
        colors.set(frame.id, 2);
        continue;
      }
      if (color === 2) continue;
      if (color === 1) return `message causality contains a parent cycle at "${frame.id}"`;
      colors.set(frame.id, 1);
      stack.push({ id: frame.id, complete: true });
      const parentId = parentById.get(frame.id);
      if (!parentId) continue;
      const parentColor = colors.get(parentId) ?? 0;
      if (parentColor === 1) return `message causality contains a parent cycle at "${parentId}"`;
      if (parentColor !== 2) stack.push({ id: parentId, complete: false });
    }
  }
  return null;
}

/**
 * Import records are normally protected by foreign keys, but a route's
 * application/principal/endpoint ownership relationship spans independent
 * keys. Validate that composite contract before inserts so an imported route
 * cannot gain authority that channel.route.register would refuse.
 */
export function findInvalidChannelRoute(records) {
  const applications = new Set((records.applications ?? []).map((row) => row.id));
  const principals = new Map((records.principals ?? []).map((row) => [row.id, row]));
  const endpoints = new Map((records.endpoints ?? []).map((row) => [row.id, row]));

  for (const route of records.channel_routes ?? []) {
    const descriptor = validateStoredChannelRouteDescriptor(route);
    if (!descriptor.ok) {
      return `channel route "${route.id}" has invalid ${descriptor.field}: ${descriptor.message}`;
    }
    const principal = principals.get(route.principal_id);
    const endpoint = endpoints.get(route.endpoint_id);
    if (!applications.has(route.app_id) || !principal || !endpoint) {
      return `channel route "${route.id}" references an application, principal, or endpoint absent from the import`;
    }
    if (principal.created_by_app_id !== route.app_id) {
      return `channel route "${route.id}" app_id does not own its principal_id`;
    }
    if (endpoint.created_by_app_id !== route.app_id) {
      return `channel route "${route.id}" app_id does not own its endpoint_id`;
    }
    if (endpoint.principal_id !== route.principal_id) {
      return `channel route "${route.id}" endpoint_id does not belong to principal_id`;
    }
  }
  return null;
}

/**
 * A reply binding is a durable authority relation, not merely a collection
 * of individually valid foreign keys. State import must preserve the same
 * authenticated-route and delivery lineage checks that issuance relies on,
 * otherwise a hash-valid admin document could reattach a route application
 * to another application's delivery.
 */
export function findInvalidReplyBinding(records) {
  const routes = new Map((records.channel_routes ?? []).map((row) => [row.id, row]));
  const conversations = new Map((records.conversations ?? []).map((row) => [row.id, row]));
  const messages = new Map((records.messages ?? []).map((row) => [row.id, row]));
  const deliveries = new Map((records.deliveries ?? []).map((row) => [row.id, row]));
  const endpoints = new Map((records.endpoints ?? []).map((row) => [row.id, row]));
  const bindings = new Map((records.reply_bindings ?? []).map((row) => [row.id, row]));
  const replyWaits = new Map((records.reply_waits ?? []).map((row) => [row.id, row]));
  const listeners = new Map((records.listeners ?? []).map((row) => [row.id, row]));

  for (const binding of records.reply_bindings ?? []) {
    const route = routes.get(binding.channel_route_id);
    const conversation = conversations.get(binding.conversation_id);
    const sourceMessage = messages.get(binding.source_message_id);
    const sourceDelivery = deliveries.get(binding.source_delivery_id);
    const targetEndpoint = endpoints.get(binding.target_endpoint_id);
    if (!route || !conversation || !sourceMessage || !sourceDelivery || !targetEndpoint) {
      return `reply binding "${binding.id}" references a route, conversation, message, delivery, or endpoint absent from the import`;
    }
    if (route.app_id !== binding.app_id) {
      return `reply binding "${binding.id}" app_id does not own its channel_route_id`;
    }
    if (sourceMessage.conversation_id !== binding.conversation_id) {
      return `reply binding "${binding.id}" source_message_id is not in its conversation_id`;
    }
    if (sourceDelivery.message_id !== binding.source_message_id || sourceDelivery.channel_route_id !== binding.channel_route_id) {
      return `reply binding "${binding.id}" source_delivery_id does not match its source message and channel route`;
    }
    if (sourceDelivery.endpoint_id !== route.endpoint_id) {
      return `reply binding "${binding.id}" source_delivery_id does not target its channel route endpoint`;
    }
    if (targetEndpoint.principal_id !== sourceMessage.sender_principal_id) {
      return `reply binding "${binding.id}" target_endpoint_id does not belong to its source message sender`;
    }
  }

  for (const wait of records.reply_waits ?? []) {
    const binding = bindings.get(wait.binding_id);
    if (!binding) {
      return `reply wait "${wait.id}" references a reply binding absent from the import`;
    }
    if (wait.endpoint_id !== binding.target_endpoint_id) {
      return `reply wait "${wait.id}" endpoint_id does not match its reply binding target_endpoint_id`;
    }
  }

  for (const listener of records.listeners ?? []) {
    if (listener.reply_wait_id === null || listener.reply_wait_id === undefined) continue;
    const wait = replyWaits.get(listener.reply_wait_id);
    if (!wait) {
      return `listener "${listener.id}" references a reply wait absent from the import`;
    }
    if (listener.endpoint_id !== wait.endpoint_id) {
      return `listener "${listener.id}" endpoint_id does not match its reply wait endpoint_id`;
    }
  }

  for (const presentation of records.listener_presentations ?? []) {
    const listener = listeners.get(presentation.listener_id);
    const message = messages.get(presentation.message_id);
    const delivery = deliveries.get(presentation.target_delivery_id);
    if (!listener || !message || !delivery) {
      return `listener presentation "${presentation.id}" references a listener, message, or target delivery absent from the import`;
    }
    if (delivery.message_id !== message.id || delivery.endpoint_id !== listener.endpoint_id) {
      return `listener presentation "${presentation.id}" target delivery does not match its message and listener endpoint`;
    }
  }
  return null;
}

/**
 * Retirement is an exact endpoint/listener-generation handoff fact. SQLite
 * foreign keys prove that both rows exist, but cannot prove that they name
 * the same endpoint and generation; importing a mismatched pair would let a
 * later executor reason about the wrong live owner.
 */
export function findInvalidEndpointRetirement(records) {
  const endpoints = new Map((records.endpoints ?? []).map((row) => [row.id, row]));
  const listeners = new Map((records.listeners ?? []).map((row) => [row.id, row]));

  for (const endpoint of endpoints.values()) {
    const issue = ownerProcessTupleIssue(endpoint, { runtime: endpoint.runtime, processGeneration: endpoint.process_generation });
    if (issue) return `endpoint "${endpoint.id}" ${issue}`;
    // An exit proof describes exactly the owner tuple beside it; without
    // one it would authorize a headless resume nobody observed.
    const exitedAt = endpoint.owner_process_exited_at ?? null;
    if (exitedAt !== null && (typeof exitedAt !== 'string' || ownerProcessTupleIsAbsent(endpoint))) {
      return `endpoint "${endpoint.id}" records an owner exit without a complete owner process tuple`;
    }
  }

  for (const retirement of records.endpoint_retirements ?? []) {
    const endpoint = endpoints.get(retirement.endpoint_id);
    const listener = listeners.get(retirement.listener_id);
    if (!endpoint || !listener) {
      return `endpoint retirement "${retirement.id}" references an endpoint or listener absent from the import`;
    }
    if (
      listener.endpoint_id !== retirement.endpoint_id ||
      listener.process_generation !== retirement.process_generation ||
      listener.listener_generation !== retirement.listener_generation
    ) {
      return `endpoint retirement "${retirement.id}" does not match its endpoint and listener generation`;
    }
    const issue = ownerProcessTupleIssue(retirement, { runtime: endpoint.runtime, processGeneration: retirement.process_generation });
    // Both a pending retirement and a recorded termination can later
    // authorize successor eligibility. Failed/cancelled rows are history
    // only, so their all-null tuple remains an explicit no-authority fact.
    const isAuthorizing = retirement.state === 'pending' || retirement.state === 'terminated';
    if (issue || (isAuthorizing && ownerProcessTupleIsAbsent(retirement))) {
      return `endpoint retirement "${retirement.id}" ${issue ?? 'requires a complete owner process tuple while pending'}`;
    }
    if (
      isAuthorizing &&
      (retirement.owner_epoch !== endpoint.owner_epoch ||
        retirement.owner_launch_token !== endpoint.owner_launch_token ||
        retirement.provider_session_id !== endpoint.provider_session_id ||
        retirement.provider_session_id !== listener.provider_session_id)
    ) {
      return `endpoint retirement "${retirement.id}" admission custody snapshot does not match its endpoint and listener`;
    }
    if (!ownerProcessTupleIsAbsent(retirement) && !sameOwnerProcessTuple(retirement, endpoint)) {
      return `endpoint retirement "${retirement.id}" owner process tuple does not match its endpoint snapshot`;
    }
  }
  return null;
}

export function findInvalidAcademyAgentName(records, { schemaVersion }) {
  if (schemaVersion < 24) return null;
  for (const endpoint of records.endpoints ?? []) {
    const name = endpoint.academy_agent_name;
    if (name === null || name === undefined) continue;
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(name)) {
      return `endpoint "${endpoint.id}" has an invalid academy_agent_name`;
    }
  }
  return null;
}

/**
 * Schema 21's ordinary receipt tuple is authorization state, not a hint.
 * A partial tuple cannot be made safe by import defaults, and a tuple that
 * claims a future endpoint owner, or names a different owner at the current
 * generation would authorize a replay by the wrong process. An earlier
 * generation remains valid history after a later owner takes custody. Fully null remains valid historical/external completion
 * history; message.receive deliberately treats it as non-authorizing.
 */
export function findInvalidResumeAdmission(records, { schemaVersion }) {
  if (schemaVersion < 21) return null;
  const endpoints = new Map((records.endpoints ?? []).map((row) => [row.id, row]));
  for (const request of records.resume_requests ?? []) {
    const tuple = [request.admitted_at, request.admitted_process_generation, request.admitted_provider_session_id];
    if (tuple.every((value) => value === null || value === undefined)) continue;
    if (
      typeof request.admitted_at !== 'string' || request.admitted_at.length === 0 ||
      !Number.isSafeInteger(request.admitted_process_generation) || request.admitted_process_generation < 1 ||
      typeof request.admitted_provider_session_id !== 'string' || request.admitted_provider_session_id.length === 0
    ) {
      return `resume request "${request.id}" has a partial or invalid ordinary receipt admission tuple`;
    }
    const endpoint = endpoints.get(request.endpoint_id);
    if (
      request.state !== 'completed' || !endpoint ||
      !Number.isSafeInteger(endpoint.process_generation) ||
      request.admitted_process_generation > endpoint.process_generation ||
      (request.admitted_process_generation === endpoint.process_generation && endpoint.provider_session_id !== request.admitted_provider_session_id) ||
      (request.session_id !== null && request.session_id !== undefined && request.session_id !== request.admitted_provider_session_id)
    ) {
      return `resume request "${request.id}" ordinary receipt admission tuple does not match its completed endpoint owner`;
    }
  }
  return null;
}

/**
 * Schema 22's delivery row is the admission arbiter.  A window snapshots
 * the predecessor owner; a takeover advances the endpoint epoch/token and
 * must be represented by exactly one durable availability request.
 */
export function findInvalidDeliveryAdmission(records, { schemaVersion }) {
  if (schemaVersion < 22) return null;
  const endpoints = new Map((records.endpoints ?? []).map((row) => [row.id, row]));
  const requests = records.resume_requests ?? [];
  const takeovers = new Map();
  for (const request of requests) {
    if (request.reason !== 'availability_takeover') continue;
    const key = `${request.endpoint_id}\u0000${request.message_id}`;
    takeovers.set(key, [...(takeovers.get(key) ?? []), request]);
  }

  for (const delivery of records.deliveries ?? []) {
    const snapshot = [
      delivery.admission_opened_at,
      delivery.admission_process_generation,
      delivery.admission_provider_session_id,
      delivery.admission_owner_epoch,
      delivery.admission_owner_launch_token,
    ];
    const noSnapshot = snapshot.every((value) => value === null || value === undefined);
    if (noSnapshot) {
      if ([delivery.admitted_at, delivery.retry_armed_at, delivery.takeover_decided_at].some((value) => value !== null && value !== undefined)) {
        return `delivery "${delivery.id}" records admission timing without a predecessor snapshot`;
      }
      continue;
    }
    if (
      typeof delivery.admission_opened_at !== 'string' || delivery.admission_opened_at.length === 0 ||
      !Number.isSafeInteger(delivery.admission_process_generation) || delivery.admission_process_generation < 1 ||
      typeof delivery.admission_provider_session_id !== 'string' || delivery.admission_provider_session_id.length === 0 ||
      !Number.isSafeInteger(delivery.admission_owner_epoch) || delivery.admission_owner_epoch < 1 ||
      (delivery.admission_owner_launch_token !== null && delivery.admission_owner_launch_token !== undefined &&
        (typeof delivery.admission_owner_launch_token !== 'string' || delivery.admission_owner_launch_token.length === 0))
    ) {
      return `delivery "${delivery.id}" has a partial or invalid predecessor admission snapshot`;
    }
    const endpoint = endpoints.get(delivery.endpoint_id);
    if (!endpoint) return `delivery "${delivery.id}" references an endpoint absent from the import`;
    if (delivery.takeover_decided_at !== null && delivery.takeover_decided_at !== undefined) {
      const requestsForDelivery = takeovers.get(`${delivery.endpoint_id}\u0000${delivery.message_id}`) ?? [];
      if (requestsForDelivery.length !== 1) return `delivery "${delivery.id}" requires exactly one availability takeover request`;
      const request = requestsForDelivery[0];
      const pending = (
        endpoint.state !== 'takeover_pending' ||
        endpoint.process_generation !== delivery.admission_process_generation ||
        endpoint.provider_session_id !== delivery.admission_provider_session_id ||
        endpoint.owner_epoch !== delivery.admission_owner_epoch + 1 ||
        endpoint.owner_launch_token === delivery.admission_owner_launch_token ||
        delivery.read_at !== null && delivery.read_at !== undefined ||
        delivery.admitted_at !== null && delivery.admitted_at !== undefined
      );
      if (!pending) continue;
      // A token-bound SessionStart advances the same endpoint exactly once.
      // The request may be claimed, released for a retry after that child
      // exits, or completed by exact receipt; all are durable post-adoption
      // history, not a second takeover shape.
      const adopted = (
        ['idle', 'busy'].includes(endpoint.state) &&
        endpoint.process_generation === delivery.admission_process_generation + 1 &&
        endpoint.provider_session_id === delivery.admission_provider_session_id &&
        endpoint.owner_epoch === delivery.admission_owner_epoch + 1 &&
        endpoint.owner_launch_token !== delivery.admission_owner_launch_token &&
        ['pending', 'claimed', 'completed', 'failed'].includes(request.state) &&
        ((delivery.read_at === null || delivery.read_at === undefined) === (delivery.admitted_at === null || delivery.admitted_at === undefined))
      );
      if (!adopted) {
        return `delivery "${delivery.id}" takeover predecessor snapshot does not match its pending or post-adoption endpoint owner`;
      }
      continue;
    }
    // A still-unread timer can act only for the owner it originally named.
    if ((delivery.read_at === null || delivery.read_at === undefined) && (delivery.admitted_at === null || delivery.admitted_at === undefined) && (
      endpoint.state === 'takeover_pending' ||
      endpoint.process_generation !== delivery.admission_process_generation ||
      endpoint.provider_session_id !== delivery.admission_provider_session_id ||
      endpoint.owner_epoch !== delivery.admission_owner_epoch ||
      endpoint.owner_launch_token !== delivery.admission_owner_launch_token
    )) {
      return `delivery "${delivery.id}" predecessor admission snapshot does not match its endpoint owner`;
    }
  }

  for (const endpoint of endpoints.values()) {
    if (endpoint.state !== 'takeover_pending') continue;
    const pending = (records.deliveries ?? []).filter((delivery) => delivery.endpoint_id === endpoint.id && delivery.takeover_decided_at !== null && delivery.takeover_decided_at !== undefined);
    if (pending.length !== 1) return `endpoint "${endpoint.id}" is takeover_pending without exactly one decided delivery`;
  }
  return null;
}

/**
 * Deep-sorts object keys alphabetically and rows within each table by
 * TABLE_SORT_KEY, so two structurally-identical record sets always
 * serialize to byte-identical JSON regardless of query/array ordering.
 */
function canonicalizeRecords(records) {
  const canonical = {};
  for (const table of [...Object.keys(records)].sort()) {
    const keyFn = TABLE_SORT_KEY[table] ?? ((r) => JSON.stringify(sortedRow(r)));
    const rows = (records[table] ?? []).map(sortedRow).sort((a, b) => {
      const ka = keyFn(a);
      const kb = keyFn(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    canonical[table] = rows;
  }
  return canonical;
}

function sortedRow(row) {
  const sorted = {};
  for (const key of Object.keys(row).sort()) sorted[key] = row[key];
  return sorted;
}

/**
 * SHA-256 over the canonical serialization of `records`
 * (the product plan «Migration Plan»: "hashed manifest with ... content
 * hashes"). Used identically at export time (to fill manifest.content_hash)
 * and at import time (to verify the presented manifest against the
 * presented records before any write).
 */
export function computeContentHash(records) {
  const json = JSON.stringify(canonicalizeRecords(records));
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

/**
 * Structural validation of an import payload's `records`: every key must
 * be a known exportable table, every table value an array, every row a
 * plain object whose keys are exactly that table's known columns. Throws
 * TightbeamError('malformed_request', ...) via the `onError` callback
 * (kept caller-supplied so this module does not import protocol/envelope
 * error construction it does not otherwise need).
 */
export function validateRecordsShape(records, onError) {
  if (typeof records !== 'object' || records === null || Array.isArray(records)) {
    onError('records must be an object', 'records');
    return;
  }
  for (const table of Object.keys(records)) {
    if (!Object.hasOwn(TABLE_COLUMNS, table)) {
      onError(`unknown record table: ${table}`, `records.${table}`);
      continue;
    }
    if (!Array.isArray(records[table])) {
      onError(`records.${table} must be an array`, `records.${table}`);
      continue;
    }
    const cols = new Set(TABLE_COLUMNS[table]);
    for (const row of records[table]) {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) {
        onError(`records.${table} entries must be objects`, `records.${table}`);
        continue;
      }
      const keys = Object.keys(row);
      if (keys.length === 0) {
        onError(`records.${table} entries must name at least one column`, `records.${table}`);
        continue;
      }
      for (const key of keys) {
        if (!cols.has(key)) {
          onError(`unexpected column "${key}" in records.${table}`, `records.${table}.${key}`);
        }
      }
    }
  }
}

/**
 * Inserts every row of every table in `records`, in TABLE_ORDER (FK-safe
 * order). Caller is responsible for wrapping this in withTransaction —
 * this function performs no transaction control itself, so it composes
 * cleanly with the manifest-row insert that must commit atomically
 * alongside it (src/daemon/ops/state_import.mjs).
 *
 * A row is INSERTed naming only the columns it actually carries, so a
 * column the payload omits takes that column's own schema DEFAULT rather
 * than a forced NULL. Since the lifecycle cutover this serves forward
 * documents only — state_import rejects pre-cutover manifests outright —
 * but the mechanism stays: a forward row may legitimately omit a nullable
 * or defaulted column, and forcing NULL would turn that omission into a
 * raw "NOT NULL constraint failed" from inside the transaction.
 *
 * Returns { defaultedColumns } — per table, the columns some row left to
 * its schema default — so the caller can log what the payload did not
 * carry (src/daemon/ops/state_import.mjs).
 */
export function insertRecords(db, records) {
  const defaultedColumns = {};
  const deferredAckDeliveries = [];

  for (const table of TABLE_ORDER) {
    const rows = records[table] ?? [];
    if (rows.length === 0) continue;
    const cols = TABLE_COLUMNS[table];
    const statements = new Map();
    const defaulted = new Set();

    const rowsToInsert = table === 'obligations'
      ? orderObligationRows(rows).map((row) => {
          if (row.ack_delivery_id === null || row.ack_delivery_id === undefined) return row;
          deferredAckDeliveries.push({ obligation_id: row.id, delivery_id: row.ack_delivery_id });
          return { ...row, ack_delivery_id: null };
        })
      : table === 'messages'
        ? orderMessageRows(rows)
        : rows;
    for (const row of rowsToInsert) {
      const present = cols.filter((c) => row[c] !== undefined);
      if (present.length === 0) {
        // validateRecordsShape rejects an empty row before any write; this
        // keeps that invariant local rather than emitting `INSERT INTO t ()
        // VALUES ()`, which is not valid SQL.
        throw new Error(`records.${table} contains a row naming no known column`);
      }
      const signature = present.join(',');
      let stmt = statements.get(signature);
      if (!stmt) {
        stmt = db.prepare(`INSERT INTO ${table} (${present.join(', ')}) VALUES (${present.map(() => '?').join(', ')})`);
        statements.set(signature, stmt);
        for (const c of cols) if (row[c] === undefined) defaulted.add(c);
      }
      stmt.run(...present.map((c) => row[c]));
    }

    if (defaulted.size > 0) defaultedColumns[table] = [...defaulted];
  }
  const restoreAckDelivery = db.prepare('UPDATE obligations SET ack_delivery_id = ? WHERE id = ?');
  for (const deferred of deferredAckDeliveries) restoreAckDelivery.run(deferred.delivery_id, deferred.obligation_id);

  return { defaultedColumns };
}

function orderMessageRows(rows) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const childrenByParentId = new Map();
  const queue = [];
  for (const row of rows) {
    const parentId = row.in_reply_to_message_id;
    if (!parentId) {
      queue.push(row);
      continue;
    }
    if (!byId.has(parentId)) {
      // Leave a dangling row for SQLite's ordinary FK failure when this
      // helper is used outside state.import's pre-write validation.
      continue;
    }
    const children = childrenByParentId.get(parentId) ?? [];
    children.push(row);
    childrenByParentId.set(parentId, children);
  }
  const ordered = [];
  const inserted = new Set();
  for (let index = 0; index < queue.length; index += 1) {
    const row = queue[index];
    ordered.push(row);
    inserted.add(row.id);
    for (const child of childrenByParentId.get(row.id) ?? []) {
      queue.push(child);
    }
  }
  return [...ordered, ...rows.filter((row) => !inserted.has(row.id))];
}

function orderObligationRows(rows) {
  const remaining = rows.map((row) => ({ row }));
  const ordered = [];
  const inserted = new Set();

  let progressed = true;
  while (remaining.length > 0 && progressed) {
    progressed = false;
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      const { row } = remaining[index];
      // Both self-references gate emission: a child needs its parent, and
      // a superseded row needs the replacement it names.
      if ((!row.parent_id || inserted.has(row.parent_id)) && (!row.resolution_replacement_id || inserted.has(row.resolution_replacement_id))) {
        ordered.push(row);
        inserted.add(row.id);
        remaining.splice(index, 1);
        progressed = true;
      }
    }
  }

  // Keep malformed/orphan rows in the import stream. Their self-FK then
  // fails closed through the ordinary transaction/error envelope instead
  // of being silently discarded or treated as a new root.
  return [...ordered, ...remaining.map(({ row }) => row)];
}
