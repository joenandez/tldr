import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const MID_SESSION_INJECT_TEMPLATE = readFileSync(
  join(__dirname, "mid_session_inject.tmpl"),
  "utf8",
);

const PLACEHOLDERS = ["thread_id", "tldr_agent_cmd", "body"];

function promptValue(value, fallback) {
  return value === null || value === undefined || value === ""
    ? fallback
    : String(value);
}

export function renderReplyDeliveryPrompt(values = {}) {
  const replacements = {
    thread_id: promptValue(values.thread_id, "(unknown thread)"),
    tldr_agent_cmd: promptValue(values.tldr_agent_cmd, "tldr-agent"),
    body: promptValue(values.body, "(empty reply)"),
  };
  let out = MID_SESSION_INJECT_TEMPLATE;
  for (const key of PLACEHOLDERS) {
    out = out.replaceAll(`{${key}}`, replacements[key]);
  }
  return out;
}

export const renderMidSessionInject = renderReplyDeliveryPrompt;
