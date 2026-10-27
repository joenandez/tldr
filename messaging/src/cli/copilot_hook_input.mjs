import {
  configuredView,
  hasChildFields,
  rejectContradictedIdentity,
} from "./copilot_configured_input.mjs";

class CopilotHookError extends Error {}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERBS = Object.freeze({
  "session-start": "sessionStart",
  "user-prompt-submit": "userPromptSubmitted",
  "post-tool-use": "postToolUse",
});
const STREAM_EVENTS = new Set([
  "session.start",
  "user.message",
  "assistant.message",
  "subagent.started",
  "subagent.completed",
  "session.shutdown",
]);
const FIELD_NAMES = [
  ["agentId", "agent_id"],
  ["parentAgentId", "parent_agent_id"],
  ["interactionId", "interaction_id"],
  ["messageId", "message_id"],
  ["originatingMessageId", "originating_message_id"],
  ["toolCallId", "tool_call_id"],
  ["parentToolCallId", "parent_tool_call_id"],
  ["timestamp", "timestamp"],
];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function uuid(value, event) {
  if (typeof value !== "string" || !UUID.test(value))
    throw new CopilotHookError(
      `Copilot ${event} requires its actual UUID sessionId`,
    );
  return value;
}

function hookContext(verb, view) {
  const expectedEvent = VERBS[verb];
  const streamEvent = STREAM_EVENTS.has(view.type);
  if (streamEvent && view.hook_event_name !== undefined)
    throw new CopilotHookError(
      `Copilot configured callback cannot carry stream event ${view.type}`,
    );
  const data = streamEvent && isObject(view.data) ? view.data : {};
  const event = streamEvent ? view.type : expectedEvent;
  const child =
    hasChildFields(view) ||
    data.agentId !== undefined ||
    event.startsWith("subagent.");
  const sessionId =
    view.sessionId ?? (event === "session.start" ? data.sessionId : undefined);
  rejectContradictedIdentity(view, { child, sessionId, event });
  return { verb, streamEvent, data, event, child, sessionId };
}

function validatePrompt({ verb, streamEvent, child }, body) {
  if (!streamEvent && !child && verb === "user-prompt-submit") {
    if (typeof body.prompt !== "string")
      throw new CopilotHookError(
        "Copilot userPromptSubmitted requires prompt to be a string",
      );
  }
}

function copyFields(target, source) {
  for (const [sourceKey, targetKey] of FIELD_NAMES)
    if (source[sourceKey] !== undefined) target[targetKey] = source[sourceKey];
}

function addStreamFields(payload, body, data) {
  copyFields(payload, data);
  if (body.timestamp !== undefined) payload.timestamp = body.timestamp;
  if (body.id !== undefined) payload.event_id = body.id;
  if (body.parentId !== undefined) payload.parent_event_id = body.parentId;
  if (Array.isArray(data.toolRequests))
    payload.tool_call_ids = data.toolRequests
      .map((row) => row?.toolCallId)
      .filter((id) => typeof id === "string");
}

function addToolFields(payload, body, data) {
  const fields = [
    ["toolName", "tool_name"],
    ["toolArgs", "tool_input"],
    ["toolResult", "tool_response"],
  ];
  for (const [sourceKey, targetKey] of fields) {
    const value =
      body[sourceKey] === undefined ? data[sourceKey] : body[sourceKey];
    if (value !== undefined) payload[targetKey] = value;
  }
}

function addProviderFields(payload, body) {
  const fields = [
    ["rootSessionId", "root_session_id"],
    ["parentSessionId", "parent_session_id"],
    ["transcriptPath", "transcript_path"],
  ];
  for (const [sourceKey, targetKey] of fields)
    if (body[sourceKey] !== undefined) payload[targetKey] = body[sourceKey];
}

function makePayload(context, body, view) {
  const { streamEvent, data, event, child, sessionId } = context;
  const payload = { ...body };
  if (sessionId !== undefined) payload.session_id = uuid(sessionId, event);
  if (event === "session.start" && payload.cwd === undefined)
    payload.cwd = data.context?.cwd;
  if (
    body.cwd === undefined &&
    event === "session.start" &&
    data.context?.cwd !== undefined
  )
    payload.cwd = data.context.cwd;

  if (streamEvent) addStreamFields(payload, body, data);
  else copyFields(payload, view);
  if (body.cwd !== undefined) payload.cwd = body.cwd;
  const originalPrompt = body.prompt ?? data.content;
  if (originalPrompt !== undefined) payload.prompt = originalPrompt;
  addToolFields(payload, view, data);
  addProviderFields(payload, view);
  if (!child && !streamEvent && sessionId === undefined)
    throw new CopilotHookError(
      `Copilot ${event} callback is missing sessionId`,
    );
  return { payload, originalPrompt };
}

export function decodeCopilotHookInput(verb, body) {
  if (!isObject(body))
    throw new CopilotHookError("Copilot hook payload must be a JSON object");
  if (!VERBS[verb])
    throw new CopilotHookError(`Copilot does not support hook verb ${verb}`);
  const view = configuredView(verb, VERBS[verb], body);
  const context = hookContext(verb, view);
  validatePrompt(context, body);
  const { payload, originalPrompt } = makePayload(context, body, view);
  const { event, streamEvent, child, sessionId } = context;
  return {
    event,
    streamEvent,
    child,
    body,
    sessionId: sessionId === undefined ? undefined : uuid(sessionId, event),
    originalPrompt,
    payload,
  };
}
