const DIAGNOSTIC_MARKER = '[🪳 TEMP tachyon-agent-pane-hook-lifecycle]';

export const REPLY_CONTINUITY_OUTCOMES = Object.freeze([
  'obligation_created',
  'no_obligation',
  'noninteractive_bypass',
  'unarmed_generation',
  'reply_pending_before_stop',
  'parked',
  'reply_delivered',
  'reply_presented',
  'acked',
  'deadline',
  'disconnect',
  'fallback',
]);

const OUTCOMES = new Set(REPLY_CONTINUITY_OUTCOMES);

function diagnosticsEnabled() {
  return process.env.TIGHTBEAM_TACHYON_REPLY_DIAGNOSTICS === '1';
}

function safeParams({ count, latency_ms, live } = {}) {
  const params = {};
  if (Number.isSafeInteger(count) && count >= 0 && count <= 100) params.count = count;
  if (Number.isSafeInteger(latency_ms) && latency_ms >= 0 && latency_ms <= 86_400_000) params.latency_ms = latency_ms;
  if (typeof live === 'boolean') params.live = live;
  return params;
}

export function replyContinuityDiagnostic(logger, outcome, fields) {
  if (!diagnosticsEnabled() || !OUTCOMES.has(outcome)) return false;
  logger?.info({ event: `${DIAGNOSTIC_MARKER} ${outcome}`, params: safeParams(fields), status: 'ok' });
  return true;
}
