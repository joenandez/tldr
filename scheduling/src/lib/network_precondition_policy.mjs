const NETWORK_PRECONDITION_BYPASS_JOB_IDS = new Set([
  "helm-daemon-hourly-canary",
]);

export function bypassesNetworkPrecondition(job) {
  return NETWORK_PRECONDITION_BYPASS_JOB_IDS.has(job?.id);
}
