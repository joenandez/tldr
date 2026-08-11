/* tldr; — the email envelope.
 *
 * Four parts: the subject set as the TLDR block, the agent's Markdown, and a
 * context line closing the message. A system message adds a fifth above them
 * all, and it is an exception on purpose.
 *
 * THE TLDR BLOCK is the product's name made literal, and it is the one place
 * this system speaks above the agent. It carries the result, the owner action,
 * and the next moment — and it invents none of them. The subject's grammar is
 * already "state word, colon, the decision", so the state word becomes the
 * action and the decision becomes the result. The block sets a structure that
 * was always in the string; it does not add a claim to it.
 *
 * That is also why the subject is not printed twice. A card that repeats its own
 * subject above a summary of its own subject has spent the owner's first two
 * seconds saying one thing three times.
 *
 * THE LIVE EDGE is allocated here and only here. Citron means the point where
 * attention is active, so it appears on the action chip when the message needs
 * the owner, and nowhere at all when it does not — seeing citron in an inbox has
 * to mean something. No block renderer can emit the accent; html.mjs never
 * receives it.
 */

import {
  BODY,
  CARD_WIDTH,
  DAY,
  DISPLAY,
  MONO,
  NIGHT,
  TYPE,
} from "./tokens.mjs";
import { parseInline, parseMarkdown } from "./markdown.mjs";
import { blocksHtml, esc, presentationTable as pt } from "./html.mjs";
import { blocksText, COLUMNS, inlineText, wrap } from "./text.mjs";
import { TEXT_GLYPH } from "./glyphs.mjs";
import {
  ACTION,
  inlineMarkdownHtml,
  resolveAction,
  splitSubject,
  tldrHtml,
} from "./tldr.mjs";

export const AGENTS = Object.freeze({
  claude: { label: "Claude Code", adapter: "claude" },
  codex: { label: "Codex", adapter: "codex" },
});

const REPLY_DEFAULT =
  "Reply to this email. The same session picks it up, in the same directory.";
const NOTICE_DEFAULT =
  "Only replies from your verified address reach the session.";

export const WORDMARK = "tldr;";

/* The twin resolves the same inline Markdown the HTML does, and shows the result
 * rather than the notation. */
const footerInlineText = (value) => inlineText(parseInline(value));

/* The wordmark, set as live text rather than loaded as an asset.
 *
 * DESIGN.md's identity rule is that the wordmark is an SVG and is never rebuilt
 * from type. Email is the declared exception, and it has to be: clients block
 * remote images, so an emailed wordmark that is an image is a wordmark most
 * owners never see.
 *
 * Proportions come off brand/logotype/wordmark.svg — the semicolon's dot sits at
 * the ascender line and its tail drops well below the baseline, about a quarter
 * taller overall than the letters beside it. The negative margin cancels the
 * tracking the `r` would otherwise carry, because the asset has the semicolon
 * hugging the `r` rather than sitting a letter away from it.
 *
 * All of it link blue, as the asset is. Blue without an underline cannot be
 * mistaken for a link here: in this system a link is always underlined. */
function wordmarkHtml(t) {
  return (
    `<span class="tl-link" style="font-family:${BODY};font-size:17px;line-height:1;` +
    `letter-spacing:.16em;font-weight:400;color:${t.link};">tldr</span>` +
    `<span class="tl-link" style="font-family:${DISPLAY};font-size:25px;line-height:1;` +
    `font-weight:700;color:${t.link};margin-left:-1px;">;</span>`
  );
}

/* The system bar: a solid identity plane across the head of the card, the
 * wordmark on the left and the kind of message on the right.
 *
 * It is the loudest piece of chrome in the system, spent on the one distinction
 * that matters at 3am: an agent's message says a thing about your code, a system
 * message says a thing about tldr;, and the owner has to be able to tell which
 * before reading a word. Never citron — it is a label, not an ask. */
function systemBarHtml(kind, t) {
  const cell =
    `class="tl-solid" style="background:${t.solid};color:${t.onSolid};${TYPE.stamp}` +
    `line-height:1.2;white-space:nowrap;vertical-align:middle;`;

  /* The kind is uppercased; the wordmark is not. The name is lowercase and it
   * stays lowercase in the one place the product signs itself loudest. */
  return pt(
    `<tr>` +
      `<td ${cell}padding:12px 10px 12px 24px;font-size:14px;letter-spacing:.04em;">${WORDMARK}</td>` +
      `<td align="right" ${cell}padding:12px 24px 12px 10px;text-transform:uppercase;">${esc(kind)}</td>` +
      `</tr>`,
  );
}

/* A value the owner has to read off the screen and type somewhere else.
 *
 * It gets the mono face at display size rather than the 13px a fenced block
 * would give it, because this is the one string in the system whose whole job is
 * to be transcribed correctly at arm's length. The subject carries it too, so it
 * reaches the lock screen without the email being opened; that repetition is the
 * point rather than an oversight. */
function codePlateHtml(code, t) {
  return pt(
    `<tr><td class="tl-raised" style="border:1px solid ${t.line};border-radius:2px;` +
      `background:${t.raised};padding:20px 24px;font-family:${MONO};font-size:30px;` +
      `line-height:1.2;font-weight:500;letter-spacing:.16em;color:${t.ink};` +
      `white-space:nowrap;">${esc(code)}</td></tr>`,
  );
}

/* Provenance is useful, not important enough to be a form. One line, fixed
 * order, widest scope inward — across a thread of six messages the values have
 * to be in the same places or the line stops being scannable and becomes
 * something to read. */
const CONTEXT_ORDER = ["DIRECTORY", "AGENT", "BRANCH", "SESSION"];

const contextRank = (label) => {
  const index = CONTEXT_ORDER.indexOf(label);
  return index === -1 ? CONTEXT_ORDER.length : index;
};

/* Labels stay, lowercased. Dropping them makes the line shorter and the values
 * ambiguous — `rate-limit` beside `1f4a9c2` is a branch and a session only if
 * you already knew that, and the owner reading this is half awake. The label
 * recedes to muted and the value holds the ink, so the pairs scan without the
 * separators having to do all the work. */
export const contextPairs = (spec) =>
  [
    ...(spec.statePanel ?? []),
    ...(spec.agent ? [["AGENT", spec.agent.label]] : []),
  ]
    .filter(([, value]) => value)
    .sort(([a], [b]) => contextRank(a) - contextRank(b))
    .map(([label, value]) => [String(label).toLowerCase(), String(value)]);

function footerHtml(spec, t) {
  const context = contextPairs(spec);
  const contextRow = context.length
    ? `<tr><td style="${TYPE.context}padding:16px 0 0 0;word-break:break-word;">` +
      context
        .map(
          ([label, value]) =>
            `<span class="tl-muted" style="color:${t.muted};">${esc(label)}</span>` +
            `<span class="tl-ink" style="color:${t.ink};"> ${esc(value)}</span>`,
        )
        .join(
          `<span class="tl-line" style="color:${t.line};"> &middot; </span>`,
        ) +
      `</td></tr>`
    : "";

  return pt(
    `<tr><td style="padding:0 24px;">` +
      pt(
        `<tr><td style="padding:0;"><div class="tl-hair" style="height:1px;background:${t.line};font-size:0;line-height:1px;">&nbsp;</div></td></tr>` +
          contextRow +
          `<tr><td style="padding:22px 0 0 0;">${wordmarkHtml(t)}</td></tr>` +
          `<tr><td class="tl-muted" style="${TYPE.context}color:${t.muted};padding:10px 0 0 0;">` +
          `${inlineMarkdownHtml(spec.notice ?? NOTICE_DEFAULT, t)}</td></tr>`,
      ) +
      `</td></tr>`,
  );
}

/* Night lighting. Day values are hard-coded inline above this block, so a client
 * that strips <style> still renders the document correctly. Every day colour
 * this renderer emits sits on one of these classes. */
function nightCss() {
  const n = NIGHT;
  return `@media (prefers-color-scheme: dark){
    .tl-page,.tl-card{background:${n.stock}!important;}
    .tl-ink,.tl-ink a{color:${n.ink}!important;}
    .tl-muted,.tl-muted a{color:${n.muted}!important;}
    .tl-link,.tl-link a,a.tl-link{color:${n.link}!important;}
    .tl-line{color:${n.line}!important;}
    .tl-hair{background:${n.line}!important;}
    .tl-hair-link{background:${n.link}!important;}
    .tl-bar{background:${n.link}!important;}
    .tl-ruled{border-bottom-color:${n.line}!important;}
    .tl-field{background:${n.field}!important;}
    .tl-raised{background:${n.raised}!important;border-color:${n.line}!important;color:${n.ink}!important;}
    .tl-code{background:${n.field}!important;color:${n.ink}!important;}
    .tl-tab,.tl-solid,.tl-chip-wait{background:${n.solid}!important;color:${n.onSolid}!important;}
    .tl-chip-live{background:${n.accent}!important;color:${n.onAccent}!important;}
    .tl-check-on{background:${n.solid}!important;color:${n.onSolid}!important;}
    .tl-check-off{border-color:${n.line}!important;}
    .tl-fill-link{background:${n.link}!important;}
  }`;
}

/* The card only — used by the gallery, which needs day and night side by side
 * and therefore cannot rely on a media query. */
export function renderCard(spec, mode = "day") {
  const t = mode === "night" ? NIGHT : DAY;
  const body = parseMarkdown(spec.body ?? "");

  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="tl-card" ` +
    `style="border-collapse:collapse;width:100%;max-width:${CARD_WIDTH}px;background:${t.stock};">` +
    (spec.system
      ? `<tr><td style="padding:0;">${systemBarHtml(spec.system, t)}</td></tr>`
      : "") +
    `<tr><td style="padding:${spec.system ? 24 : 28}px 24px 0 24px;">${tldrHtml(spec, t, spec.reply ?? REPLY_DEFAULT)}</td></tr>` +
    (spec.code
      ? `<tr><td style="padding:20px 24px 0 24px;">${codePlateHtml(spec.code, t)}</td></tr>`
      : "") +
    (body.length
      ? `<tr><td style="padding:32px 24px 0 24px;">${blocksHtml(body, t)}</td></tr>`
      : "") +
    `<tr><td style="padding:36px 0 0 0;">${footerHtml(spec, t)}</td></tr>` +
    `<tr><td style="height:28px;line-height:28px;font-size:0;">&nbsp;</td></tr>` +
    `</table>`
  );
}

/* The line the inbox shows under the subject. The subject already carries the
 * result, so the preheader spends itself on what the subject cannot say: what
 * this means for the owner, then the first sentence of the message. */
function preheader(spec) {
  const first = parseMarkdown(spec.body ?? "").find(
    (n) => n.type === "paragraph",
  );
  const lead = (first?.text ?? "").replace(/\s+/g, " ").trim();
  return `${ACTION[resolveAction(spec)]}${lead ? ` — ${lead}` : ""}`.slice(
    0,
    140,
  );
}

export function renderHtml(spec) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(spec.subject)}</title>
<style>${nightCss()}</style>
</head>
<body class="tl-page" style="margin:0;padding:0;background:${DAY.stock};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader(spec))}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="tl-page" style="background:${DAY.stock};">
<tr><td align="center" style="padding:28px 12px 40px 12px;">${renderCard(spec, "day")}</td></tr>
</table>
</body></html>
`;
}

/* ------------------------------------------------------------------ text */

export function renderText(spec) {
  const out = [];
  const { result } = splitSubject(spec.subject);
  const action = ACTION[resolveAction(spec)].toUpperCase();

  /* The twin carries the same distinctions in the material it has: a rule above
   * and below, which is the heaviest thing 72 columns of ASCII can say. */
  if (spec.system) {
    const kind = spec.system.toUpperCase();
    out.push(
      "=".repeat(COLUMNS),
      `${WORDMARK}${" ".repeat(Math.max(COLUMNS - WORDMARK.length - kind.length, 1))}${kind}`,
      "=".repeat(COLUMNS),
      "",
    );
  }

  out.push(
    `TLDR${" ".repeat(Math.max(COLUMNS - 4 - action.length, 1))}${action}`,
    "",
    ...wrap(result),
    "",
  );

  /* The reply mark owns a gutter in the twin too, so a wrapped instruction stays
   * visibly attached to it. The twin is an equal document, not a dump: it
   * resolves the same inline Markdown the HTML does and shows the result rather
   * than the notation. */
  const reply = wrap(
    footerInlineText(spec.reply ?? REPLY_DEFAULT),
    COLUMNS - 3,
  );
  out.push(
    `${TEXT_GLYPH.reply} ${reply[0]}`,
    ...reply.slice(1).map((l) => `   ${l}`),
  );

  /* The twin gives the code its own indented line and nothing else on it. There
   * is no type size to reach for here, so isolation does the work instead. */
  if (spec.code) out.push("", `    ${spec.code}`);

  if (spec.body?.trim()) {
    out.push(
      "",
      "-".repeat(COLUMNS),
      "",
      ...blocksText(parseMarkdown(spec.body)),
    );
  }

  out.push("", "-".repeat(COLUMNS), "");

  const context = contextPairs(spec);
  if (context.length)
    out.push(
      ...wrap(context.map(([label, value]) => `${label} ${value}`).join(" · ")),
      "",
    );

  out.push(WORDMARK);
  out.push(...wrap(footerInlineText(spec.notice ?? NOTICE_DEFAULT)), "");

  return out.join("\n");
}

export function render(spec) {
  return {
    subject: spec.subject,
    html: renderHtml(spec),
    text: renderText(spec),
  };
}

export { ACTION, resolveAction, splitSubject };
export { DAY, NIGHT, MONO, BODY, DISPLAY, TYPE, CARD_WIDTH };
