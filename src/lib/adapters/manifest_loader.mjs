import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { expandArgv, expandTemplate } from "./template.mjs";
import {
  mintSessionId,
  parseCapturedSessionId,
  resolveSidecarDiff,
} from "./capture.mjs";

const VALID_CAPTURE_STRATEGIES = new Set(["stdout_parse", "sidecar_diff"]);
const VALID_PARSE_FORMATS = new Set(["json", "jsonl", "regex"]);
const SESSION_ID_TOKEN_RE = /\{\{\s*session_id(\s*\|[^}]*)?\s*\}\}/;

function containsSessionIdToken(value) {
  return typeof value === "string" && SESSION_ID_TOKEN_RE.test(value);
}

function validateSessionIdBlock(sid) {
  if (!sid || typeof sid !== "object") {
    throw new Error("manifest: session_id block required");
  }
  const hasMintable = sid.mintable === true;
  const hasCapture = sid.capture && typeof sid.capture === "object";
  if (!hasMintable && !hasCapture) {
    throw new Error(
      "manifest: session_id must declare mintable:true or capture",
    );
  }
  if (hasCapture) {
    const strategy = sid.capture.strategy;
    if (
      typeof strategy !== "string" ||
      !VALID_CAPTURE_STRATEGIES.has(strategy)
    ) {
      throw new Error(
        `manifest: capture.strategy must be one of [${[...VALID_CAPTURE_STRATEGIES].join("|")}]; got ${JSON.stringify(strategy)}`,
      );
    }
    if (strategy === "stdout_parse") {
      if (!VALID_PARSE_FORMATS.has(sid.capture.parse)) {
        throw new Error(
          `manifest: capture.parse must be one of [${[...VALID_PARSE_FORMATS].join("|")}]`,
        );
      }
      if (
        sid.capture.parse === "regex" &&
        typeof sid.capture.pattern !== "string"
      ) {
        throw new Error("manifest: capture.pattern required for regex parse");
      }
      if (
        sid.capture.parse !== "regex" &&
        typeof sid.capture.path !== "string"
      ) {
        throw new Error("manifest: capture.path required for json/jsonl parse");
      }
    }
    if (strategy === "sidecar_diff") {
      if (
        !sid.capture.snapshot ||
        !Array.isArray(sid.capture.snapshot.argv) ||
        !sid.capture.snapshot.argv.length
      ) {
        throw new Error(
          "manifest: capture.snapshot.argv required for sidecar_diff",
        );
      }
      if (typeof sid.capture.snapshot.id_path !== "string") {
        throw new Error(
          "manifest: capture.snapshot.id_path required for sidecar_diff",
        );
      }
    }
  }
}

function validateNoSessionIdLeakInCommand(doc) {
  const offenders = [];
  for (const entry of doc.command.argv) {
    if (containsSessionIdToken(entry))
      offenders.push(`argv[${doc.command.argv.indexOf(entry)}]`);
  }
  if (doc.command.env && typeof doc.command.env === "object") {
    for (const [k, v] of Object.entries(doc.command.env)) {
      if (containsSessionIdToken(String(v))) offenders.push(`env.${k}`);
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `manifest: {{session_id}} is only allowed in mintable adapters; found in non-mintable fields: ${offenders.join(", ")}`,
    );
  }
}

function validateVariantBlock(name, variant) {
  if (!variant || typeof variant !== "object" || Array.isArray(variant)) {
    throw new Error(`manifest: variants.${name} must be an object`);
  }
  if (variant.command !== undefined) {
    if (
      !variant.command ||
      !Array.isArray(variant.command.argv) ||
      variant.command.argv.length === 0
    ) {
      throw new Error(`manifest: variants.${name}.command.argv required`);
    }
  }
  if (variant.session_id !== undefined) {
    validateSessionIdBlock(variant.session_id);
  }
}

function validateManifest(doc) {
  if (!doc || typeof doc !== "object")
    throw new Error("manifest: not an object");
  if (typeof doc.name !== "string" || !doc.name)
    throw new Error("manifest: missing name");
  if (doc.version === undefined) throw new Error("manifest: missing version");
  if (
    !doc.command ||
    !Array.isArray(doc.command.argv) ||
    doc.command.argv.length === 0
  ) {
    throw new Error("manifest: command.argv required");
  }
  validateSessionIdBlock(doc.session_id);
  if (doc.session_id.mintable !== true) {
    validateNoSessionIdLeakInCommand(doc);
  }
  if (!doc.resume || typeof doc.resume.command !== "string") {
    throw new Error("manifest: resume.command required");
  }
  if (
    doc.resume.argv !== undefined &&
    (!Array.isArray(doc.resume.argv) || doc.resume.argv.length === 0)
  ) {
    throw new Error("manifest: resume.argv must be a non-empty array");
  }
  if (
    doc.resume.stdin !== undefined &&
    doc.resume.stdin !== "generated_brief"
  ) {
    throw new Error("manifest: resume.stdin must be generated_brief");
  }
  if (
    doc.resume.structured_output !== undefined &&
    typeof doc.resume.structured_output !== "boolean"
  ) {
    throw new Error("manifest: resume.structured_output must be boolean");
  }
  if (
    doc.capabilities !== undefined &&
    (!doc.capabilities ||
      typeof doc.capabilities !== "object" ||
      Array.isArray(doc.capabilities))
  ) {
    throw new Error("manifest: capabilities must be an object");
  }
  if (
    doc.timeouts !== undefined &&
    (!doc.timeouts ||
      typeof doc.timeouts !== "object" ||
      Array.isArray(doc.timeouts))
  ) {
    throw new Error("manifest: timeouts must be an object");
  }
  for (const [key, value] of Object.entries(doc.timeouts || {})) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`manifest: timeouts.${key} must be a positive integer`);
    }
  }
  if (doc.provider_version !== undefined) {
    if (
      !doc.provider_version ||
      typeof doc.provider_version !== "object" ||
      !Array.isArray(doc.provider_version.argv) ||
      doc.provider_version.argv.length === 0
    ) {
      throw new Error(
        "manifest: provider_version.argv required when provider_version is declared",
      );
    }
  }
  if (doc.variants !== undefined) {
    if (
      !doc.variants ||
      typeof doc.variants !== "object" ||
      Array.isArray(doc.variants)
    ) {
      throw new Error("manifest: variants must be an object");
    }
    for (const [name, variant] of Object.entries(doc.variants)) {
      validateVariantBlock(name, variant);
    }
  }
}

function resolveJobCwd(job) {
  return job?.process?.cwd || job?.cwd || "";
}

function resolveProviderConfig(job) {
  const config = job?.execution_hints?.provider_config;
  return config && typeof config === "object" && !Array.isArray(config)
    ? config
    : {};
}

function buildExpansionCtx({ job, run, prompt, model, sessionId }) {
  return {
    prompt: prompt ?? "",
    session_id: sessionId ?? "",
    model: model ?? null,
    env: process.env,
    provider_config: resolveProviderConfig(job),
    job: { cwd: resolveJobCwd(job), id: job?.id ?? "" },
    run: { id: run?.run_id ?? "" },
  };
}

function selectVariant(doc, job) {
  const runtime = resolveProviderConfig(job).academy_runtime;
  return runtime && doc.variants?.[runtime] ? doc.variants[runtime] : null;
}

function resolveCommandSpec(doc, variant) {
  return variant?.command || doc.command;
}

function resolveSessionIdSpec(doc, variant) {
  return variant?.session_id || doc.session_id;
}

function compilePrepare(doc) {
  return function prepare({ job, run, prompt, model } = {}) {
    const variant = selectVariant(doc, job);
    const command = resolveCommandSpec(doc, variant);
    const sid = resolveSessionIdSpec(doc, variant);
    const sessionId = sid.mintable === true ? mintSessionId() : null;
    const ctx = buildExpansionCtx({ job, run, prompt, model, sessionId });
    const argv = expandArgv(command.argv, ctx);
    const env = {};
    if (command.env && typeof command.env === "object") {
      for (const [k, v] of Object.entries(command.env)) {
        env[k] = expandTemplate(String(v), ctx);
      }
    }
    return {
      argv,
      env,
      stdin: null,
      injected_via: "user_prompt_prefix",
      session_id: sessionId,
      run_id: run?.run_id || null,
      strategy: sid.mintable ? "external_mint" : sid.capture.strategy,
      session_id_spec: sid,
      sidecar:
        sid.capture && sid.capture.strategy === "sidecar_diff"
          ? sid.capture
          : null,
    };
  };
}

function compileFinalize(doc) {
  return function finalize(
    {
      prepared,
      stdout = "",
      stderr = "",
      sidecarBefore = null,
      sidecarAfter = null,
    } = {},
    extra = {},
  ) {
    const sid = prepared?.session_id_spec || doc.session_id;
    const job = extra.job || {};
    let session_id = null;
    let resume_confidence = null;
    let resume_candidates = [];

    if (sid.mintable === true) {
      session_id = prepared?.session_id || null;
      resume_confidence = session_id ? "high" : null;
      resume_candidates = session_id ? [session_id] : [];
    } else if (sid.capture.strategy === "stdout_parse") {
      session_id = parseCapturedSessionId(sid.capture, { stdout, stderr });
      resume_confidence = session_id ? "high" : null;
      resume_candidates = session_id ? [session_id] : [];
    } else if (sid.capture.strategy === "sidecar_diff") {
      const diff = resolveSidecarDiff({
        before: sidecarBefore || [],
        after: sidecarAfter || [],
      });
      session_id = diff.session_id;
      resume_confidence = diff.resume_confidence;
      resume_candidates = diff.resume_candidates;
    }

    const baseCtx = buildExpansionCtx({
      job,
      run: { run_id: prepared?.run_id },
      prompt: "",
      model: null,
      sessionId: session_id,
    });

    let resume_command = null;
    let resume_cwd = null;
    if (session_id) {
      const command = expandTemplate(doc.resume.command, baseCtx);
      const argv = Array.isArray(doc.resume.argv)
        ? expandArgv(doc.resume.argv, baseCtx)
        : [];
      resume_command = [command, ...argv].join(" ");
      resume_cwd = doc.resume.cwd
        ? expandTemplate(doc.resume.cwd, baseCtx)
        : resolveJobCwd(job) || null;
    }

    return {
      session_id,
      resume_command,
      resume_cwd,
      resume_confidence,
      resume_candidates,
      caveats: Array.isArray(doc.resume.caveats) ? doc.resume.caveats : [],
    };
  };
}

export function loadManifest(path) {
  const text = readFileSync(path, "utf8");
  const doc = parseYaml(text);
  validateManifest(doc);
  return {
    name: doc.name,
    version: doc.version,
    capabilities: {
      session_identity: true,
      session_start_hook: doc.capabilities?.session_start_hook === true,
      structured_output: doc.capabilities?.structured_output !== false,
      sidecar_diff: doc.session_id?.capture?.strategy === "sidecar_diff",
      mint_session_id: doc.session_id?.mintable === true,
      ...(doc.capabilities || {}),
    },
    timeouts: {
      startup_sec: doc.timeouts?.startup_sec ?? 30,
      finalize_sec: doc.timeouts?.finalize_sec ?? 30,
      provider_version_sec: doc.timeouts?.provider_version_sec ?? 5,
      ...(doc.timeouts || {}),
    },
    provider_version: doc.provider_version || null,
    prepare: compilePrepare(doc),
    finalize: compileFinalize(doc),
    raw: doc,
  };
}

export function resolveResumeFor(adapter, sessionId, jobCwd = "") {
  if (!adapter?.raw?.resume || !sessionId) {
    return {
      session_id: sessionId || null,
      resume_command: null,
      resume_cwd: null,
      caveats: [],
    };
  }
  const ctx = buildExpansionCtx({
    job: { process: { cwd: jobCwd } },
    run: null,
    prompt: "",
    model: null,
    sessionId,
  });
  const command = expandTemplate(adapter.raw.resume.command, ctx);
  const argv = Array.isArray(adapter.raw.resume.argv)
    ? expandArgv(adapter.raw.resume.argv, ctx)
    : [];
  return {
    session_id: sessionId,
    resume_command: [command, ...argv].join(" "),
    resume_argv: argv,
    resume_stdin: adapter.raw.resume.stdin || null,
    structured_output: adapter.raw.resume.structured_output === true,
    resume_cwd: adapter.raw.resume.cwd
      ? expandTemplate(adapter.raw.resume.cwd, ctx)
      : jobCwd || null,
    caveats: Array.isArray(adapter.raw.resume.caveats)
      ? adapter.raw.resume.caveats
      : [],
  };
}
