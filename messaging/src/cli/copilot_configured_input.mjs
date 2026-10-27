import path from "node:path";

class CopilotHookError extends Error {}

// Configured plugin hooks (`--plugin-dir`) deliver snake_case stdin named by
// a PascalCase hook_event_name with an ISO timestamp; legacy callbacks use
// camelCase. Both decode onto the same camel view before any identity use.
const CONFIGURED_EVENTS = Object.freeze({
  SessionStart: "sessionStart",
  UserPromptSubmit: "userPromptSubmitted",
  PostToolUse: "postToolUse",
});
const IDENTITY_FIELDS = [
  ["sessionId", "session_id"],
  ["agentId", "agent_id"],
  ["parentAgentId", "parent_agent_id"],
];
const CONFIGURED_FIELDS = [
  ...IDENTITY_FIELDS,
  ["toolName", "tool_name"],
  ["toolArgs", "tool_input"],
  ["toolResult", "tool_result"],
  ["transcriptPath", "transcript_path"],
];
const CHILD_FIELDS = ["agentId", "parentAgentId", "agent_type"];

function rejectConflicts(body, fields) {
  for (const [camel, snake] of fields)
    if (
      body[camel] !== undefined &&
      body[snake] !== undefined &&
      body[camel] !== body[snake]
    )
      throw new CopilotHookError(
        `conflicting Copilot ${camel} and ${snake} in one callback`,
      );
}

// The camel view of one callback. Configured input maps onto the legacy
// names only once its event, identity pairs and timestamp agree.
export function configuredView(verb, expectedEvent, body) {
  rejectConflicts(body, IDENTITY_FIELDS);
  if (body.hook_event_name === undefined) return body;
  if (CONFIGURED_EVENTS[body.hook_event_name] !== expectedEvent)
    throw new CopilotHookError(
      `Copilot ${body.hook_event_name} callback does not match hook verb ${verb}`,
    );
  rejectConflicts(body, CONFIGURED_FIELDS);
  const view = { ...body };
  for (const [camel, snake] of CONFIGURED_FIELDS)
    if (body[snake] !== undefined) view[camel] = body[snake];
  if (body.timestamp !== undefined) {
    view.timestamp =
      typeof body.timestamp === "string" ? Date.parse(body.timestamp) : NaN;
    if (Number.isNaN(view.timestamp))
      throw new CopilotHookError(
        `Copilot ${body.hook_event_name} timestamp must be an ISO string`,
      );
  }
  return view;
}

export function hasChildFields(view) {
  return CHILD_FIELDS.some((field) => view[field] !== undefined);
}

// Identity a callback contradicts by itself: a session named as its own
// parent, or a configured root callback without its absolute cwd.
export function rejectContradictedIdentity(view, { child, sessionId, event }) {
  if (view.parentAgentId !== undefined && view.parentAgentId === sessionId)
    throw new CopilotHookError(
      `conflicting Copilot ${event} identity: parent agent equals its own session`,
    );
  if (view.hook_event_name === undefined || child) return;
  if (typeof view.cwd !== "string" || !path.isAbsolute(view.cwd))
    throw new CopilotHookError(`Copilot ${event} requires its absolute cwd`);
}
