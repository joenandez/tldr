// The tag that wraps every message arrival a session reads in its prompt:
// the daemon's resume/spawn brief and the PostToolUse hook notification.
// Shared vocabulary, so it lives in src/protocol/ where both sides may
// import it (the architecture contract §5 import boundary rule).
//
//   <tldr_messages event="resumed|started|received" ids="msg_a msg_b" external="msg_b">
//   …plain-text brief, unchanged line format…
//   </tldr_messages>
//
// The tag lets a host (Subspace) render arrivals as their own UI instead of
// an untagged user turn; the attributes carry what it needs without parsing
// the prose. The inner text stays readable on its own for runtimes and
// transcripts that show the tag verbatim. `external` is omitted when no
// listed message came from an external channel.
//
// Only this module writes the tag. Text a sender controls goes through
// arrivalField before it reaches a body, and the body is checked once more
// here, so a subject or reason can never close the block or forge another.

export const ARRIVAL_TAG = 'tldr_messages';

export const ARRIVAL_EVENTS = Object.freeze(['resumed', 'started', 'received']);

function escapeAttribute(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Every line separator a reader might honour, plus the other C0 controls (tab kept).
const LINE_BREAKS = /[\u0000-\u0008\u000a-\u001f\u007f\u0085\u2028\u2029]+/g;

/**
 * A value a sender controls (subject, cancel reason, sender label or folder,
 * a notice line built from them), made safe for one labelled line inside the
 * block: line breaks collapse to one space, so it cannot start a labelled line
 * of its own, and `&` and `<` are escaped, so it cannot open or close a tag.
 */
export function arrivalField(value) {
  return String(value).replace(LINE_BREAKS, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

// Any spelling of this block's own tag left in the body (a caller that missed
// arrivalField): the `<` is escaped, so only the tags written below are tags.
const EMBEDDED_TAG = new RegExp(`<(?=\\s*/?\\s*${ARRIVAL_TAG}\\b)`, 'gi');

export function renderArrivalBlock({ event, messageIds, externalMessageIds = new Set(), body }) {
  if (!ARRIVAL_EVENTS.includes(event)) throw new Error(`unknown arrival event: ${event}`);
  body = body.replace(EMBEDDED_TAG, '&lt;');
  const external = messageIds.filter((id) => externalMessageIds.has(id));
  const attributes = [
    `event="${event}"`,
    `ids="${escapeAttribute(messageIds.join(' '))}"`,
    ...(external.length > 0 ? [`external="${escapeAttribute(external.join(' '))}"`] : []),
  ];
  return `<${ARRIVAL_TAG} ${attributes.join(' ')}>\n${body.replace(/\n+$/, '')}\n</${ARRIVAL_TAG}>`;
}
