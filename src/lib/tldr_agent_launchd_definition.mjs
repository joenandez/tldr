import { dirname, join } from "node:path";

export function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderTldrAgentProductionPlist({
  schedulerScriptPath,
  home,
  statusPort,
  nodePath = process.execPath,
}) {
  const daemonScript = join(dirname(schedulerScriptPath), "helm-daemon.mjs");
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>ai.tldr-agent.daemon</string>
<key>ProgramArguments</key><array>
<string>${xmlEscape(nodePath)}</string><string>${xmlEscape(daemonScript)}</string>
</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>EnvironmentVariables</key><dict>
<key>TLDR_AGENT_HOME</key><string>${xmlEscape(home)}</string>
<key>HELM_HOME</key><string>${xmlEscape(home)}</string>
<key>TLDR_AGENT_DAEMON_MODE</key><string>poll-only</string>
<key>HELM_CANONICAL_SQLITE</key><string>1</string>
<key>HELM_STATUS_PORT</key><string>${statusPort}</string>
</dict>
<key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
  `;
}
