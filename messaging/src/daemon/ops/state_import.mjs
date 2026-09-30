// state.import — docs/protocol.md "State movement", admin-only. Verifies
// record_counts + content_hash against the presented records BEFORE any
// write; applies every record insert plus the import_manifests bookkeeping
// row inside one transaction (the product plan «Migration Plan»: "Every
// import is atomic or leaves no active imported records"); repeating the
// identical (source_product, source_revision, content_hash) import is a
// no-op success ("already_applied"); the same declared source identity
// with a different content_hash fails closed with migration_incompatible
// ("Repeating the same import is idempotent. A different payload with the
// same import identity fails" — plan). See
// src/daemon/migration_records.mjs's header comment for the
// non-empty-database decision.

import { TightbeamError } from '../../protocol/envelope.mjs';
import { withTransaction } from '../db.mjs';
import { generateAppSecret, hashSecret } from '../auth.mjs';
import { isUniqueConstraintError } from './authority_scope.mjs';
import { LIFECYCLE_CUTOVER_SCHEMA_VERSION } from '../schema.mjs';
import { findInvalidImportedTachyonArming, reconcileTachyonArmingFromAudit } from '../tachyon_arming.mjs';
import { TABLE_ORDER, normalizeRecords, validateRecordsShape, computeContentHash, findMissingObligationParent, findInvalidChannelRoute, findInvalidReplyBinding, findInvalidReplyCausality, findInvalidEndpointRetirement, findInvalidAcademyAgentName, findInvalidResumeAdmission, findInvalidDeliveryAdmission, insertRecords } from '../migration_records.mjs';

/**
 * "No secrets migrated" (plan «Migration Plan») means the ORIGINAL
 * app_secret never crosses the export/import boundary — src/daemon/
 * migration_records.mjs omits the applications.secret_hash key entirely
 * from every exported row (redaction by OMISSION, not a placeholder
 * value), so an import presents application identities with no usable
 * credential material at all. That would permanently
 * strand every imported principal's data: inbox.list (ws-7) gates
 * read_inbox on `principals.created_by_app_id === connection.appId`, so
 * nobody could ever again authenticate as the app_id that owns the
 * imported principals. Instead, on a genuinely NEW ('applied', not
 * 'already_applied') import, this mints one FRESH working secret per
 * imported application row — same generateAppSecret()/hashSecret() pair
 * application.register uses, same "returned once, never retrievable
 * again" contract — so the preserved app_id (plan: "Preserve original IDs
 * as namespaced provenance") is immediately usable on the target daemon
 * without a separate credential-recovery mechanism. This mirrors plan
 * «Migration Plan»'s Helm cutover step 4 ("Register Helm as a client")
 * while honoring "Preserve original IDs" instead of allocating a
 * different app_id for the same imported identity.
 */
function mintFreshApplicationSecrets(applications) {
  const mintedSecrets = [];
  const rewritten = applications.map((app) => {
    const appSecret = generateAppSecret();
    mintedSecrets.push({ app_id: app.id, app_secret: appSecret });
    return { ...app, secret_hash: hashSecret(appSecret) };
  });
  return { rewritten, mintedSecrets };
}

function fail(message, field) {
  throw new TightbeamError('malformed_request', message, field ? { field } : undefined);
}

function validateManifest(manifest) {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    fail('manifest is required and must be an object', 'manifest');
  }
  const { source_product: sourceProduct, source_revision: sourceRevision, schema_version: schemaVersion, record_counts: recordCounts, content_hash: contentHash } = manifest;

  if (typeof sourceProduct !== 'string' || sourceProduct.trim().length === 0) {
    fail('manifest.source_product is required and must be a non-empty string', 'manifest.source_product');
  }
  if (sourceRevision !== undefined && sourceRevision !== null && typeof sourceRevision !== 'string') {
    fail('manifest.source_revision must be a string when present', 'manifest.source_revision');
  }
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
    fail('manifest.schema_version is required and must be a positive integer', 'manifest.schema_version');
  }
  if (typeof contentHash !== 'string' || contentHash.length === 0) {
    fail('manifest.content_hash is required and must be a non-empty string', 'manifest.content_hash');
  }
  if (recordCounts !== undefined && (typeof recordCounts !== 'object' || recordCounts === null || Array.isArray(recordCounts))) {
    fail('manifest.record_counts must be an object when present', 'manifest.record_counts');
  }

  return { sourceProduct, sourceRevision: sourceRevision ?? null, schemaVersion, recordCounts: recordCounts ?? null, contentHash };
}

export const stateImportOp = {
  name: 'state.import',
  allowedScopes: ['admin'],
  permission: null,
  handler(context, payload) {
    const { sourceProduct, sourceRevision, schemaVersion, recordCounts: claimedCounts, contentHash: claimedHash } = validateManifest(
      payload && payload.manifest,
    );

    // Forward-only portability (plan «Migration Plan — Forward state
    // portability»): a document stamped before the lifecycle cutover was
    // written by a daemon whose obligations carry the legacy lifecycle
    // columns. It is retained as an archive / whole-root rollback artifact;
    // it is never converted, defaulted forward, or partially imported. The
    // gate runs before any record inspection so the refusal needs nothing
    // from the payload and writes nothing.
    if (schemaVersion < LIFECYCLE_CUTOVER_SCHEMA_VERSION) {
      throw new TightbeamError(
        'migration_incompatible',
        `import manifest schema_version ${schemaVersion} predates the lifecycle cutover ` +
          `(schema ${LIFECYCLE_CUTOVER_SCHEMA_VERSION}): a pre-cutover export is an archive of the old daemon's state root, ` +
          'and its obligation history cannot be imported into the forward lifecycle store; ' +
          'restore it only as a whole state root with the old binary',
      );
    }

    // Validate the document as presented before normalization fills omitted
    // empty tables. Otherwise an unknown own table key can be silently
    // discarded by normalizeRecords and evade the import boundary.
    validateRecordsShape(payload && payload.records, (message, field) => fail(message, field));
    const normalized = normalizeRecords(payload && payload.records);
    const orphanChild = findMissingObligationParent(normalized);
    if (orphanChild) {
      throw new TightbeamError(
        'migration_incompatible',
        'imported obligation tree is incomplete: every child obligation must carry its parent in the same records payload',
      );
    }
    const invalidChannelRoute = findInvalidChannelRoute(normalized);
    if (invalidChannelRoute) {
      throw new TightbeamError('migration_incompatible', `imported ${invalidChannelRoute}; nothing was written`);
    }
    const invalidReplyBinding = findInvalidReplyBinding(normalized);
    if (invalidReplyBinding) {
      throw new TightbeamError('migration_incompatible', `imported ${invalidReplyBinding}; nothing was written`);
    }
    const invalidEndpointRetirement = findInvalidEndpointRetirement(normalized);
    if (invalidEndpointRetirement) {
      throw new TightbeamError('migration_incompatible', `imported ${invalidEndpointRetirement}; nothing was written`);
    }
    const invalidAcademyAgentName = findInvalidAcademyAgentName(normalized, { schemaVersion });
    if (invalidAcademyAgentName) {
      throw new TightbeamError('migration_incompatible', `imported ${invalidAcademyAgentName}; nothing was written`);
    }
    const invalidResumeAdmission = findInvalidResumeAdmission(normalized, { schemaVersion });
    if (invalidResumeAdmission) {
      throw new TightbeamError('migration_incompatible', `imported ${invalidResumeAdmission}; nothing was written`);
    }
    const invalidDeliveryAdmission = findInvalidDeliveryAdmission(normalized, { schemaVersion });
    if (invalidDeliveryAdmission) {
      throw new TightbeamError('migration_incompatible', `imported ${invalidDeliveryAdmission}; nothing was written`);
    }
    const invalidReplyCausality = findInvalidReplyCausality(normalized, { schemaVersion });
    if (invalidReplyCausality) {
      throw new TightbeamError('migration_incompatible', `imported ${invalidReplyCausality}; nothing was written`);
    }
    const invalidTachyonArming = findInvalidImportedTachyonArming(normalized);
    if (invalidTachyonArming) {
      throw new TightbeamError('migration_incompatible', `imported ${invalidTachyonArming}; nothing was written`);
    }

    if (schemaVersion > context.schemaVersion) {
      throw new TightbeamError(
        'migration_incompatible',
        `import manifest schema_version ${schemaVersion} is newer than this daemon's supported schema_version ${context.schemaVersion}`,
      );
    }

    const actualCounts = {};
    for (const table of TABLE_ORDER) actualCounts[table] = normalized[table].length;

    if (claimedCounts) {
      for (const table of TABLE_ORDER) {
        const claimed = claimedCounts[table] ?? 0;
        if (claimed !== actualCounts[table]) {
          throw new TightbeamError(
            'migration_incompatible',
            `manifest record_counts.${table} (${claimed}) does not match the records payload (${actualCounts[table]}); the import document may have been tampered with`,
          );
        }
      }
    }

    const actualHash = computeContentHash(normalized);
    if (actualHash !== claimedHash) {
      throw new TightbeamError(
        'migration_incompatible',
        'manifest content_hash does not match the records payload; the import document may have been tampered with',
      );
    }

    const existing = context.db
      .prepare(
        `SELECT import_id, content_hash, record_counts, status FROM import_manifests
          WHERE source_product = ? AND IFNULL(source_revision, '') = ? AND status = 'active'`,
      )
      .get(sourceProduct, sourceRevision ?? '');

    if (existing) {
      if (existing.content_hash === claimedHash) {
        return {
          result: {
            import_id: existing.import_id,
            status: 'already_applied',
            record_counts: JSON.parse(existing.record_counts || '{}'),
          },
        };
      }
      throw new TightbeamError(
        'migration_incompatible',
        `a different import was already applied for source_product="${sourceProduct}" source_revision="${sourceRevision ?? ''}"`,
      );
    }

    const importId = claimedHash;
    const importedAt = new Date().toISOString();

    const { rewritten: rewrittenApplications, mintedSecrets } = mintFreshApplicationSecrets(normalized.applications);
    const recordsToWrite = { ...normalized, applications: rewrittenApplications };

    try {
      withTransaction(context.db, () => {
        const { defaultedColumns } = insertRecords(context.db, recordsToWrite);
        reconcileTachyonArmingFromAudit(context.db, { endpointIds: recordsToWrite.endpoints.map((endpoint) => endpoint.id) });
        if (Object.keys(defaultedColumns).length > 0) {
          // An older export does not carry the columns a later schema
          // added; those take their schema DEFAULT (see insertRecords).
          // Say so rather than let a silently-defaulted column look like
          // recorded fact.
          context.logger?.info({
            event: 'state_import_defaulted_columns',
            source_product: sourceProduct,
            source_revision: sourceRevision,
            manifest_schema_version: schemaVersion,
            daemon_schema_version: context.schemaVersion,
            defaulted_columns: defaultedColumns,
          });
        }
        context.db
          .prepare(
            `INSERT INTO import_manifests
              (import_id, source_product, source_revision, schema_version_at_import, record_counts, content_hash, imported_at, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
          )
          .run(importId, sourceProduct, sourceRevision, schemaVersion, JSON.stringify(actualCounts), claimedHash, importedAt);
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new TightbeamError(
          'migration_incompatible',
          'import conflicts with existing state (a record identifier or the content_hash already exists under different provenance)',
        );
      }
      if (err && err.code === 'ERR_SQLITE_ERROR') {
        // Any other constraint the payload violates — a dangling
        // REFERENCES, a CHECK a record cannot satisfy, a NOT NULL column
        // with no default. The transaction already rolled back, so the
        // target is unchanged; what the caller needs is a protocol error
        // code and the database's own explanation, not a bare
        // ERR_SQLITE_ERROR escaping as "internal error".
        context.logger?.error({
          event: 'state_import_constraint_failed',
          source_product: sourceProduct,
          source_revision: sourceRevision,
          message: err.message,
          stack: err.stack,
        });
        throw new TightbeamError(
          'migration_incompatible',
          'import violates the target schema (a referenced record is missing from the payload, or a record fails a schema constraint); nothing was written',
          { sqlite_message: err.message },
        );
      }
      throw err;
    }

    return {
      result: {
        import_id: importId,
        status: 'applied',
        record_counts: actualCounts,
        // Additive beyond docs/protocol.md's minimum state.import result
        // shape ({ import_id, status, record_counts }) — see
        // mintFreshApplicationSecrets' comment above for why this exists.
        // Each app_secret is returned exactly once, here, same as
        // application.register's contract; never re-derivable, never
        // returned again on a later 'already_applied' replay of this
        // exact import.
        application_secrets: mintedSecrets,
      },
    };
  },
};
