import { join } from "node:path";
import { HELM_LAUNCHD_LABELS } from "./tldr_agent_product_removal.mjs";
import { SOURCE_ROOT } from "./tldr_agent_source_plist.mjs";

const HELM_SERVICE_START_TIMEOUT_MS = 45_000;
const HELM_SERVICE_POLL_INTERVAL_MS = 1_000;

// launchctl often reports a freshly bootstrapped service before the
// ThrottleInterval restart loop has settled, so the source lifecycle
// waits across the retained service window before accepting Helm.
export async function waitForHelmLaunchdServices({
  commandRunner,
  nodePath,
  now,
  sleep,
  log,
}) {
  const deadline = now() + HELM_SERVICE_START_TIMEOUT_MS;
  for (const { label, script } of HELM_LAUNCHD_LABELS) {
    const target = `gui/${process.getuid()}/${label}`;
    const expectedScript = join(SOURCE_ROOT, script);
    const startedAt = now();
    let attempts = 0;
    for (;;) {
      attempts += 1;
      const status = commandRunner("launchctl", ["print", target], {
        encoding: "utf8",
      });
      const output = `${status?.stdout || ""}${status?.stderr || ""}`;
      const running =
        Number(status?.status ?? 1) === 0 &&
        /state = running\b/u.test(output) &&
        /pid = [1-9]\d*\b/u.test(output);
      if (
        running &&
        output.includes(nodePath) &&
        output.includes(expectedScript)
      ) {
        if (attempts > 1) {
          log("info", "helm_service_start_waited", {
            label,
            attempts,
            latency_ms: now() - startedAt,
          });
        }
        break;
      }
      if (now() >= deadline) {
        log("error", "helm_service_start_timeout", {
          label,
          attempts,
          running,
          latency_ms: now() - startedAt,
        });
        throw new Error(
          `Helm launchd service ${label} is not running from the active source and packaged Node`,
        );
      }
      // eslint-disable-next-line no-await-in-loop -- launchd restart polling is sequential.
      await sleep(HELM_SERVICE_POLL_INTERVAL_MS);
    }
  }
}
