import { helmHome, resolveTldrAgentScope } from "./store.mjs";

// tldr; has no retained Helm equivalent for this command boundary: the
// poll-only daemon must reconstruct the one fixed scope without a registry.
export function resolveDaemonCommandScope({
  cwd = process.cwd(),
  environment: _environment = process.env,
  tldrAgentHome = helmHome(),
} = {}) {
  return resolveTldrAgentScope({ cwd, tldrAgentHome });
}
