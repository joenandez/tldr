import isOnline from 'is-online';
import isReachable from 'is-reachable';

const DEFAULT_TIMEOUT_MS = 3000;

// Provider → host:port used when a job has preconditions.network = true but no
// explicit network_host. Probes what the job actually needs to reach rather
// than "is the internet abstractly up."
export const PROVIDER_HOST_MAP = {
  claude: 'api.anthropic.com:443',
  codex: 'api.openai.com:443',
  gemini: 'generativelanguage.googleapis.com:443',
  droid: 'api.factory.ai:443',
};

export function providerHostFor(provider) {
  if (!provider || typeof provider !== 'string') return null;
  return PROVIDER_HOST_MAP[provider.toLowerCase()] || null;
}

// probeNetwork returns { online, source?, reason?, host?, hosts? }.
//
// - No hosts arg → generic internet probe via is-online (HTTPS + DNS + Apple
//   captive portal check, four cross-protocol targets under Promise.any).
// - hosts: [host] or [host:port] → targeted reachability via is-reachable
//   (HEAD for http(s) URLs, raw TCP for bare host:port). Bare IPs are safe —
//   neither library short-circuits IP literals the way the stdlib resolver did.
//
// HELM_FAKE_NETWORK_PROBE=online|offline forces the result (for tests).
export async function probeNetwork({ hosts, timeoutMs } = {}) {
  const fake = process.env.HELM_FAKE_NETWORK_PROBE;
  if (fake === 'online') return { online: true, source: 'fake' };
  if (fake === 'offline') return { online: false, source: 'fake', reason: 'fake_offline' };

  const t = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

  if (Array.isArray(hosts) && hosts.length > 0) {
    const target = String(hosts[0]);
    try {
      const reachable = await isReachable(target, { timeout: t });
      if (reachable) return { online: true, source: 'is-reachable', host: target };
      return { online: false, source: 'is-reachable', host: target, reason: `host_unreachable:${target}` };
    } catch (err) {
      return { online: false, source: 'is-reachable', host: target, reason: summarize(err) };
    }
  }

  try {
    const online = await isOnline({ timeout: t });
    return online
      ? { online: true, source: 'is-online' }
      : { online: false, source: 'is-online', reason: 'all_probes_failed' };
  } catch (err) {
    return { online: false, source: 'is-online', reason: summarize(err) };
  }
}

function summarize(err) {
  if (err && Array.isArray(err.errors) && err.errors.length > 0) {
    return err.errors.map(e => String(e?.message || e)).slice(0, 3).join('; ');
  }
  return String(err?.message || err);
}
