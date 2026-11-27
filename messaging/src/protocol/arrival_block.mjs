// The tag that wraps every message arrival a session reads in its prompt:
// the daemon's resume/spawn brief and the PostToolUse hook notification.
// Shared vocabulary, so it lives in src/protocol/ where both sides may
// import it (the architecture contract §5 import boundary rule).
//
//   <tldr_messages event="resumed|started|received" ids="msg_a msg_b" external="msg_b" typed="msg_b" bodies="msg_b">
//   …plain-text brief, unchanged line format…
//   </tldr_messages>
//
// The tag lets a host (Subspace) render arrivals as their own UI instead of
// an untagged user turn; the attributes carry what it needs without parsing
// the prose. The inner text stays readable on its own for runtimes and
// transcripts that show the tag verbatim. `external` is omitted when no
// listed message came from an external channel; `typed` (a subset of `external`)
// names those that are typed delegation / replacement / cancel notices, which
// the ack gate does not treat as a user message waiting for a reply. `bodies`
// (a subset of `external`, never `typed`) names the entries whose capped, quoted
// body is in the block; for an idle-wake brief the resumer stamps those ids so
// the launch's busy mark can receipt them (endpoint_state_set.mjs).
//
// Only this module writes the tag. Text a sender controls goes through
// arrivalField before it reaches a body, and the body is checked once more
// here, so a subject or reason can never close the block or forge another.

import { MESSAGE_ID } from './ack_gate.mjs';

export const ARRIVAL_TAG = 'tldr_messages';

// Readers of a rendered block (the ack gate's arming, the resumer's body stamp).
export const OPENING_TAG = new RegExp(`<${ARRIVAL_TAG}\\s[^>]*>`, 'gi');
export const attributeIds = (tag, name) =>
  tag
    .match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]
    .split(/\s+/)
    .filter((id) => MESSAGE_ID.test(id)) ?? [];

/** The ids a tag's `bodies="..."` says the block carries with their body. */
export function parseBodyMessageIds(text) {
  if (typeof text !== 'string') return [];
  return [...new Set([...text.matchAll(OPENING_TAG)].flatMap(([tag]) => attributeIds(tag, 'bodies')))];
}

export const ARRIVAL_EVENTS = Object.freeze(['resumed', 'started', 'received']);

function escapeAttribute(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Every line separator a reader might honour, plus the other C0 controls (tab kept).
const LINE_BREAK_CHARS = '[\\u0000-\\u0008\\u000a-\\u001f\\u007f\\u0085\\u2028\\u2029]';
const LINE_BREAKS = new RegExp(`${LINE_BREAK_CHARS}+`, 'g');
// One break per separator (a CRLF pair is one), so a body keeps its blank lines.
const BODY_LINE_BREAK = new RegExp(`\\r\\n|${LINE_BREAK_CHARS}`);
const escapeText = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/**
 * A value a sender controls (subject, cancel reason, sender label or folder,
 * a notice line built from them), made safe for one labelled line inside the
 * block: line breaks collapse to one space, so it cannot start a labelled line
 * of its own, and `&` and `<` are escaped, so it cannot open or close a tag.
 */
export function arrivalField(value) {
  return escapeText(String(value).replace(LINE_BREAKS, ' '));
}

// Any spelling of this block's own tag left in the body (a caller that missed
// arrivalField): the `<` is escaped, so only the tags written below are tags.
const EMBEDDED_TAG = new RegExp(`<(?=\\s*/?\\s*${ARRIVAL_TAG}\\b)`, 'gi');

// A cut that never leaves half a surrogate pair or half of the `&lt;` the tag rule wrote.
function cutLine(text, room) {
  return text.slice(0, room).replace(/[\ud800-\udbff]$/, '').replace(/&l?t?$/, '');
}

/**
 * A message body made safe to quote inside the block: split on every line
 * separator arrivalField knows, each line prefixed `> ` so none can start a
 * labelled line, and only this block's own tag neutralized (the user's text is
 * otherwise as written: `<div>` and `&` survive). `maxChars` counts the text
 * as rendered. Returns `{ lines, truncated }`.
 */
export function quoteBody(body, maxChars) {
  const lines = [];
  let used = 0;
  const raws = String(body).split(BODY_LINE_BREAK);
  for (const [index, raw] of raws.entries()) {
    const room = maxChars - used;
    // Budget spent (a newline at the cap leaves none): stop; never slice with a negative length.
    if (room <= 0) return { lines, truncated: index < raws.length - 1 || raw !== '' };
    const line = raw.replace(EMBEDDED_TAG, '&lt;');
    if (line.length > room) {
      const partial = cutLine(line, room);
      return { lines: partial ? [...lines, `> ${partial}`] : lines, truncated: true };
    }
    lines.push(`> ${line}`);
    used += line.length + 1;
  }
  return { lines, truncated: false };
}

export function renderArrivalBlock({ event, messageIds, externalMessageIds = new Set(), typedMessageIds = new Set(), bodyMessageIds = new Set(), body }) {
  if (!ARRIVAL_EVENTS.includes(event)) throw new Error(`unknown arrival event: ${event}`);
  body = body.replace(EMBEDDED_TAG, '&lt;');
  const external = messageIds.filter((id) => externalMessageIds.has(id));
  const typed = external.filter((id) => typedMessageIds.has(id));
  const bodies = external.filter((id) => bodyMessageIds.has(id) && !typedMessageIds.has(id));
  const attributes = [
    `event="${event}"`,
    `ids="${escapeAttribute(messageIds.join(' '))}"`,
    ...(external.length > 0 ? [`external="${escapeAttribute(external.join(' '))}"`] : []),
    ...(typed.length > 0 ? [`typed="${escapeAttribute(typed.join(' '))}"`] : []),
    ...(bodies.length > 0 ? [`bodies="${escapeAttribute(bodies.join(' '))}"`] : []),
  ];
  return `<${ARRIVAL_TAG} ${attributes.join(' ')}>\n${body.replace(/\n+$/, '')}\n</${ARRIVAL_TAG}>`;
}
