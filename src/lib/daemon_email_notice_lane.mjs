import { resolveInboxTarget } from "./daemon_inbox_poll_phase.mjs";
import { createSkipWarner } from "./daemon_lane_skip_warn.mjs";
import { createWatermarkWakeLane } from "./daemon_urgent_wake.mjs";
import { createWarmNoticeChild } from "./email_notice_warm_child.mjs";
import { tldrAgentEmailNoticeKillMs } from "./tldr_agent_daemon_phase_timeouts.mjs";

// The event of a tick, or null for an idle one (never logged). A failed request or drain is
// `failed` (its error), with the child's reason and counts.
function tickEvent(target, reply, latency_ms) {
  const outbound = reply.outbound ?? null;
  const base = {
    scope_id: target.targetScope.scope_id,
    cwd: target.targetScope.cwd,
  };
  if (!reply.ok || outbound?.ok === false) {
    const error = reply.ok ? outbound.error : (reply.message ?? reply.error);
    return {
      event_type: "daemon_email_notice_tick_failed",
      failed: reply.error ?? outbound?.error,
      extra: {
        ...base,
        metadata: {
          error,
          reason: reply.ok ? null : reply.error,
          attempted: outbound?.attempted ?? 0,
          failed: outbound?.failed ?? 0,
          ...(outbound?.cause ? { cause: outbound.cause } : {}),
          ...outbound?.timings,
          latency_ms,
        },
      },
    };
  }
  if (!outbound?.attempted) return null;
  return {
    event_type: "daemon_email_notice_tick",
    extra: {
      ...base,
      metadata: {
        ok: true,
        attempted: outbound.attempted,
        delivered: outbound.delivered ?? 0,
        failed: outbound.failed ?? 0,
        released: outbound.released ?? 0,
        ...outbound.timings,
        latency_ms,
      },
    },
  };
}

// The notice email lane (tier 0, ac-jfv.74.1): a busy or resume_failed notice must reach the user
// within 2:15 of the message, and a cold drain child measured 8-11 s from staged to claimed at
// load 100. So this lane keeps ONE warm child (email_notice_warm_child.mjs): a wake is one claim
// CLI call plus the send. It wakes on the user-route watermark (or its 30 s fallback), one tick at
// a time; the child claims `--tier 0` until claim_held and sends up to 4 notices at once. Only a
// non-idle tick is logged, with claim_ms, send_ms and total_ms.
//
// The lane polls always and checks per tick that email is connected, so an inbox connected while
// the daemon runs is picked up (and the child started then). Its end (daemon stop, or --once)
// kills the child with its process group, after the tick in flight.
export function createEmailNoticeLane({
  once,
  isStopped,
  homeExists,
  home,
  waitFn,
  now,
  pollMs,
  fallbackMs,
  watermarkPath,
  daemonInstanceId,
  appendActivityEvent,
  scopes,
  defaultEmailConfigPath,
  readEmailConfig,
  pollOnly,
  readTldrAgentPollConfig,
  warm: warmOverride,
}) {
  const emit = (event_type, extra = {}) => {
    try {
      appendActivityEvent(
        { event_type, daemon_instance_id: daemonInstanceId, ...extra },
        { home },
      );
    } catch {
      // Logging is best effort.
    }
  };
  const record = (status, extra = {}) =>
    emit("daemon_email_notice_lane", { status, ...extra });
  const warnSkip = createSkipWarner({ lane: "notice", record });
  const warm =
    warmOverride ??
    createWarmNoticeChild({
      log: (entry) => record("info", { metadata: entry }),
    });

  async function tick(wake) {
    const target = resolveInboxTarget({
      scopes,
      daemonInstanceId,
      defaultEmailConfigPath,
      readEmailConfig,
      appendActivityEvent,
      pollOnly,
      readTldrAgentPollConfig,
    });
    if (target.skip) return warnSkip(target.skip);
    const startedAt = Date.now();
    const reply = await warm.request({
      wake,
      timeoutMs: tldrAgentEmailNoticeKillMs(),
    });
    const logged = tickEvent(target, reply, Date.now() - startedAt);
    if (logged) {
      if (logged.failed)
        process.stderr.write(
          `tldr daemon email notice tick failed: ${logged.failed}\n`,
        );
      emit(logged.event_type, logged.extra);
    }
    return undefined;
  }

  const wake = createWatermarkWakeLane({
    once,
    isStopped,
    homeExists,
    home,
    waitFn,
    now,
    pollMs,
    fallbackMs,
    watermarkPath,
    tick,
  });
  return async () => {
    record("started");
    try {
      await wake();
    } finally {
      await warm.stop();
      record("stopped");
    }
  };
}
