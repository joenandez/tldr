import { readFileSync } from "node:fs";

import { SlackChannelsError, parseAgentRows } from "./slack_channels_add.mjs";

// Shared --agents-json reader for `slack channels add` (and setup, once switched).
const readSource = (source) =>
  readFileSync(source === "-" ? 0 : source, "utf8");

// --agents-json <file|-> rows, checked in full before any Slack call.
export function readAgentRows(source, read = readSource) {
  const bad = (why) =>
    new SlackChannelsError(
      "SLACK_CHANNELS_USAGE",
      `--agents-json is invalid: ${why}`,
    );
  let text;
  try {
    text = read(source);
  } catch {
    throw bad(`cannot read ${source}.`);
  }
  try {
    return parseAgentRows(JSON.parse(text));
  } catch (error) {
    throw bad(error instanceof SyntaxError ? "not valid JSON." : error.message);
  }
}
