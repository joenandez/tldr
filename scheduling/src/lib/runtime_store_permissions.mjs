import { chmodSync, existsSync } from "node:fs";

function posixModesSupported() {
  return process.platform !== "win32";
}

export function applyOwnerOnlyPermissions(path) {
  if (!posixModesSupported() || !existsSync(path)) return;
  chmodSync(path, 0o600);
}

export function applyRuntimeStorePermissions(path) {
  applyOwnerOnlyPermissions(path);
  applyOwnerOnlyPermissions(`${path}-wal`);
  applyOwnerOnlyPermissions(`${path}-shm`);
}
