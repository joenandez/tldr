// Prefixed identifier generation, docs/security-model.md "Identifier
// kinds". Daemon-assigned prefixed kinds are covered here; provider session
// id and external application reference are caller-supplied opaque strings
// and are not generated. The forward lifecycle tables (schema v7) add two
// row kinds beyond the original eight: immutable effect audits and handoff
// watches. Schema v8 adds the lifecycle command ledger's row kind.

import { randomBytes } from 'node:crypto';

export const ID_PREFIXES = Object.freeze({
  application: 'app_',
  principal: 'prn_',
  endpoint: 'end_',
  conversation: 'cnv_',
  message: 'msg_',
  delivery: 'dlv_',
  obligation: 'obl_',
  resume_request: 'res_',
  message_effect: 'eff_',
  handoff_watch: 'hw_',
  lifecycle_command: 'lfc_',
  channel_route: 'chr_',
  // These identify durable daemon rows. The externally supplied rpb_ reply
  // binding is capability material, so it is deliberately not generated or
  // validated as an identifier here.
  reply_binding: 'rbd_',
  reply_wait: 'rwt_',
  listener: 'lsn_',
  listener_presentation: 'lpr_',
  endpoint_retirement: 'etr_',
});

const SUFFIX_HEX_LENGTH = 32; // crypto.randomBytes(16).toString('hex')

export function generateId(kind) {
  const prefix = ID_PREFIXES[kind];
  if (!prefix) {
    throw new Error(`unknown id kind: ${kind}`);
  }
  return prefix + randomBytes(16).toString('hex');
}

export function isValidId(id, kind) {
  const prefix = ID_PREFIXES[kind];
  if (!prefix || typeof id !== 'string') return false;
  if (!id.startsWith(prefix)) return false;
  const suffix = id.slice(prefix.length);
  return suffix.length === SUFFIX_HEX_LENGTH && /^[0-9a-f]+$/.test(suffix);
}
