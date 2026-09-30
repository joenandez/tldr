import {
  classifyAgentRun,
  continuationPrompt,
  extractAgentPrompt,
  fallbackFor,
  ensureSessionCaptureArgs,
  readAgentDefaults,
  structuredAgentCommand,
} from "./agent_fallback.mjs";

function classifiedResult(agent, result) {
  return {
    ...result,
    agent_classification: classifyAgentRun(agent, result),
  };
}

function fallbackMetadata({
  primaryAgent,
  fallbackAgent,
  fallbackPolicy,
  primary,
  fallback,
  fallbackMode,
}) {
  return {
    fallback_triggered: Boolean(fallback),
    fallback_policy: fallbackPolicy,
    fallback_mode: fallbackMode || null,
    primary_agent: primaryAgent,
    fallback_agent: fallbackAgent || null,
    selected_agent: fallback ? fallbackAgent : primaryAgent,
    primary_status: primary?.status || null,
    primary_failure_summary:
      primary?.agent_classification?.failure_summary || primary?.error || null,
    primary_raw_error_class:
      primary?.agent_classification?.raw_error_class || null,
    primary_saw_model_tool_call: Boolean(
      primary?.agent_classification?.saw_model_tool_call,
    ),
    fallback_status: fallback?.status || null,
    fallback_failure_summary: fallback?.error || null,
  };
}

export async function launchManagedAgentUntilStartedWithFallback({
  agent,
  command,
  args,
  wrapper = null,
  cwd,
  timeoutSec,
  stdinText,
  extraEnv,
  memoryMode = null,
  onSpawn,
  logPaths,
  startupWindowMs,
  runId = null,
  jobId = null,
  agentExecutionEnv,
  launchAgentUntilStarted,
}) {
  const defaults = readAgentDefaults();
  const fallbackAgent = fallbackFor(agent, defaults);
  const captureArgs = ensureSessionCaptureArgs(agent, args, wrapper);
  const prompt = extractAgentPrompt({ agent, args: captureArgs, stdinText });
  const trackedEnv = agentExecutionEnv(extraEnv);
  const primaryRaw = await launchAgentUntilStarted({
    agent,
    command,
    args: captureArgs,
    cwd,
    timeoutSec,
    stdinText,
    extraEnv: trackedEnv,
    memoryMode,
    onSpawn,
    logPaths,
    startupWindowMs,
    runId,
    jobId,
  });
  const primary = classifiedResult(agent, primaryRaw);
  if (
    primaryRaw.status === "started" ||
    defaults.fallback_policy === "never" ||
    !fallbackAgent ||
    fallbackAgent === agent ||
    !prompt
  ) {
    return {
      ...primaryRaw,
      agent_fallback: fallbackMetadata({
        primaryAgent: agent,
        fallbackAgent: fallbackAgent || null,
        fallbackPolicy: defaults.fallback_policy,
        primary,
        fallback: null,
        fallbackMode:
          !prompt && primaryRaw.status !== "started"
            ? "ineligible:no_prompt"
            : null,
      }),
    };
  }

  const fallbackPrompt = primary.agent_classification?.saw_model_tool_call
    ? continuationPrompt({
        originalPrompt: prompt,
        primaryAgent: agent,
        failureSummary:
          primary.agent_classification?.failure_summary || primary.error,
        stdoutPath: logPaths?.stdout || null,
        stderrPath: logPaths?.stderr || null,
      })
    : prompt;
  const fallbackSpec = structuredAgentCommand(fallbackAgent, fallbackPrompt);
  if (!fallbackSpec) {
    return {
      ...primary,
      agent_fallback: {
        ...fallbackMetadata({
          primaryAgent: agent,
          fallbackAgent,
          fallbackPolicy: defaults.fallback_policy,
          primary,
          fallback: null,
        }),
        fallback_mode: "ineligible:no_structured_command",
      },
    };
  }
  const fallbackRaw = await launchAgentUntilStarted({
    agent: fallbackAgent,
    command: fallbackSpec.command,
    args: fallbackSpec.args,
    cwd,
    timeoutSec,
    stdinText: null,
    extraEnv: agentExecutionEnv(trackedEnv),
    memoryMode,
    onSpawn,
    logPaths,
    startupWindowMs,
    runId,
    jobId,
  });
  return {
    ...fallbackRaw,
    agent_fallback: fallbackMetadata({
      primaryAgent: agent,
      fallbackAgent,
      fallbackPolicy: defaults.fallback_policy,
      primary,
      fallback: fallbackRaw,
      fallbackMode: primary.agent_classification?.saw_model_tool_call
        ? "continuation"
        : "replay",
    }),
  };
}
