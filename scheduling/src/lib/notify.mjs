import { writeFileSync } from "node:fs";
import { guardOutbound } from "./outbound_guard.mjs";
import {
  prepareOutboundEffect,
  recordOutboundEffectFailure,
  recordOutboundEffectSuccess,
} from "./runtime_ledger.mjs";
import { readJsonIfExists, secretsPath } from "./store.mjs";

let secretsCache = null;

function loadSecret(key) {
  if (!secretsCache) {
    secretsCache = readJsonIfExists(secretsPath(), {});
  }
  return secretsCache[key] || "";
}

async function postWebhook(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
}

function isAmbiguousSendError(err) {
  const code = String(err?.code || "").toLowerCase();
  const message = String(err?.message || "").toLowerCase();
  return (
    err?.ambiguous === true ||
    code.includes("timeout") ||
    message.includes("timeout") ||
    message.includes("unknown outcome")
  );
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getPathValue(input, path) {
  if (!path) return undefined;
  return String(path)
    .split(".")
    .filter(Boolean)
    .reduce((current, segment) => {
      if (current === null || current === undefined) return undefined;
      return current[segment];
    }, input);
}

function stringifyTemplateValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value);
}

function renderTemplateString(template, context) {
  const exactMatch = String(template).match(/^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/);
  if (exactMatch) {
    const resolved = getPathValue(context, exactMatch[1]);
    return resolved === undefined ? null : resolved;
  }
  return String(template).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, path) =>
    stringifyTemplateValue(getPathValue(context, path)),
  );
}

function renderTemplateValue(template, context) {
  if (Array.isArray(template)) {
    return template.map((value) => renderTemplateValue(value, context));
  }
  if (isPlainObject(template)) {
    return Object.fromEntries(
      Object.entries(template).map(([key, value]) => [
        key,
        renderTemplateValue(value, context),
      ]),
    );
  }
  if (typeof template === "string") {
    return renderTemplateString(template, context);
  }
  return template;
}

function resolveWebhookPayload(job, event) {
  const template = job.notify?.webhook_template;
  const bodyKey = job.notify?.webhook_body_key;

  if (template !== null && template !== undefined && bodyKey) {
    throw new Error("webhook_payload_config_conflict");
  }
  if (bodyKey) {
    const resolved = getPathValue(event, bodyKey);
    if (resolved === undefined) {
      throw new Error(`webhook_body_key_missing:${bodyKey}`);
    }
    return resolved;
  }
  if (template !== null && template !== undefined) {
    return renderTemplateValue(template, event);
  }
  return event;
}

export async function emitNotifications(job, event, opts = {}) {
  const channels = job.notify?.channels || [];
  const notifyOn = job.notify?.on || "both";
  const jsonOnly = Boolean(opts.jsonOnly);
  if (notifyOn === "none") return [];
  if (notifyOn === "success" && event.status !== "success") return [];
  if (notifyOn === "failure" && event.status !== "failure") return [];

  const results = [];

  for (const channel of channels) {
    if (channel === "stdout") {
      if (!jsonOnly) {
        process.stdout.write(
          `${JSON.stringify({ event_type: "notification", channel, event })}\n`,
        );
      }
      results.push({ channel, ok: true, suppressed: jsonOnly });
      continue;
    }

    if (channel === "file") {
      const path = job.notify?.file_path;
      if (!path) {
        results.push({ channel, ok: false, error: "file_path_missing" });
        continue;
      }
      writeFileSync(path, `${JSON.stringify(event)}\n`, { flag: "a" });
      results.push({ channel, ok: true });
      continue;
    }

    if (channel === "webhook") {
      const envName = job.notify?.webhook_url_env;
      const url = envName ? process.env[envName] || loadSecret(envName) : "";
      if (!url) {
        results.push({ channel, ok: false, error: "webhook_url_not_found" });
        continue;
      }
      // Channels are processed sequentially so notification result order stays stable.
      // eslint-disable-next-line no-await-in-loop
      const guard = await guardOutbound({
        route: "notify.webhook",
        channel: "webhook",
        sideEffectKind: "webhook_post",
        scope: opts.scope || null,
        data: {
          job_id: event.job_id || job.id || null,
          run_id: event.run_id || null,
        },
      });
      if (guard.suppressed) {
        results.push({
          channel,
          ok: true,
          suppressed: true,
          reason: guard.reason,
          outbound_guard: guard,
        });
        continue;
      }
      const payload = resolveWebhookPayload(job, event);
      const outboundEffect = prepareOutboundEffect({
        namespace: "schedule",
        logicalEventKey: `${event.job_id || job.id || "unknown"}/${event.run_id || event.scheduled_at || event.event_type || "unknown"}/notification/webhook`,
        effect: "notification",
        channel: "webhook",
        recipient: envName || url,
        payload,
        renderInputs: {
          job_id: event.job_id || job.id || null,
          run_id: event.run_id || null,
          event_type: event.event_type || null,
          status: event.status || null,
        },
        templateVersion: job.notify?.webhook_template ? "inline" : null,
      });
      if (!outboundEffect.allowed) {
        results.push({
          channel,
          ok: outboundEffect.status !== "blocked",
          suppressed: outboundEffect.status !== "blocked",
          reason: outboundEffect.reason,
          outbound_guard: guard,
          outbound_effect: outboundEffect,
        });
        continue;
      }
      try {
        // Channels are processed sequentially so notification result order stays stable.
        // eslint-disable-next-line no-await-in-loop
        await postWebhook(url, payload);
        recordOutboundEffectSuccess({
          sideEffectKey: outboundEffect.side_effect_key,
        });
        results.push({ channel, ok: true, outbound_effect: outboundEffect });
      } catch (err) {
        recordOutboundEffectFailure({
          sideEffectKey: outboundEffect.side_effect_key,
          ambiguous: isAmbiguousSendError(err),
          error: err?.code || err?.message || String(err),
        });
        results.push({
          channel,
          ok: false,
          error: String(err.message || err),
          outbound_effect: outboundEffect,
        });
      }
      continue;
    }

    results.push({ channel, ok: false, error: "unknown_channel" });
  }

  return results;
}
