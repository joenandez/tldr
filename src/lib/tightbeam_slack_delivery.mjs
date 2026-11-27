import {
  commandFailure,
  expectedPreflightArgs,
} from "./tightbeam_channel_runtime.mjs";
import {
  providerReceivedAtIso,
  receivedAtMetadata,
} from "./provider_received_at.mjs";
import { TLDR_AGENT_SLACK_SETTLE_MS } from "./tldr_agent_daemon_phase_timeouts.mjs";
import { commitTarget } from "./tightbeam_slack_commit_target.mjs";
import {
  OK,
  fail,
  leftOf,
  nonEmpty,
  tightbeamCodeOf,
} from "./tightbeam_slack_support.mjs";

async function deliveryCapabilityAvailable(ctx, deadlineAt) {
  const result = await ctx.admin(expectedPreflightArgs(), leftOf(deadlineAt));
  return result?.ok === true && result.result?.compatible === true;
}

const sameIdentity = (a, b) =>
  a?.app_id === b?.app_id && a?.app_secret === b?.app_secret;

async function resolveTarget(ctx, listRoutes, { identity, deadlineAt }) {
  const owner = identity ? await ctx.registerOwner(identity, deadlineAt) : null;
  if (!owner) return fail("not_configured");
  const listed = await listRoutes(deadlineAt);
  const route = listed.ok ? listed.routes[0] : null;
  if (!route) return fail("route_unavailable");
  return { identity, owner, endpointId: owner.endpoint.endpoint_id, route };
}

// `cached` (a target from an earlier claim) is reused while the stored identity is unchanged:
// no owner registration, no route list (ac-jfv.97).
async function claimTarget(
  ctx,
  listRoutes,
  { cached = null, deadlineAt = null } = {},
) {
  const identity = await ctx.safeIdentity();
  return cached && sameIdentity(cached.identity, identity)
    ? cached
    : resolveTarget(ctx, listRoutes, { identity, deadlineAt });
}

// An idle auto-select claim answers claim_held; anything else is a real failure.
function claimFailure(claimed, finish) {
  const code = tightbeamCodeOf(claimed);
  if (code === "claim_held") return fail("claim_unavailable");
  finish("claim_failed", { tightbeam_code: code });
  return fail("claim_failed", { tightbeam_code: code });
}

// Tightbeam answers claim_held for a retired or unknown route id as for an idle one, and still
// hands out a retired route's leftover deliveries, so a cached target is resolved again after
// this long: a route re-created under the same credentials (Slack repair) stalls posts at most
// this long, for one resolve per window.
const TARGET_TTL_MS = 5 * 60_000;

// What earlier claims resolved is dropped on a failed resolve or a claim failure other than
// claim_held (idle), as either may mean the owner, route or authority is stale. The failure then
// says so with cache_reset, and the next claim resolves afresh.
function dropCache(cache, failed, hadTarget) {
  Object.assign(cache, { capable: false, target: null });
  return hadTarget ? { ...failed, cache_reset: 1 } : failed;
}

// The shared deadline of a user-route claim, else the claim's own lease (a hung CLI only).
function claimOptions({ leaseMs, deadlineAt }) {
  if (deadlineAt) return leftOf(deadlineAt);
  return leaseMs ? { timeoutMs: leaseMs } : undefined;
}

async function claimSlackDelivery(
  ctx,
  listRoutes,
  { leaseMs, tier, cache, deadlineAt },
) {
  const cached =
    Date.now() - cache.resolvedAt < TARGET_TTL_MS ? cache.target : null;
  const target = await claimTarget(ctx, listRoutes, { cached, deadlineAt });
  if (target.ok === false) return dropCache(cache, target, cache.target);
  if (target !== cached)
    Object.assign(cache, { target, resolvedAt: Date.now() });
  const finish = ctx.begin("tightbeam_slack_claim");
  const claimed = await ctx.asApp(
    target.identity,
    [
      "delivery",
      "claim",
      "--endpoint",
      target.endpointId,
      "--channel-route",
      target.route.route_id,
      "--accept-reply-binding",
      // Tightbeam's default lease is 60 s; the caller's post deadline can be longer.
      ...(leaseMs ? ["--lease-ms", String(leaseMs)] : []),
      // One tier per lane: 0 notices, 1 answers to the user, 2 the rest. None: all tiers.
      ...(tier === undefined ? [] : ["--tier", String(tier)]),
    ],
    // Only a hung path is killed: the preflight, refresh and this CLI share one deadline, leaseMs
    // after the claim began (ac-jfv.81 r4). A shorter kill would orphan claims it committed (held
    // for the lease, then counted; ac-jfv.59 r6). A commit late in that window can still be
    // orphaned: an accepted trade-off for a CLI that hung that long.
    claimOptions({ leaseMs, deadlineAt }),
  );
  if (commandFailure(claimed)) {
    const failed = claimFailure(claimed, finish);
    return failed.code === "claim_failed"
      ? dropCache(cache, failed, cached)
      : failed;
  }
  finish("claimed", { delivery_id: claimed.result?.delivery_id });
  return Object.freeze({ ok: true, claim: claimed.result });
}

async function deliveryCommand(
  ctx,
  { name, args, failureCode, params, timeoutMs = TLDR_AGENT_SLACK_SETTLE_MS },
) {
  const identity = await ctx.safeIdentity();
  if (!identity) return fail("not_configured");
  const finish = ctx.begin(`tightbeam_slack_${name}`);
  // Bounded inside the claim's lease (deadline + 2 settle), so a hung CLI cannot outlive it.
  const result = await ctx.asApp(identity, ["delivery", name, ...args], {
    timeoutMs,
  });
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

// In process, not the CLI: the reply is the user's own message, on the intake path (ac-wzn7q).
// The payload is what `tightbeam channel reply publish` builds.
async function publishSlackReply(ctx, input) {
  const identity = await ctx.safeIdentity();
  if (!identity) return fail("not_configured");
  const finish = ctx.begin("tightbeam_slack_publish");
  const result = await ctx.request(identity, "channel.reply.publish", {
    reply_binding: input.reply_binding,
    body: input.body,
    external_event_id: input.external_event_id,
    provider_metadata: {
      channel: "slack",
      ...receivedAtMetadata(input.provider_received_at),
    },
  });
  return messageOutcome({ name: "publish", result, finish });
}

// Bridge ingress (messaging/docs/bridge-ingress.md section 2). The process
// generation is the endpoint.register result's process_generation. The Slack
// route as origin gives the agent's default `agent reply` a path back here.
async function commitSlackMessage(ctx, input) {
  const target = await commitTarget(ctx);
  if (target.ok === false) return target;
  const { identity, owner, route } = target;
  const finish = ctx.begin("tightbeam_slack_commit");
  const receivedAt = providerReceivedAtIso(input.provider_received_at);
  // In process; the payload is what `tightbeam message commit --effect none` builds (ac-wzn7q).
  const result = await ctx.request(identity, "message.commit", {
    sender_principal_id: owner.principal.principal_id,
    body: input.body,
    idempotency_key: input.idempotency_key,
    obligation_effect: {
      type: "none",
      sender_endpoint_id: owner.endpoint.endpoint_id,
      process_generation: Number(owner.endpoint.process_generation),
    },
    conversation_id: input.conversation_id,
    origin_channel_route_id: route.route_id,
    // one named session instead of every sibling endpoint of the principal
    ...(input.target_endpoint_id && {
      inbound_target_endpoint_id: input.target_endpoint_id,
    }),
    ...(receivedAt && {
      metadata: { provider_metadata: { provider_received_at: receivedAt } },
    }),
  });
  return messageOutcome({ name: "commit", result, finish });
}

// The endpoint deliveries of one message the app committed: who holds it and how far
// it got. Read-only; the working-indicator sweep decides from it whether the session ended.
async function listSlackDeliveries(ctx, messageId) {
  const identity = await ctx.safeIdentity();
  if (!identity) return fail("not_configured");
  // a hung CLI must not hold the sweep's 35 s phase
  const result = await ctx.asApp(
    identity,
    ["message", "delivery", "list", messageId],
    { timeoutMs: 10_000 },
  );
  if (commandFailure(result))
    return fail("delivery_list_failed", {
      tightbeam_code: tightbeamCodeOf(result),
    });
  return Object.freeze({
    ok: true,
    endpoint_deliveries: result.result?.endpoint_deliveries ?? [],
  });
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
  // Per channel: the daemon keeps one for its outbound ticks, so a steady-state claim is the
  // `delivery claim` call alone (ac-jfv.97).
  const cache = { capable: false, target: null, resolvedAt: 0 };
  return {
    async claimSlackDelivery({ leaseMs, tier } = {}) {
      // One deadline for the whole claim path, started before its first CLI (ac-jfv.81 r4). Only
      // the user-route lanes (tiers 0 and 1) have a phase to hold; the others keep their own bound.
      const deadlineAt =
        leaseMs && (tier === 0 || tier === 1) ? Date.now() + leaseMs : null;
      cache.capable ||= await deliveryCapabilityAvailable(ctx, deadlineAt);
      if (!cache.capable) return fail("delivery_capability_unavailable");
      // shortcut: a refresh that used the whole deadline still starts the claim CLI, killed after 1 ms
      return claimSlackDelivery(ctx, listRoutes, {
        leaseMs,
        tier,
        cache,
        deadlineAt,
      });
    },
    completeSlackDelivery: ({ delivery_id: id, token, outcome, timeoutMs }) =>
      deliveryCommand(ctx, {
        timeoutMs,
        name: "complete",
        args: [id, "--token", token, "--outcome", outcome],
        failureCode: "complete_failed",
        params: { delivery_id: id, outcome },
      }),
    // outcome "aborted_unsent": the claim was cut off before any Slack request (ac-jfv.87).
    releaseSlackDelivery: ({ delivery_id: id, token, outcome, timeoutMs }) =>
      deliveryCommand(ctx, {
        timeoutMs,
        name: "release",
        args: [
          id,
          "--token",
          token,
          ...(outcome ? ["--outcome", outcome] : []),
        ],
        failureCode: "release_failed",
        params: { delivery_id: id },
      }),
    listSlackDeliveries: (messageId) => listSlackDeliveries(ctx, messageId),
    publishSlackReply: (input) => publishSlackReply(ctx, input),
    openSlackConversation: (input) => openSlackConversation(ctx, input),
    commitSlackMessage: (input) => commitSlackMessage(ctx, input),
  };
}
