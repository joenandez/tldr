#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { observeAriadneToolUse } from "../../src/lib/tldr_agent_ariadne.mjs";

const sessionId = process.argv[2] || null;
let hookInput = null;
try {
  hookInput = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

try {
  observeAriadneToolUse({ sessionId, hookInput });
} catch {
  // PostToolUse must remain fail-open if local candidate state is unavailable.
}
