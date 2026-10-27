export { decodeCopilotHookInput } from "./copilot_hook_input.mjs";

class CopilotHookError extends Error {}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function encodeCopilotHookEffect({ event, effect }) {
  if (!isObject(effect) || typeof effect.content !== "string")
    throw new CopilotHookError("Copilot hook effect content must be a string");
  const fields = {
    "sessionStart:startup-context": "additionalContext",
    "userPromptSubmitted:user-prompt": "modifiedPrompt",
    "postToolUse:tool-result": "additionalContext",
  };
  const output = fields[`${event}:${effect.authority}`];
  if (!output)
    throw new CopilotHookError(
      `unsupported required ${effect.authority ?? "unknown"} effect for copilot:${event}`,
    );
  return { [output]: effect.content };
}

export function writeCopilotOutput(stream, effect, commit = () => {}) {
  const line = `${JSON.stringify(effect)}\n`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => stream.removeListener("error", onError);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) {
        // Writable reports callback failures before emitting its matching error.
        setImmediate(cleanup);
        reject(error);
      } else {
        cleanup();
        try {
          commit();
          resolve();
        } catch (commitError) {
          reject(commitError);
        }
      }
    };
    const onError = (error) => finish(error);
    stream.once("error", onError);
    try {
      stream.write(line, finish);
    } catch (error) {
      finish(error);
    }
  });
}
