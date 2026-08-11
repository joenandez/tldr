/* tldr; — the TLDR block.
 *
 * The product's name made literal, and the one place this system speaks above
 * the agent. It carries the result, the owner action and the next moment, and it
 * invents none of them.
 *
 * The subject's grammar is already "state word, colon, the decision", so the
 * state word becomes the action and the decision becomes the result. The block
 * sets a structure that was always in the string; it does not add a claim to it.
 * That is also why the subject is never printed twice — a card that repeats its
 * own subject above a summary of its own subject has spent the owner's first two
 * seconds saying one thing three times.
 *
 * THE LIVE EDGE lives here. Citron means the point where attention is active, so
 * it appears on the action chip when the message needs the owner and nowhere at
 * all when it does not. Seeing citron in an inbox has to mean something.
 */

import { RADIUS, TYPE } from "./tokens.mjs";
import { parseInline, parseMarkdown } from "./markdown.mjs";
import { bandOf, esc, inlineHtml, presentationTable as pt } from "./html.mjs";
import { glyph } from "./glyphs.mjs";

export const ACTION = Object.freeze({
  now: "Needs you now",
  later: "Can wait",
  none: "Nothing needed",
});

/* State words an agent actually writes, mapped to what they mean for the owner.
 * A word on neither list resolves to "later", which is the only honest default:
 * the message is not shouting, and claiming nothing is needed would be this
 * system putting words in the agent's mouth. */
const NOW_STATES =
  /^(needs you|needs text|blocked|can[’']?t resume|action needed|verify)/i;
const NONE_STATES =
  /^(done|got it|complete|completed|finished|delivered|text only)/i;

/* Lifting the state word off the front leaves the decision starting in lower
 * case, and the decision is about to be set as the loudest line in the message.
 * It gets a capital.
 *
 * Not when the first word is an identifier, though: `org_id`, a path, a flag or
 * a version string is a thing with a spelling, and capitalising it would be this
 * renderer editing the agent's fact rather than its sentence. */
const IDENTIFIER = /^[^\s]*[_/.\-@][^\s]*/;

const sentenceCase = (value) =>
  IDENTIFIER.test(value) || !/^[a-z]/.test(value)
    ? value
    : value[0].toUpperCase() + value.slice(1);

/* The subject's fixed grammar, split into the two things it already contains. */
export function splitSubject(subject) {
  const match = /^([^:]{2,24}):\s*(.+)$/s.exec(String(subject).trim());
  if (!match) return { state: null, result: String(subject).trim() };
  return { state: match[1].trim(), result: sentenceCase(match[2].trim()) };
}

export function resolveAction(spec) {
  if (spec.action && ACTION[spec.action]) return spec.action;

  const raised = parseMarkdown(spec.body ?? "").some((node) => {
    const band = node.type === "quote" ? bandOf(node) : null;
    return band?.label === "CAUTION" || band?.label === "ABORT";
  });
  if (raised) return "now";

  const { state } = splitSubject(spec.subject ?? "");
  if (state && NOW_STATES.test(state)) return "now";
  if (state && NONE_STATES.test(state)) return "none";
  return "later";
}

/* Exactly one element may be citron, and only when something is live. */
export const isLive = (spec) => resolveAction(spec) === "now";

function chipHtml(action, t) {
  const label = ACTION[action];
  if (action === "none") {
    return `<span class="tl-muted" style="${TYPE.chip}color:${t.muted};text-transform:uppercase;">${label}</span>`;
  }
  const live = action === "now";
  return (
    `<span class="${live ? "tl-chip-live" : "tl-chip-wait"}" style="display:inline-block;` +
    `background:${live ? t.accent : t.solid};color:${live ? t.onAccent : t.onSolid};` +
    `${TYPE.chip}text-transform:uppercase;border-radius:${RADIUS.sm};padding:5px 9px;">${label}</span>`
  );
}

/* The reply sentence is written by this system, and it writes Markdown in it —
 * the recovery state's line is "Run `tldr status` for the next repair step."
 * Escaping it would ship literal backticks in the one sentence that says what to
 * do. Parsing is not a licence to emit markup: it goes through the same inline
 * parser as the body, which escapes text and only ever emits our own tags. */
export const inlineMarkdownHtml = (value, t) =>
  inlineHtml(parseInline(value), t);

export function tldrHtml(spec, t, reply) {
  const { result } = splitSubject(spec.subject);
  const action = resolveAction(spec);

  const head = pt(
    `<tr>` +
      `<td class="tl-link" style="${TYPE.tldrLabel}color:${t.link};text-transform:uppercase;vertical-align:middle;">TLDR</td>` +
      `<td align="right" style="vertical-align:middle;padding-left:12px;">${chipHtml(action, t)}</td>` +
      `</tr>`,
  );

  /* The one instruction in the message, marked by the one glyph in the system. */
  const next = pt(
    `<tr>` +
      `<td width="28" valign="top" style="padding:5px 12px 0 0;">${glyph("reply", t.link, "tl-fill-link")}</td>` +
      `<td class="tl-ink" style="${TYPE.small}color:${t.ink};">${inlineMarkdownHtml(reply, t)}</td>` +
      `</tr>`,
  );

  return pt(
    `<tr><td class="tl-bar" style="background:${t.link};height:2px;line-height:2px;font-size:0;` +
      `border-radius:${RADIUS.md} ${RADIUS.md} 0 0;">&nbsp;</td></tr>` +
      `<tr><td class="tl-field" style="background:${t.field};padding:18px 20px 20px 20px;` +
      `border-radius:0 0 ${RADIUS.md} ${RADIUS.md};">` +
      pt(
        `<tr><td>${head}</td></tr>` +
          `<tr><td class="tl-ink" style="${TYPE.result}color:${t.ink};padding:14px 0 0 0;">${esc(result)}</td></tr>` +
          `<tr><td style="padding:16px 0 0 0;">${next}</td></tr>`,
      ) +
      `</td></tr>`,
  );
}
