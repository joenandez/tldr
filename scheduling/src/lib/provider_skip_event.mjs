// provider_skip_event — a provider run's documented "skipped on purpose" line.
//
// A provider (Academy) may decide not to start a model session at all: its run
// lock is busy, the user is in a live session with the agent, a heartbeat fired
// outside owner hours, a nightly has no new input. Without a way to say so, that
// run looks exactly like a launch that failed before its session started, and
// the fallback policy starts a second agent next to the work the skip was
// protecting.
//
// The contract (tldr <-> Academy provider-run outcome contract, C1): the
// provider prints exactly one JSON line on stdout and exits 0:
//
//   {"type":"helm.skip","version":1,"source":"academy","reason":"<code>",
//    "agent":"<name>","job_id":"<HELM_JOB_ID>"}
//
// The line only counts when no session id was seen and the process exited 0;
// callers enforce that. This module only recognizes the line. Unknown `type`
// values and unknown fields are ignored, and unknown reason codes are accepted,
// so a provider can add codes without a Helm release.

const SKIP_TYPE = "helm.skip";
const SKIP_VERSION = 1;
const REASON_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const LABEL_MAX = 128;

function optionalLabel(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, LABEL_MAX);
}

/**
 * Find the provider's skip event in captured stdout.
 *
 * @param {string} stdout captured stdout of the run
 * @param {{jobId?: string|null}} [opts] the run's job id; a line naming another
 *   job is not this run's skip and is ignored
 * @returns {{reason: string, source: string|null, agent: string|null,
 *   job_id: string|null, version: number}|null}
 */
export function parseHelmSkipEvent(stdout, { jobId = null } = {}) {
  if (typeof stdout !== "string" || !stdout.includes(SKIP_TYPE)) return null;
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{") || !line.includes(SKIP_TYPE)) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    if (parsed.type !== SKIP_TYPE || parsed.version !== SKIP_VERSION) continue;
    if (
      typeof parsed.reason !== "string" ||
      !REASON_PATTERN.test(parsed.reason)
    ) {
      continue;
    }
    const lineJobId = optionalLabel(parsed.job_id);
    if (jobId && lineJobId && lineJobId !== jobId) continue;
    return {
      reason: parsed.reason,
      source: optionalLabel(parsed.source),
      agent: optionalLabel(parsed.agent),
      job_id: lineJobId,
      version: SKIP_VERSION,
    };
  }
  return null;
}

// The process ended before any session id appeared. Exit 0 with the
// provider's documented helm.skip line is an intentional skip: an outcome, not
// a failed start, so no fallback runs. Anything else is still a failed start.
export function exitBeforeSessionResult({ agent, code, stdout, jobId }) {
  if (code === 0) {
    const skip = parseHelmSkipEvent(stdout, { jobId });
    if (skip) {
      process.stderr.write(
        `[helm provider-skip] job=${jobId || "unknown"} agent=${agent} reason=${skip.reason} source=${skip.source || "unknown"}\n`,
      );
      return {
        status: "skipped",
        session_id: null,
        signal_source: "provider_skip",
        error: null,
        exit_code: 0,
        skip,
      };
    }
  }
  return {
    status: "failure",
    session_id: null,
    signal_source: "process_exit_before_session",
    error:
      code === 0
        ? `missing_agent_session_id: ${agent} completed without a captured session_id`
        : `exit_code_${code}`,
  };
}
