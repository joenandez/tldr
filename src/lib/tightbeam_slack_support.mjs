import { resolve } from "node:path";
import {
  commandFailure,
  productionRun,
  tightbeamInvocation,
} from "./tightbeam_channel_runtime.mjs";
import { slackIdentityStore } from "./tightbeam_slack_identity.mjs";
import { helmHome } from "./store.mjs";

export const SLACK_APPLICATION = "tldr-slack";
export const SLACK_AUTHORITY = "tldr-slack";
export const SLACK_PRINCIPAL_REF = "verified-owner";
export const SLACK_ENDPOINT_SESSION = "tldr-slack-owner";
// A second authority for the helper principal that opens by-name conversations.
// send_as_principal is granted for this authority only, so the owner principal
// (SLACK_AUTHORITY) still resolves to the bridge `inbound` send branch.
export const SLACK_OPENER_AUTHORITY = "tldr-slack-opener";
export const SLACK_OPENER_REF = "conversation-opener";

export const PERMISSIONS = Object.freeze([
  {
    permission: "register_endpoints",
    allowed_authorities: [SLACK_AUTHORITY, SLACK_OPENER_AUTHORITY],
  },
  { permission: "publish_inbound_messages" },
  { permission: "consume_outbound_requests" },
  {
    permission: "send_as_principal",
    allowed_authorities: [SLACK_OPENER_AUTHORITY],
  },
]);

const TIGHTBEAM_CODE = /^[a-z][a-z_]{0,63}$/u;
export const OK = Object.freeze({ ok: true });
export const fail = (code, extra = {}) =>
  Object.freeze({ ok: false, code, ...extra });
export const nonEmpty = (value) =>
  typeof value === "string" && value.length > 0;

// productionRun only maps identity_conflict for tldr-email, so tldr-slack sees
// it raw: as tightbeam_code, or as a malformed_request "already registered".
export function isIdentityConflict(result) {
  const error = result?.error;
  return (
    error?.code === "TIGHTBEAM_APPLICATION_IDENTITY_CONFLICT" ||
    error?.tightbeam_code === "identity_conflict" ||
    /already registered/u.test(String(error?.message ?? ""))
  );
}

export function tightbeamCodeOf(result) {
  const reported = result?.error?.tightbeam_code ?? result?.error?.code;
  return TIGHTBEAM_CODE.test(reported ?? "") ? reported : null;
}

async function registerOwner(asApp, identity) {
  const principal = await asApp(identity, [
    "principal",
    "register",
    "--authority",
    SLACK_AUTHORITY,
    "--external-ref",
    SLACK_PRINCIPAL_REF,
    "--display-name",
    "Owner",
  ]);
  if (commandFailure(principal) || !nonEmpty(principal.result?.principal_id)) {
    return null;
  }
  const endpoint = await asApp(identity, [
    "endpoint",
    "register",
    "--authority",
    SLACK_AUTHORITY,
    "--principal",
    principal.result.principal_id,
    "--runtime",
    "reference",
    "--session",
    SLACK_ENDPOINT_SESSION,
    "--reference",
    SLACK_AUTHORITY,
  ]);
  if (commandFailure(endpoint) || !nonEmpty(endpoint.result?.endpoint_id)) {
    return null;
  }
  return { principal: principal.result, endpoint: endpoint.result };
}

async function registerOpener({ admin, asApp }, identity) {
  const authority = await admin([
    "authority",
    "register",
    SLACK_OPENER_AUTHORITY,
  ]);
  if (commandFailure(authority) && !isIdentityConflict(authority)) return null;
  const principal = await asApp(identity, [
    "principal",
    "register",
    "--authority",
    SLACK_OPENER_AUTHORITY,
    "--external-ref",
    SLACK_OPENER_REF,
    "--display-name",
    "tldr Slack",
  ]);
  return commandFailure(principal) || !nonEmpty(principal.result?.principal_id)
    ? null
    : principal.result;
}

// Idempotent. Registration and the daemon's first by-name post both run it, so
// an existing install picks up the grant without a repair. null: unavailable.
async function provisionOpener(runners, identity) {
  const grants = await runners.admin([
    "app",
    "set-permissions",
    identity.app_id,
    "--permissions-json",
    JSON.stringify(PERMISSIONS),
  ]);
  return commandFailure(grants) ? null : registerOpener(runners, identity);
}

// Shared plumbing for the Slack channel modules: tightbeam invocation,
// identity access, owner principal/endpoint registration and structured logs.
export function createSlackContext({
  run = productionRun,
  command,
  commandPrefix,
  home = resolve(helmHome()),
  loadIdentity,
  saveIdentity,
  logger = () => {},
} = {}) {
  const store = slackIdentityStore(home);
  const readIdentity = loadIdentity ?? (() => store.load());
  const persistIdentity = saveIdentity ?? ((identity) => store.save(identity));
  const invocation = tightbeamInvocation({ command, commandPrefix });
  const execute = (options) => run({ ...invocation, ...options });
  const admin = (args) => execute({ admin: true, credentials: null, args });
  const asApp = (credentials, args) =>
    execute({ admin: false, credentials, args });

  // begin(event) returns finish(status, params) which logs with latency.
  function begin(event) {
    const startedAt = Date.now();
    return (status, params = {}) =>
      logger({
        event,
        status,
        params,
        latency_ms: Date.now() - startedAt,
      });
  }

  const safeIdentity = () => readIdentity().catch(() => null);
  let opener = null;

  return Object.freeze({
    admin,
    asApp,
    begin,
    readIdentity,
    persistIdentity,
    safeIdentity,
    registerOwner: (identity) => registerOwner(asApp, identity),
    registerOpener: (identity) => registerOpener({ admin, asApp }, identity),
    async ensureOpener(identity) {
      opener ??= await provisionOpener({ admin, asApp }, identity);
      return opener;
    },
  });
}
