#!/usr/bin/env node
import { recordUserPromptSubmitForTachyon } from "../../src/lib/tachyon_eligibility.mjs";

const sessionId = process.argv[2];
if (sessionId) {
  recordUserPromptSubmitForTachyon({ sessionId });
}
