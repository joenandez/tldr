import { spawn } from "node:child_process";

const FIXED_INBOUND_BRIDGE =
  "/Library/Application Support/Codename/Aegis/TldrAgentAegis.app/Contents/MacOS/TldrAgentAegisSetup";

export function spawnAegisInboundBridge() {
  return spawn(FIXED_INBOUND_BRIDGE, ["--inbound-bridge"], {
    env: {},
    stdio: ["pipe", "pipe", "pipe"],
  });
}
