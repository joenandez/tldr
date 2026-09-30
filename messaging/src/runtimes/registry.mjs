// The registry: the sole owner of runtime truth. Every consumer — resumer,
// endpoint/resume ops, hooks install, hook identity, bin dispatch, doctor,
// conformance — receives an instance from createRuntimeRegistry({ stateRoot })
// and reads runtime data only through it. There is deliberately no module
// singleton: tests using multiple state roots cannot contaminate each
// other, and CLI and daemon each pass their own stateRoot explicitly.
//
// Plan W1 «Layering (structural)»: a leaf shared layer importing no other
// source layer (the architecture contract §5). Task 1.4 retired
// src/daemon/runtime_table.mjs; since then this registry IS the executable
// truth, and its builtin records carry the Helm vectors verbatim
// (test/unit/runtimes_registry.test.mjs pins them against frozen goldens).
//
// Not implemented here, by design:
//   file persistence / hashing      -> src/daemon/runtime_store.mjs (task
//   1.3): this leaf stays filesystem-free; it only composes frozen merged
//   views from records handed to it.

import { BUILTIN_RUNTIMES, CANONICAL_RUNTIME_IDS, LEGACY_RUNTIME_ALIASES } from './builtins.mjs';

// ---------------------------------------------------------------------------
// Manifest v1 parsing (strict).
//
// A manifest is the public, admin-authorized way to add a runtime record.
// Parsing is pure and total: every input yields either a deeply frozen
// record or a named rejection, and no bound is enforced after persistence
// could begin — there is no persistence here at all. Every rejection reason
// has one stable machine-readable code in MANIFEST_ERROR_CODES; codes follow
// the repo's snake_case convention (src/protocol/envelope.mjs), which this
// leaf cannot import and so mirrors.
//
// All bounds live in MANIFEST_BOUNDS, in this one place. They exist because
// every daemon-strategy record widens a once-per-second SQL IN list
// (resumer.mjs runtimePlaceholders) and every hook identity scan —
// unbounded growth is a live cost (plan W1 «Bounds»).

export const MANIFEST_BOUNDS = Object.freeze({
  /** Raw UTF-8 bytes of manifest input, checked before JSON.parse. */
  maxInputBytes: 8192,
  /** Registered runtime records per registry (builtins + manifests); wired through parse options for task 1.3's registration op. */
  maxRegisteredRuntimes: 32,
  /** Elements per template array. */
  maxTemplateElements: 64,
  /** Characters per bounded string: ids excluded (maxIdLength), argv elements, command, settingsPath, format, identity entries. */
  maxStringLength: 256,
  /** Characters in a runtime id. */
  maxIdLength: 64,
  maxSessionEnvVars: 8,
  maxEnvMarkers: 16,
  maxTranscriptHints: 8,
  maxBlockExitCodes: 16,
});

export const MANIFEST_ERROR_CODES = Object.freeze([
  'malformed_json',
  'manifest_too_large',
  'registry_full',
  'unknown_field',
  'unsupported_contract_version',
  'unsafe_runtime_id',
  'invalid_resume_strategy',
  'missing_required_field',
  'external_strategy_field',
  'non_whole_element_slot',
  'template_element_limit',
  'string_length_limit',
  'array_length_limit',
  'duplicate_marker',
  'invalid_field',
]);

const TOP_LEVEL_FIELDS = new Set([
  'id',
  'contractVersion',
  'resumeStrategy',
  'command',
  'resumeArgsTemplate',
  'spawnArgsTemplate',
  'identity',
  'hooksInstall',
  'capabilities',
]);

// `origin`/`source` are deliberately absent: origin is loader-known internal
// metadata set by this function ('manifest', mirroring builtins' 'builtin'),
// never adapter-authored, never serialized onto the wire or into state.
const IDENTITY_FIELDS = new Set(['sessionEnvVars', 'envMarkers', 'transcriptHints']);
const HOOKS_INSTALL_FIELDS = new Set(['settingsPath', 'format']);
const CAPABILITY_FIELDS = new Set(['stdoutInjection', 'blockExitCodes']);

// Lowercase kebab: letter-led segments joined by single hyphens. The same
// shape every builtin id already satisfies.
const SAFE_RUNTIME_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Whether `id` is a safe runtime id: lowercase kebab-case, at most
 * MANIFEST_BOUNDS.maxIdLength characters, and not a name owned by
 * Object.prototype ('constructor', 'toString', …) — registries key records
 * by id, so a prototype-owned spelling would collide with property lookup
 * on any plain-object index. Non-strings are unsafe.
 */
export function isSafeRuntimeId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.length > MANIFEST_BOUNDS.maxIdLength) return false;
  if (!SAFE_RUNTIME_ID_PATTERN.test(id)) return false;
  return !Object.hasOwn(Object.prototype, id);
}

function manifestRejection(code, message, field) {
  return { ok: false, code, message, field };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const hasOwn = (object, key) => Object.hasOwn(object, key);

function rejectUnknownKeys(object, known, fieldPrefix) {
  for (const key of Object.keys(object)) {
    if (!known.has(key)) return manifestRejection('unknown_field', `unknown field "${fieldPrefix}${key}"`, `${fieldPrefix}${key}`);
  }
  return null;
}

function rejectBoundedString(value, field, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') return manifestRejection('invalid_field', `${field} must be a string`, field);
  if (!allowEmpty && value.length === 0) return manifestRejection('invalid_field', `${field} must be non-empty`, field);
  if (value.length > MANIFEST_BOUNDS.maxStringLength) {
    return manifestRejection('string_length_limit', `${field} exceeds ${MANIFEST_BOUNDS.maxStringLength} characters`, field);
  }
  return null;
}

function rejectStringArray(value, field, { maxLength, unique }) {
  if (!Array.isArray(value)) return manifestRejection('invalid_field', `${field} must be an array of strings`, field);
  if (value.length > maxLength) return manifestRejection('array_length_limit', `${field} exceeds ${maxLength} entries`, field);
  const seen = new Set();
  for (const element of value) {
    const stringCheck = rejectBoundedString(element, `${field}[]`);
    if (stringCheck !== null) return stringCheck;
    if (unique) {
      if (seen.has(element)) return manifestRejection('duplicate_marker', `${field} repeats "${element}"`, field);
      seen.add(element);
    }
  }
  return null;
}

// An element may be exactly '{prompt}' or '{sessionId}', or carry no slot
// braces at all: partial interpolation like '--prompt={x}' or embedded
// slots would change which bytes Tightbeam controls versus the admin.
function rejectNonWholeElementSlot(template, field) {
  for (const element of template) {
    if ((element.includes('{') || element.includes('}')) && element !== '{prompt}' && element !== '{sessionId}') {
      return manifestRejection(
        'non_whole_element_slot',
        `${field} element ${JSON.stringify(element)} must be exactly "{prompt}" or "{sessionId}" or contain no slot`,
        field,
      );
    }
  }
  return null;
}

function rejectTemplateArray(value, field) {
  if (!Array.isArray(value)) return manifestRejection('invalid_field', `${field} must be an array of strings`, field);
  if (value.length > MANIFEST_BOUNDS.maxTemplateElements) {
    return manifestRejection('template_element_limit', `${field} exceeds ${MANIFEST_BOUNDS.maxTemplateElements} elements`, field);
  }
  for (const element of value) {
    const stringCheck = rejectBoundedString(element, `${field}[]`);
    if (stringCheck !== null) return stringCheck;
  }
  return rejectNonWholeElementSlot(value, field);
}

/**
 * Parses one strict v1 runtime manifest. `input` is raw JSON text; bounds on
 * its byte size apply before parsing, all other validation after. Options:
 *
 *   registeredCount       how many runtime records the calling registry
 *                         already holds (default 0)
 *   maxRegisteredRuntimes capacity ceiling, capped at MANIFEST_BOUNDS
 *
 * Returns { ok: true, record } with a deeply frozen manifest-origin record,
 * or { ok: false, code, message, field } with `code` from
 * MANIFEST_ERROR_CODES. Never throws for bad input; throws only for
 * programmer errors in the options themselves. Registration, persistence,
 * and duplicate-across-runtimes checks belong to task 1.3, not here.
 */
export function parseRuntimeManifest(input, { registeredCount = 0, maxRegisteredRuntimes = MANIFEST_BOUNDS.maxRegisteredRuntimes } = {}) {
  if (!Number.isInteger(registeredCount) || registeredCount < 0) {
    throw new Error('parseRuntimeManifest requires registeredCount to be a non-negative integer');
  }
  if (!Number.isInteger(maxRegisteredRuntimes) || maxRegisteredRuntimes < 1 || maxRegisteredRuntimes > MANIFEST_BOUNDS.maxRegisteredRuntimes) {
    throw new Error(`parseRuntimeManifest requires maxRegisteredRuntimes between 1 and ${MANIFEST_BOUNDS.maxRegisteredRuntimes}`);
  }

  if (typeof input !== 'string') {
    return manifestRejection('malformed_json', 'manifest input must be a JSON text string');
  }
  const byteLength = Buffer.byteLength(input, 'utf8');
  if (byteLength > MANIFEST_BOUNDS.maxInputBytes) {
    return manifestRejection('manifest_too_large', `manifest is ${byteLength} bytes, over the ${MANIFEST_BOUNDS.maxInputBytes}-byte limit`);
  }
  // Capacity before content: a full registry rejects without reading further,
  // so nothing downstream can persist past the bound (plan W1 «Bounds»).
  if (registeredCount >= maxRegisteredRuntimes) {
    return manifestRejection('registry_full', `registry holds ${registeredCount} runtimes, at the limit of ${maxRegisteredRuntimes}`);
  }
  let document;
  try {
    document = JSON.parse(input);
  } catch {
    return manifestRejection('malformed_json', 'manifest input is not valid JSON');
  }
  if (!isPlainObject(document)) {
    return manifestRejection('malformed_json', 'manifest must be a JSON object');
  }

  let rejection = rejectUnknownKeys(document, TOP_LEVEL_FIELDS, '');
  if (rejection !== null) return rejection;

  if (document.contractVersion !== '1.0') {
    return manifestRejection('unsupported_contract_version', `contractVersion must be exactly "1.0", got ${JSON.stringify(document.contractVersion ?? null)}`, 'contractVersion');
  }
  if (!isSafeRuntimeId(document.id)) {
    return manifestRejection('unsafe_runtime_id', `runtime id ${JSON.stringify(document.id ?? null)} is not lowercase kebab-case within ${MANIFEST_BOUNDS.maxIdLength} characters`, 'id');
  }

  const strategy = document.resumeStrategy;
  if (strategy === undefined) {
    return manifestRejection('missing_required_field', 'resumeStrategy is required', 'resumeStrategy');
  }
  if (strategy !== 'daemon' && strategy !== 'external') {
    return manifestRejection('invalid_resume_strategy', `resumeStrategy must be "daemon" or "external", got ${JSON.stringify(strategy)}`, 'resumeStrategy');
  }

  // Strategy split (plan W1 «Two integration classes, represented
  // explicitly»): daemon records join the resumer candidate query and need
  // their execution vector; external records manage their own sessions and
  // must never carry one.
  const strategyFields = ['command', 'resumeArgsTemplate', 'spawnArgsTemplate'];
  if (strategy === 'daemon') {
    for (const field of strategyFields) {
      if (!hasOwn(document, field)) return manifestRejection('missing_required_field', `daemon-strategy manifests require ${field}`, field);
    }
  } else {
    for (const field of strategyFields) {
      if (hasOwn(document, field)) return manifestRejection('external_strategy_field', `external-strategy manifests forbid ${field}`, field);
    }
  }

  let command;
  let resumeArgsTemplate;
  let spawnArgsTemplate;
  if (strategy === 'daemon') {
    rejection = rejectBoundedString(document.command, 'command');
    if (rejection !== null) return rejection;
    command = document.command;

    rejection = rejectTemplateArray(document.resumeArgsTemplate, 'resumeArgsTemplate');
    if (rejection !== null) return rejection;
    resumeArgsTemplate = document.resumeArgsTemplate;

    rejection = rejectTemplateArray(document.spawnArgsTemplate, 'spawnArgsTemplate');
    if (rejection !== null) return rejection;
    spawnArgsTemplate = document.spawnArgsTemplate;
  }

  if (!hasOwn(document, 'identity')) return manifestRejection('missing_required_field', 'identity is required', 'identity');
  if (!isPlainObject(document.identity)) return manifestRejection('invalid_field', 'identity must be an object', 'identity');
  rejection = rejectUnknownKeys(document.identity, IDENTITY_FIELDS, 'identity.');
  if (rejection !== null) return rejection;
  const identityArrays = [
    ['sessionEnvVars', MANIFEST_BOUNDS.maxSessionEnvVars, false],
    ['envMarkers', MANIFEST_BOUNDS.maxEnvMarkers, true],
    ['transcriptHints', MANIFEST_BOUNDS.maxTranscriptHints, true],
  ];
  const identityValues = {};
  for (const [field, maxLength, unique] of identityArrays) {
    if (!hasOwn(document.identity, field)) return manifestRejection('missing_required_field', `identity.${field} is required`, `identity.${field}`);
    rejection = rejectStringArray(document.identity[field], `identity.${field}`, { maxLength, unique });
    if (rejection !== null) return rejection;
    identityValues[field] = document.identity[field];
  }

  if (!hasOwn(document, 'hooksInstall')) return manifestRejection('missing_required_field', 'hooksInstall is required', 'hooksInstall');
  if (!isPlainObject(document.hooksInstall)) return manifestRejection('invalid_field', 'hooksInstall must be an object', 'hooksInstall');
  rejection = rejectUnknownKeys(document.hooksInstall, HOOKS_INSTALL_FIELDS, 'hooksInstall.');
  if (rejection !== null) return rejection;
  for (const field of ['settingsPath', 'format']) {
    if (!hasOwn(document.hooksInstall, field)) return manifestRejection('missing_required_field', `hooksInstall.${field} is required`, `hooksInstall.${field}`);
    rejection = rejectBoundedString(document.hooksInstall[field], `hooksInstall.${field}`);
    if (rejection !== null) return rejection;
  }

  if (!hasOwn(document, 'capabilities')) return manifestRejection('missing_required_field', 'capabilities is required', 'capabilities');
  if (!isPlainObject(document.capabilities)) return manifestRejection('invalid_field', 'capabilities must be an object', 'capabilities');
  rejection = rejectUnknownKeys(document.capabilities, CAPABILITY_FIELDS, 'capabilities.');
  if (rejection !== null) return rejection;
  if (!hasOwn(document.capabilities, 'stdoutInjection')) {
    return manifestRejection('missing_required_field', 'capabilities.stdoutInjection is required', 'capabilities.stdoutInjection');
  }
  if (typeof document.capabilities.stdoutInjection !== 'boolean') {
    return manifestRejection('invalid_field', 'capabilities.stdoutInjection must be a boolean', 'capabilities.stdoutInjection');
  }
  if (!hasOwn(document.capabilities, 'blockExitCodes')) {
    return manifestRejection('missing_required_field', 'capabilities.blockExitCodes is required', 'capabilities.blockExitCodes');
  }
  const blockExitCodes = document.capabilities.blockExitCodes;
  if (!Array.isArray(blockExitCodes)) {
    return manifestRejection('invalid_field', 'capabilities.blockExitCodes must be an array of non-negative integers', 'capabilities.blockExitCodes');
  }
  if (blockExitCodes.length > MANIFEST_BOUNDS.maxBlockExitCodes) {
    return manifestRejection('array_length_limit', `capabilities.blockExitCodes exceeds ${MANIFEST_BOUNDS.maxBlockExitCodes} entries`, 'capabilities.blockExitCodes');
  }
  for (const exitCode of blockExitCodes) {
    if (!Number.isSafeInteger(exitCode) || exitCode < 0) {
      return manifestRejection('invalid_field', 'capabilities.blockExitCodes entries must be non-negative integers', 'capabilities.blockExitCodes');
    }
  }

  // Origin is loader-known metadata, mirroring builtins.mjs; it is never
  // adapter-authored (rejected above as unknown_field) and never serialized.
  return {
    ok: true,
    record: Object.freeze({
      id: document.id,
      contractVersion: '1.0',
      origin: 'manifest',
      resumeStrategy: strategy,
      ...(strategy === 'daemon'
        ? {
            command,
            resumeArgsTemplate: Object.freeze([...resumeArgsTemplate]),
            spawnArgsTemplate: Object.freeze([...spawnArgsTemplate]),
          }
        : {}),
      identity: Object.freeze({
        sessionEnvVars: Object.freeze([...identityValues.sessionEnvVars]),
        envMarkers: Object.freeze([...identityValues.envMarkers]),
        transcriptHints: Object.freeze([...identityValues.transcriptHints]),
      }),
      hooksInstall: Object.freeze({
        settingsPath: document.hooksInstall.settingsPath,
        format: document.hooksInstall.format,
      }),
      capabilities: Object.freeze({
        stdoutInjection: document.capabilities.stdoutInjection,
        blockExitCodes: Object.freeze([...blockExitCodes]),
      }),
    }),
  };
}


// ---------------------------------------------------------------------------
// Hook-contract admission (plan W2 «Admission gates (fail-closed)»).
//
// The capability fields on a record are gates, not description: Tightbeam
// can only merge Claude-shaped hook JSON, delivers by injecting through
// stdout the runtime echoes back, and blocks by exiting 2. A runtime
// declaring anything else would receive hooks that cannot do their job, so
// its contract is refused by name — at registration and at startup load,
// so a silent registration can never become a host-wide install outage —
// and again by the CLI installer as defense in depth.
// ---------------------------------------------------------------------------

export const SUPPORTED_HOOK_FORMAT = 'claude-json';
export const SUPPORTED_BLOCK_EXIT_CODE = 2;

/** Every named code an admission refusal can carry. */
export const HOOK_ADMISSION_ERROR_CODES = Object.freeze([
  'unsupported_hooks_format',
  'unsupported_stdout_injection',
  'unsupported_block_exit_codes',
]);

/**
 * Whether this runtime record satisfies the sole hook contract Tightbeam v1
 * supports. Pure: takes a frozen record, returns a verdict carrying the
 * stable code and the offending field — never throws, never touches the
 * filesystem. Messages name field and value so an adapter author can fix
 * the manifest without reading our code.
 */
export function admitHookContract(record) {
  const format = record?.hooksInstall?.format;
  if (format !== SUPPORTED_HOOK_FORMAT) {
    return {
      ok: false,
      code: 'unsupported_hooks_format',
      field: 'hooksInstall.format',
      message:
        `hooksInstall.format must be "${SUPPORTED_HOOK_FORMAT}", got ${JSON.stringify(format ?? null)}: ` +
        'Tightbeam can only merge Claude-shaped hook settings files',
    };
  }
  if (record?.capabilities?.stdoutInjection !== true) {
    return {
      ok: false,
      code: 'unsupported_stdout_injection',
      field: 'capabilities.stdoutInjection',
      message:
        `capabilities.stdoutInjection must be true, got ${JSON.stringify(record?.capabilities?.stdoutInjection ?? null)}: ` +
        "Tightbeam delivers messages by injecting through the hook's stdout, which this runtime declares it does not support",
    };
  }
  const blockExitCodes = record?.capabilities?.blockExitCodes;
  if (!Array.isArray(blockExitCodes) || blockExitCodes.length === 0 || blockExitCodes.some((code) => code !== SUPPORTED_BLOCK_EXIT_CODE)) {
    return {
      ok: false,
      code: 'unsupported_block_exit_codes',
      field: 'capabilities.blockExitCodes',
      message:
        `capabilities.blockExitCodes must be [${SUPPORTED_BLOCK_EXIT_CODE}], got ${JSON.stringify(blockExitCodes ?? null)}: ` +
        `the Stop gate blocks by exiting ${SUPPORTED_BLOCK_EXIT_CODE}, so no other code is supported`,
    };
  }
  return { ok: true };
}

/**
 * The canonical id for `id`, or null.
 *
 * Accepts a canonical id (`claude-code`, `codex`) or a legacy alias
 * (`claude`). Anything else — including case variants, surrounding
 * whitespace, prototype names, and non-strings — resolves to null rather
 * than guessing: an id that silently aliases to the wrong runtime corrupts
 * endpoint identity and resume routing.
 */
export function canonicalizeRuntimeId(id) {
  if (typeof id !== 'string' || id.length === 0) return null;
  if (Object.hasOwn(BUILTIN_RUNTIMES, id)) return id;
  return Object.hasOwn(LEGACY_RUNTIME_ALIASES, id) ? LEGACY_RUNTIME_ALIASES[id] : null;
}

/**
 * Every stored-id spelling that must compare equal to `id`'s canonical
 * record: the canonical spelling first, then each legacy alias. Consumers
 * match persisted values with `acceptedStoredIds(canonical).includes(stored)`
 * instead of keeping any consumer-specific alias map. Returns null when
 * `id` names no known runtime.
 */
export function acceptedStoredIds(id) {
  const canonical = canonicalizeRuntimeId(id);
  if (canonical === null) return null;
  return Object.freeze([canonical, ...Object.keys(LEGACY_RUNTIME_ALIASES).filter((alias) => LEGACY_RUNTIME_ALIASES[alias] === canonical)]);
}

/**
 * A fresh registry instance scoped to one state root, serving the builtins
 * plus any manifest-origin records handed in (task 1.3's merged snapshot).
 * Instances are immutable views: activation of a new registration builds a
 * NEW instance and swaps it onto the daemon context whole, so no reader
 * can observe a half-updated registry. `manifestRecords` is a
 * programmer-supplied argument and is validated as such: every record must
 * carry a safe id and loader-known origin 'manifest', must not duplicate a
 * builtin id or legacy alias, and must not repeat within the array.
 */
export function createRuntimeRegistry({ stateRoot, manifestRecords = [] } = {}) {
  if (typeof stateRoot !== 'string' || stateRoot.length === 0) {
    throw new Error('createRuntimeRegistry requires a non-empty stateRoot string');
  }
  if (!Array.isArray(manifestRecords)) {
    throw new Error('createRuntimeRegistry requires manifestRecords to be an array');
  }

  const manifestById = new Map();
  for (const record of manifestRecords) {
    if (!record || typeof record !== 'object' || record.origin !== 'manifest' || !isSafeRuntimeId(record.id)) {
      throw new Error(`createRuntimeRegistry requires each manifestRecord to be a parsed v1 manifest record, got ${JSON.stringify(record?.id ?? null)}`);
    }
    if (canonicalizeRuntimeId(record.id) !== null) {
      throw new Error(`manifest record id "${record.id}" collides with the builtin/alias space`);
    }
    if (manifestById.has(record.id)) {
      throw new Error(`manifest record id "${record.id}" appears more than once`);
    }
    manifestById.set(record.id, record);
  }

  const builtinGet = (id) => {
    const canonical = canonicalizeRuntimeId(id);
    return canonical === null ? null : BUILTIN_RUNTIMES[canonical];
  };

  return Object.freeze({
    stateRoot,
    /** Builtin canonical ids in table order, then manifest ids in load order. */
    names: () => Object.freeze([...CANONICAL_RUNTIME_IDS, ...manifestById.keys()]),
    /** Every record — builtins first, then manifests — in names() order. */
    list: () => Object.freeze([...CANONICAL_RUNTIME_IDS.map((id) => BUILTIN_RUNTIMES[id]), ...manifestById.values()]),
    /** Just the manifest-origin records, in load order. */
    manifests: () => Object.freeze([...manifestById.values()]),
    /**
     * The record for `id` — canonical or legacy alias for builtins, exact
     * spelling for manifests — or null. Matches runtimeEntry's fail-closed
     * shape so migrated call sites keep their current null-handling.
     */
    get(id) {
      const builtin = builtinGet(id);
      return builtin ?? (typeof id === 'string' ? manifestById.get(id) ?? null : null);
    },
    canonicalizeRuntimeId,
    acceptedStoredIds,
  });
}
