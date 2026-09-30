// Runtime manifest persistence and snapshot activation (plan W1
// «Registration lifecycle»). This module owns the three things the pure
// registry leaf deliberately does not:
//
//   1. hashing and canonical serialization of manifest documents,
//   2. loading `<state-root>/runtimes/*.json` at startup — any invalid
//      file ABORTS startup with its path named (no skip-and-continue),
//   3. the registration transaction itself: validate → write mode-0600
//      temp → fsync → rename → THEN swap a freshly built frozen snapshot
//      onto `context.runtimeRegistry`. Persist-then-activate: a failed
//      write can never activate transient configuration, because the swap
//      happens only after the rename returned.
//
// Files follow the hook-app.json precedent (src/cli/hook_credentials.mjs):
// 0600 files inside the 0700 state root. No database involvement at all —
// registration adds no schema migration. Rollback for any registration is
// deleting its file.

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

import { TightbeamError } from '../protocol/envelope.mjs';
import { BUILTIN_RUNTIMES, CANONICAL_RUNTIME_IDS } from '../runtimes/builtins.mjs';
import {
  acceptedStoredIds,
  admitHookContract,
  canonicalizeRuntimeId,
  createRuntimeRegistry,
  parseRuntimeManifest,
} from '../runtimes/registry.mjs';

export const RUNTIME_MANIFEST_SUFFIX = '.json';

export function runtimeManifestPath(runtimesDir, id) {
  return path.join(runtimesDir, `${id}${RUNTIME_MANIFEST_SUFFIX}`);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalizeValue(value) {
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (isPlainObject(value)) {
    const out = {};
    // Sorted keys make the bytes independent of property insertion order,
    // so two clients sending the same document agree on one hash. The copy
    // must use defineProperty: plain `out[key] = …` for a key literally
    // named "__proto__" invokes the inherited accessor and the key would
    // VANISH before validation ever saw it — fail-open for exactly the
    // spelling an attacker would reach for.
    for (const key of Object.keys(value).sort()) {
      Object.defineProperty(out, key, {
        value: canonicalizeValue(value[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

/** Deterministic JSON text for a manifest document: sorted keys, no spaces. */
export function canonicalManifestJson(manifest) {
  return JSON.stringify(canonicalizeValue(manifest));
}

/** sha256 hex over the UTF-8 bytes of canonical manifest JSON text. */
export function hashCanonicalManifest(canonicalJson) {
  return createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}

function deepFreeze(value) {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze);
    return Object.freeze(value);
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    return Object.freeze(value);
  }
  return value;
}

function invalidPersistedManifest(file, why) {
  const error = new Error(`invalid persisted runtime manifest: "${file}" ${why}`);
  error.code = 'RUNTIME_MANIFEST_INVALID';
  return error;
}

/**
 * The first identity evidence `candidateIdentity` shares with any record in
 * `otherRecords` (env markers and transcript hints only — overlapping
 * sessionEnvVars are scoped chains and stay legal). Shared evidence makes
 * every affected session's hook fire resolve ambiguously, so the second
 * declaration is the config error. Returns { other, field, value } or null.
 */
function firstIdentityConflict(candidateId, candidateIdentity, otherRecords) {
  for (const other of otherRecords) {
    if (other.id === candidateId) continue;
    for (const field of ['envMarkers', 'transcriptHints']) {
      for (const value of candidateIdentity[field]) {
        if (other.identity[field].includes(value)) return { other, field, value };
      }
    }
  }
  return null;
}

/**
 * Loads every persisted manifest under runtimesDir through the same strict
 * parser registration uses, so a file that could not have been produced by
 * `runtime.register` never activates either. Returns frozen entries of
 * { id, record, manifest, hash, file }; a missing directory means no
 * registrations yet. Any unreadable, unparseable, out-of-bounds,
 * duplicate-id, or builtin-colliding file throws naming its full path —
 * daemon startup treats that as fatal.
 */
export function loadPersistedRuntimeEntries({ runtimesDir }) {
  let names;
  try {
    names = fs.readdirSync(runtimesDir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const files = names.filter((name) => name.endsWith(RUNTIME_MANIFEST_SUFFIX)).sort();
  const entries = [];
  const fileById = new Map();

  for (const name of files) {
    const file = path.join(runtimesDir, name);

    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw invalidPersistedManifest(file, `cannot be read (${err.code ?? err.message})`);
    }

    let document;
    try {
      document = JSON.parse(text);
    } catch {
      throw invalidPersistedManifest(file, 'is not valid JSON');
    }
    if (!isPlainObject(document)) {
      throw invalidPersistedManifest(file, 'must contain a JSON object');
    }

    const parsed = parseRuntimeManifest(canonicalManifestJson(document), {
      registeredCount: CANONICAL_RUNTIME_IDS.length + entries.length,
    });
    if (!parsed.ok) {
      throw invalidPersistedManifest(file, `was rejected by manifest validation (${parsed.code}): ${parsed.message}`);
    }
    if (canonicalizeRuntimeId(parsed.record.id) !== null) {
      throw invalidPersistedManifest(file, `declares id "${parsed.record.id}", which collides with the builtin/alias space`);
    }
    if (fileById.has(parsed.record.id)) {
      throw invalidPersistedManifest(file, `declares id "${parsed.record.id}" already loaded from "${fileById.get(parsed.record.id)}"`);
    }

    // The same two gates registration enforces, applied at startup: a
    // record that could not have been admitted must not activate just
    // because its file was hand-edited or predates the gate.
    const admission = admitHookContract(parsed.record);
    if (!admission.ok) {
      throw invalidPersistedManifest(file, `fails hook-contract admission (${admission.code}): ${admission.message}`);
    }
    // Bare "~" resolves onto the home directory itself; no settings merge
    // may target it. The same refusal registration makes (invalid_settings_path).
    if (parsed.record.hooksInstall.settingsPath === '~') {
      throw invalidPersistedManifest(file, 'declares hooksInstall.settingsPath "~", which resolves onto the home directory itself (invalid_settings_path)');
    }
    const identityConflict = firstIdentityConflict(parsed.record.id, parsed.record.identity, [
      ...Object.values(BUILTIN_RUNTIMES),
      ...entries.map((entry) => entry.record),
    ]);
    if (identityConflict !== null) {
      throw invalidPersistedManifest(
        file,
        `declares identity.${identityConflict.field} "${identityConflict.value}" already declared by runtime "${identityConflict.other.id}" (identity_marker_conflict)`,
      );
    }
    fileById.set(parsed.record.id, file);

    entries.push(
      Object.freeze({
        id: parsed.record.id,
        record: parsed.record,
        manifest: deepFreeze(JSON.parse(canonicalManifestJson(document))),
        hash: hashCanonicalManifest(canonicalManifestJson(document)),
        file,
      }),
    );
  }

  return Object.freeze(entries);
}

/**
 * A frozen merged snapshot: the leaf registry's builtin+manifest view plus
 * the persistence metadata (entries, runtimesDir) the registration op
 * compares replays against. Snapshots are immutable; activation replaces
 * the whole object reference on the daemon context.
 */
export function createRuntimeSnapshot({ stateRoot, runtimesDir, entries }) {
  const registry = createRuntimeRegistry({ stateRoot, manifestRecords: entries.map((entry) => entry.record) });
  return Object.freeze({
    stateRoot,
    runtimesDir,
    names: registry.names,
    list: registry.list,
    manifests: registry.manifests,
    get: registry.get,
    canonicalizeRuntimeId,
    acceptedStoredIds,
    /** Frozen persisted-entry metadata in load order. */
    entries: () => Object.freeze([...entries]),
  });
}

function persistCanonicalManifest({ runtimesDir, id, json, fsImpl }) {
  fsImpl.mkdirSync(runtimesDir, { recursive: true, mode: 0o700 });
  const finalPath = runtimeManifestPath(runtimesDir, id);
  // Dot-prefixed .tmp suffix: a crash between open and rename can leave
  // this behind without ever looking like a loadable manifest.
  const tempPath = path.join(runtimesDir, `.${id}.${randomBytes(8).toString('hex')}.tmp`);
  let fd = null;
  try {
    fd = fsImpl.openSync(tempPath, 'wx', 0o600);
    fsImpl.writeFileSync(fd, json);
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd);
    fd = null;
    // openSync's mode is umask-filtered; make owner-only explicit before
    // the name ever becomes the real one.
    fsImpl.chmodSync(tempPath, 0o600);
    fsImpl.renameSync(tempPath, finalPath);
  } catch (err) {
    if (fd !== null) {
      try {
        fsImpl.closeSync(fd);
      } catch {
        // best-effort cleanup on an already-failing path
      }
    }
    try {
      fsImpl.unlinkSync(tempPath);
    } catch {
      // ditto: the original error is the one worth surfacing
    }
    throw err;
  }
}

/**
 * One registration transaction against the live daemon context: revalidate
 * the manifest document exactly as a fresh client would have had it
 * parsed, reject collisions against the builtin/alias space, treat
 * same-id/same-hash as an idempotent replay, and otherwise persist first
 * and activate second by swapping a new frozen snapshot onto
 * `context.runtimeRegistry`. Returns { id, hash, replayed, file? }.
 *
 * `fsImpl` exists so tests can fail the rename at exactly the atomic step;
 * production callers take the default node:fs and no other seam exists.
 */
export function registerRuntimeManifest({ context, manifestObject, fsImpl = fs }) {
  if (!isPlainObject(manifestObject)) {
    throw new TightbeamError('malformed_request', 'manifest is required and must be a JSON object (the CLI sends the parsed document, never a path)', {
      field: 'manifest',
    });
  }
  const snapshot = context.runtimeRegistry;
  if (!snapshot || typeof snapshot.entries !== 'function') {
    throw new Error('registerRuntimeManifest requires context.runtimeRegistry to hold an activated runtime snapshot');
  }
  const runtimesDir = context.runtimesDir;

  const json = canonicalManifestJson(manifestObject);
  const hash = hashCanonicalManifest(json);
  const entries = snapshot.entries();

  // Revalidation uses the same bounds as parsing anywhere else, with the
  // live registry size wired through (builtins + currently activated).
  const parsed = parseRuntimeManifest(json, {
    registeredCount: CANONICAL_RUNTIME_IDS.length + entries.length,
  });
  if (!parsed.ok) {
    context.logger?.warn?.({ event: 'runtime_register_rejected', reason: parsed.code, field: parsed.field ?? null });
    throw new TightbeamError('malformed_request', parsed.message, { field: parsed.field ?? 'manifest', reason: parsed.code });
  }
  const id = parsed.record.id;

  // The hook contract is a gate at admission time, not just install time:
  // a record whose capabilities Tightbeam cannot honor must never persist,
  // or every later default `hooks install` on this host refuses rather
  // than write hooks that cannot do their job.
  const admission = admitHookContract(parsed.record);
  if (!admission.ok) {
    context.logger?.warn?.({ event: 'runtime_register_rejected', reason: admission.code, field: admission.field ?? null });
    throw new TightbeamError('malformed_request', admission.message, { field: admission.field ?? 'manifest', reason: admission.code });
  }
  // Bare "~" would resolve onto the home directory itself — an install
  // against such a record renames onto $HOME. Refuse it here, where parse's
  // shape rules cannot see it; the installer refuses it again at write time.
  if (parsed.record.hooksInstall.settingsPath === '~') {
    context.logger?.warn?.({ event: 'runtime_register_rejected', reason: 'invalid_settings_path', field: 'hooksInstall.settingsPath' });
    throw new TightbeamError(
      'malformed_request',
      'hooksInstall.settingsPath "~" resolves onto the home directory itself; declare an absolute or home-relative path',
      { field: 'hooksInstall.settingsPath', reason: 'invalid_settings_path' },
    );
  }

  // The alias space counts as owned: registering "claude" would shadow the
  // legacy spellings endpoint rows already carry.
  const ownedBy = canonicalizeRuntimeId(id);
  if (ownedBy !== null) {
    throw new TightbeamError('identity_conflict', `runtime id "${id}" collides with built-in runtime "${ownedBy}" and cannot be registered`, {
      field: 'id',
    });
  }

  const existing = entries.find((entry) => entry.id === id);
  if (existing) {
    if (existing.hash === hash) {
      // Deleting the file is the documented rollback, so a live entry whose
      // file went missing is a half-rolled-back runtime: active now, gone at
      // next restart. An identical re-registration restores the file instead
      // of answering replayed while the durable state disagrees.
      if (!fsImpl.existsSync(existing.file)) {
        try {
          persistCanonicalManifest({ runtimesDir, id, json, fsImpl });
        } catch (err) {
          context.logger?.error?.({
            event: 'runtime_register_restore_failed',
            params: { runtime_id: id },
            status: 'failed',
            message: err.message,
            code: err.code ?? null,
          });
          throw new TightbeamError('malformed_request', `failed to restore runtime manifest for "${id}": ${err.code ?? err.message}`, {
            field: 'manifest',
            reason: 'persist_failed',
          });
        }
        context.logger?.warn?.({ event: 'runtime_register_file_restored', params: { runtime_id: id }, status: 'restored' });
      }
      context.logger?.info?.({ event: 'runtime_register_replayed', params: { runtime_id: id }, status: 'replayed' });
      return { id, hash, replayed: true, file: existing.file };
    }
    throw new TightbeamError('identity_conflict', `runtime id "${id}" is already registered with different content (registered hash ${existing.hash})`, {
      field: 'id',
    });
  }

  // Identity evidence must stay unique across every record — builtins
  // included — or sessions carrying a shared marker resolve ambiguously on
  // EVERY hook fire. The second declaration is refused before persistence,
  // naming the evidence and both runtimes.
  const identityConflict = firstIdentityConflict(id, parsed.record.identity, snapshot.list());
  if (identityConflict !== null) {
    throw new TightbeamError(
      'malformed_request',
      `runtime "${id}" declares identity.${identityConflict.field} "${identityConflict.value}", already declared by runtime "${identityConflict.other.id}" ` +
        '(identity_marker_conflict): a session carrying that evidence could resolve as either runtime',
      { field: `identity.${identityConflict.field}`, reason: 'identity_marker_conflict' },
    );
  }

  // ---- past every rejection: persist, then activate -----------------------
  const file = runtimeManifestPath(runtimesDir, id);
  try {
    persistCanonicalManifest({ runtimesDir, id, json, fsImpl });
  } catch (err) {
    // Nothing has been swapped: the prior file and prior snapshot both stay
    // authoritative, which is the whole point of persist-then-activate.
    context.logger?.error?.({
      event: 'runtime_register_persist_failed',
      params: { runtime_id: id },
      status: 'failed',
      message: err.message,
      code: err.code ?? null,
    });
    throw new TightbeamError('malformed_request', `failed to persist runtime manifest for "${id}": ${err.code ?? err.message}`, {
      field: 'manifest',
      reason: 'persist_failed',
    });
  }

  const entry = Object.freeze({
    id,
    record: parsed.record,
    manifest: deepFreeze(JSON.parse(json)),
    hash,
    file,
  });
  context.runtimeRegistry = createRuntimeSnapshot({
    stateRoot: context.stateRoot,
    runtimesDir,
    entries: [...entries, entry],
  });

  context.logger?.info?.({
    event: 'runtime_registered',
    params: { runtime_id: id, resume_strategy: parsed.record.resumeStrategy },
    result: { hash },
    status: 'activated',
  });
  return { id, hash, replayed: false, file };
}
