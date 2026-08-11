import { createHash } from "node:crypto";

function stringField(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "string" && value.length > 0) {
      return { value, source: key };
    }
  }
  return { value: "", source: null };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function latestReplyFromRaw(value) {
  if (!value) return "";
  const quoteMarker = /^>+/m.exec(value);
  const markers = [
    quoteMarker,
    /^-{2,}\s*Original Message\s*-{2,}$/im,
    /^Resent-From:\s/im,
    /^From:\s.+$/im,
  ];
  let end = value.length;
  for (const marker of markers) {
    const match = marker instanceof RegExp ? marker.exec(value) : marker;
    if (match && match.index < end) end = match.index;
  }
  let latest = value.slice(0, end).trimEnd();
  if (quoteMarker?.index === end) {
    latest = latest.replace(/\n*On [^\n]+:\s*$/i, "").trimEnd();
  }
  return latest;
}

export function selectInboundEmailBody(payload) {
  const extracted = stringField(payload, ["extractedText", "extracted_text"]);
  const raw = stringField(payload, ["text", "body", "preview"]);
  const latest = extracted.value
    ? extracted
    : { value: latestReplyFromRaw(raw.value), source: raw.source };
  const metadata = {
    latest_reply_body_source: latest.source,
    raw_provider_body_source: raw.source,
    raw_provider_body_bytes: raw.value
      ? Buffer.byteLength(raw.value, "utf8")
      : 0,
    raw_provider_body_sha256: raw.value ? sha256(raw.value) : null,
  };
  return {
    latestReplyBody: latest.value,
    metadata,
  };
}
