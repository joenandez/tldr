// Session-host binding values (TIGHTBEAM_HOST / TIGHTBEAM_HOST_REF). Shared by
// the SessionStart hook and endpoint.register so both validate identically.
// There is no application-name pattern elsewhere (application.register takes
// any non-empty string), so host_name uses this bounded one.
export const HOST_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const HOST_REF_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
