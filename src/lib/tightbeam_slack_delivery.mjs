import {
  commandFailure,
  expectedPreflightArgs,
} from "./tightbeam_channel_runtime.mjs";
import {
  OK,
  fail,
  nonEmpty,
  tightbeamCodeOf,
} from "./tightbeam_slack_support.mjs";

async function deliveryCapabilityAvailable(ctx) {
  const result = await ctx.admin(expectedPreflightArgs());
  return result?.ok === true && result.result?.compatible === true;
}

async function claimTarget(ctx, listRoutes) {
  const identity = await ctx.safeIdentity();
  const owner = identity ? await ctx.registerOwner(identity) : null;
  if (!owner) return fail("not_configured");
  const listed = await listRoutes();
  const route = listed.ok ? listed.routes[0] : null;
  if (!route) return fail("route_unavailable");
  return { identity, owner, endpointId: owner.endpoint.endpoint_id, route };
}

// An idle auto-select claim answers claim_held; anything else is a real failure.
function claimFailure(claimed, finish) {
  const code = tightbeamCodeOf(claimed);
  if (code === "claim_held") return fail("claim_unavailable");
  finish("claim_failed", { tightbeam_code: code });
  return fail("claim_failed", { tightbeam_code: code });
}

async function claimSlackDelivery(ctx, listRoutes) {
  const target = await claimTarget(ctx, listRoutes);
  if (target.ok === false) return target;
  const finish = ctx.begin("tightbeam_slack_claim");
  const claimed = await ctx.asApp(target.identity, [
    "delivery",
    "claim",
    "--endpoint",
    target.endpointId,
    "--channel-route",
    target.route.route_id,
    "--accept-reply-binding",
  ]);
  if (commandFailure(claimed)) return claimFailure(claimed, finish);
  finish("claimed", { delivery_id: claimed.result?.delivery_id });
  return Object.freeze({ ok: true, claim: claimed.result });
}

async function deliveryCommand(ctx, { name, args, failureCode, params }) {
  const identity = await ctx.safeIdentity();
  if (!identity) return fail("not_configured");
  const finish = ctx.begin(`tightbeam_slack_${name}`);
  const result = await ctx.asApp(identity, ["delivery", name, ...args]);
  if (commandFailure(result)) {
    finish("failed", { ...params, tightbeam_code: tightbeamCodeOf(result) });
    return fail(failureCode);
  }
  finish("ok", params);
  return OK;
}

// Shared publish/commit outcome: both succeed with a message_id.
function messageOutcome({ name, result, finish }) {
  if (commandFailure(result) || !nonEmpty(result.result?.message_id)) {
    const code = tightbeamCodeOf(result);
    finish("failed", { tightbeam_code: code });
    return fail(`${name}_failed`, { tightbeam_code: code });
  }
  finish("ok", { message_id: result.result.message_id });
  return Object.freeze({ ok: true, ...result.result });
}

async function publishSlackReply(ctx, input) {
  const identity = await ctx.safeIdentity();
  if (!identity) return fail("not_configured");
  const finish = ctx.begin("tightbeam_slack_publish");
  const result = await ctx.asApp(identity, [
    "channel",
    "reply",
    "publish",
    "--reply-binding",
    input.reply_binding,
    "--body",
    input.body,
    "--external-event-id",
    input.external_event_id,
    "--provider-metadata-json",
    JSON.stringify({ channel: "slack" }),
  ]);
  return messageOutcome({ name: "publish", result, finish });
}

// Bridge ingress (messaging/docs/bridge-ingress.md section 2). The process
// generation is the endpoint.register result's process_generation. The Slack
// route as origin gives the agent's default `agent reply` a path back here.
async function commitSlackMessage(ctx, listRoutes, input) {
  const target = await claimTarget(ctx, listRoutes);
  if (target.ok === false) return target;
  const { identity, owner, route } = target;
  const finish = ctx.begin("tightbeam_slack_commit");
  const result = await ctx.asApp(identity, [
    "message",
    "commit",
    "--conversation",
    input.conversation_id,
    "--from",
    owner.principal.principal_id,
    "--body",
    input.body,
    "--key",
    input.idempotency_key,
    "--effect",
    "none",
    "--sender-endpoint",
    owner.endpoint.endpoint_id,
    "--process-generation",
    String(owner.endpoint.process_generation),
    "--origin-channel-route",
    route.route_id,
    // one named session instead of every sibling endpoint of the principal
    ...(input.target_endpoint_id
      ? ["--inbound-target-endpoint", input.target_endpoint_id]
      : []),
  ]);
  return messageOutcome({ name: "commit", result, finish });
}

// A fresh two-party conversation (Slack's helper principal + the target agent
// principal), created as the app so the target is a participant; the owner's
// bridge commit then joins it as route_admitted. Failure holds the post.
async function createConversation(ctx, { identity, opener, input }) {
  const finish = ctx.begin("tightbeam_slack_open_conversation");
  const created = await ctx.asApp(identity, [
    "conversation",
    "create",
    "--participants",
    `${opener.principal_id},${input.target_principal_id}`,
    "--subject",
    input.subject,
    "--reason",
    "Slack post",
  ]);
  const id = created?.result?.conversation_id;
  if (commandFailure(created) || !nonEmpty(id)) {
    const code = tightbeamCodeOf(created);
    finish("failed", { tightbeam_code: code });
    return fail("open_failed", { tightbeam_code: code });
  }
  finish("ok", { conversation_id: id });
  return Object.freeze({ ok: true, conversation_id: id });
}

async function openSlackConversation(ctx, input) {
  const identity = await ctx.safeIdentity();
  if (!identity) return fail("not_configured");
  const opener = await ctx.ensureOpener(identity);
  if (!opener) return fail("opener_unavailable");
  return createConversation(ctx, { identity, opener, input });
}

// Claim, complete, release, reply publish and bridge commit for the Slack
// route. `ctx` is createSlackContext(); `listRoutes` is listSlackRoutes.
export function createSlackDelivery({ ctx, listRoutes }) {
  let capable = false;
  return {
    async claimSlackDelivery() {
      capable = capable || (await deliveryCapabilityAvailable(ctx));
      if (!capable) return fail("delivery_capability_unavailable");
      return claimSlackDelivery(ctx, listRoutes);
    },
    completeSlackDelivery: ({ delivery_id: id, token, outcome }) =>
      deliveryCommand(ctx, {
        name: "complete",
        args: [id, "--token", token, "--outcome", outcome],
        failureCode: "complete_failed",
        params: { delivery_id: id, outcome },
      }),
    releaseSlackDelivery: ({ delivery_id: id, token }) =>
      deliveryCommand(ctx, {
        name: "release",
        args: [id, "--token", token],
        failureCode: "release_failed",
        params: { delivery_id: id },
      }),
    publishSlackReply: (input) => publishSlackReply(ctx, input),
    openSlackConversation: (input) => openSlackConversation(ctx, input),
    commitSlackMessage: (input) => commitSlackMessage(ctx, listRoutes, input),
  };
}
