// App secret hashing/verification and admin nonce bootstrap.
// the architecture contract §4.

import fs from 'node:fs';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;

/**
 * Hashes an app secret as scrypt$<saltHex>$<hashHex> with a random 16-byte
 * salt. The plaintext secret is never stored (the architecture contract §4).
 */
export function hashSecret(secret) {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const hash = scryptSync(secret, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/**
 * Verifies a presented secret against a stored scrypt$<salt>$<hash> value
 * using a constant-time compare. Never throws on a malformed stored value.
 */
export function verifySecret(secret, stored) {
  if (typeof secret !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, saltHex, hashHex] = parts;

  let salt;
  let expected;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  const actual = scryptSync(secret, salt, expected.length);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * Generates a new one-time app secret, returned to the caller once
 * (docs/protocol.md application.register).
 */
export function generateAppSecret() {
  return randomBytes(32).toString('hex');
}

/**
 * Writes a fresh, random single-use admin bootstrap nonce to the fixed
 * path <state-root>/admin/bootstrap.nonce at mode 0600. Called by an
 * admin client, which proves state-root ownership by successfully writing
 * into the 0700 admin/ directory (the architecture contract §4).
 */
export function createAdminNonce(noncePath) {
  const nonce = randomBytes(32).toString('hex');
  fs.writeFileSync(noncePath, nonce, { mode: 0o600 });
  fs.chmodSync(noncePath, 0o600);
  return nonce;
}

/**
 * Reads the nonce independently from disk (never trusting client-supplied
 * file content, only the client-supplied nonce value) and compares
 * byte-for-byte against the presented value. On a match, deletes the
 * nonce file so it is single-use.
 */
export function verifyAndConsumeAdminNonce(noncePath, presented) {
  if (typeof presented !== 'string' || presented.length === 0) return false;

  let stored;
  try {
    stored = fs.readFileSync(noncePath, 'utf8').trim();
  } catch {
    return false;
  }

  const storedBuf = Buffer.from(stored, 'utf8');
  const presentedBuf = Buffer.from(presented, 'utf8');
  const matches = storedBuf.length === presentedBuf.length && timingSafeEqual(storedBuf, presentedBuf);

  if (matches) {
    try {
      fs.rmSync(noncePath, { force: true });
    } catch {
      // best-effort single-use enforcement; a failed unlink here does not
      // change the fact that this handshake was verified.
    }
  }

  return matches;
}
