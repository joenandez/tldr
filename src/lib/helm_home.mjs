import { homedir } from "node:os";
import { join } from "node:path";

export function getHelmHome() {
  return process.env.TLDR_AGENT_HOME || join(homedir(), ".tldr-agent");
}
