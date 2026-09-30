// Shared helper: does a connection's permission grant cover a given
// authority name? Used by every op scoped to `allowed_authorities`
// (docs/security-model.md Permission catalog #1 register_endpoints, #2
// send_as_principal). A missing grant or a null/absent allowed_authorities
// list means no authority is allowed — permission scope is always an
// explicit allow-list, never inferred (docs/security-model.md "Authority
// model": never trust client-declared scope).

export function authorityIsAllowed(connection, permissionName, authorityName) {
  const grant = connection.permissions.get(permissionName);
  if (!grant) return false;
  return Array.isArray(grant.allowed_authorities) && grant.allowed_authorities.includes(authorityName);
}

export function isUniqueConstraintError(err) {
  return Boolean(err) && err.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(err.message ?? '');
}
