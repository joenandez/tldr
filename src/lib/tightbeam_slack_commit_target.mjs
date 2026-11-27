// The target of an inbound Slack commit, over the daemon socket: the owner registration
// (idempotent by its external ref) and the route list that registerOwner and listSlackRoutes run
// through the CLI. The inbound lane builds a fresh channel per drain, so the claim path's cached
// target cannot help here; in process, a commit pays no CLI dispatch at all (ac-wzn7q).
import {
  SLACK_AUTHORITY,
  SLACK_ENDPOINT_SESSION,
  SLACK_PRINCIPAL_REF,
  fail,
  nonEmpty,
} from "./tightbeam_slack_support.mjs";

async function ownerOf(send) {
  const principal = await send("principal.register", {
    authority_name: SLACK_AUTHORITY,
    external_principal_ref: SLACK_PRINCIPAL_REF,
    display_name: "Owner",
  });
  const principalId = principal.ok ? principal.result?.principal_id : null;
  const endpoint = nonEmpty(principalId)
    ? await send("endpoint.register", {
        authority_name: SLACK_AUTHORITY,
        principal_id: principalId,
        runtime: "reference",
        provider_session_id: SLACK_ENDPOINT_SESSION,
        authority_reference: SLACK_AUTHORITY,
      })
    : null;
  return endpoint?.ok && nonEmpty(endpoint.result?.endpoint_id)
    ? { principal: principal.result, endpoint: endpoint.result }
    : null;
}

function slackRouteOf(listed) {
  const routes = listed.ok ? listed.result?.routes : null;
  return Array.isArray(routes)
    ? (routes.find((r) => r?.selector === "slack") ?? null)
    : null;
}

// { identity, owner, route }, or the failure resolveTarget gives: not_configured, route_unavailable.
export async function commitTarget(ctx) {
  const identity = await ctx.safeIdentity();
  if (!identity) return fail("not_configured");
  const send = (op, payload) => ctx.request(identity, op, payload);
  const [owner, listed] = await Promise.all([
    ownerOf(send),
    send("channel.route.list", {}),
  ]);
  const route = slackRouteOf(listed);
  const problem = !owner ? "not_configured" : !route && "route_unavailable";
  return problem ? fail(problem) : { identity, owner, route };
}
