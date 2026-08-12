const INSTALLER_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const PASSTHROUGH_KEYS = Object.freeze([
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "TMPDIR",
  "USER",
]);

export function sanitizeInstallerEnvironment(environment = process.env) {
  const sanitized = { PATH: INSTALLER_PATH };
  for (const key of PASSTHROUGH_KEYS) {
    if (typeof environment[key] === "string" && environment[key].length > 0) {
      sanitized[key] = environment[key];
    }
  }
  return Object.freeze(sanitized);
}
