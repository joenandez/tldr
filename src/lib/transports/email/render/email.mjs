/* Quiet rich-text correspondence for owner and agent email.
 *
 * Normal messages begin with the agent's body. There is no product masthead,
 * repeated subject, summary panel, action chip, or decorative mark. System mail
 * identifies itself with a compact label and heading; all tldr; branding lives
 * at the very end of the footer.
 */

import {
  BODY,
  CARD_WIDTH,
  DAY,
  DISPLAY,
  GUTTER,
  MONO,
  NIGHT,
  TYPE,
} from "./tokens.mjs";
import { parseInline, parseMarkdown } from "./markdown.mjs";
import { blocksHtml, esc, presentationTable as pt } from "./html.mjs";
import { blocksText, inlineText, wrap } from "./text.mjs";
import {
  ACTION,
  inlineMarkdownHtml,
  resolveAction,
  splitSubject,
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
const footerInlineText = (value) => inlineText(parseInline(value));

function wordmarkHtml(tokens) {
  return (
    `<span class="tl-muted" style="${TYPE.colophon}color:${tokens.muted};">Sent via tldr</span>` +
    `<span class="tl-link" style="${TYPE.colophon}color:${tokens.link};">;</span>`
  );
}

function systemHeaderHtml(spec, tokens) {
  const { result } = splitSubject(spec.subject);
  return pt(
    `<tr><td class="tl-muted" style="${TYPE.systemLabel}color:${tokens.muted};">` +
      `tldr; <span class="tl-line" style="color:${tokens.line};">&middot;</span> ${esc(spec.system)}` +
      `</td></tr>` +
      `<tr><td class="tl-ink" style="${TYPE.systemTitle}color:${tokens.ink};padding:10px 0 0 0;">${esc(result)}</td></tr>`,
  );
}

function codePlateHtml(code, tokens) {
  return pt(
    `<tr><td class="tl-raised" style="border:1px solid ${tokens.line};border-radius:4px;` +
      `background:${tokens.raised};padding:18px 20px;${TYPE.codePlate}color:${tokens.ink};` +
      `white-space:nowrap;">${esc(code)}</td></tr>`,
  );
}

const CONTEXT_ORDER = ["DIRECTORY", "AGENT", "BRANCH", "SESSION"];
const contextRank = (label) => {
  const index = CONTEXT_ORDER.indexOf(label);
  return index === -1 ? CONTEXT_ORDER.length : index;
};

export const contextPairs = (spec) =>
  [
    ...(spec.statePanel ?? []),
    ...(spec.agent ? [["AGENT", spec.agent.label]] : []),
  ]
    .filter(([, value]) => value)
    .sort(([a], [b]) => contextRank(a) - contextRank(b))
    .map(([label, value]) => [String(label).toLowerCase(), String(value)]);

function footerHtml(spec, tokens) {
  const context = contextPairs(spec);
  const contextRow = context.length
    ? `<tr><td class="tl-muted" style="${TYPE.context}color:${tokens.muted};padding:10px 0 0 0;word-break:break-word;">` +
      context
        .map(
          ([label, value]) =>
            `<span style="font-weight:600;">${esc(label)}</span> ${esc(value)}`,
        )
        .join(
          `<span class="tl-line" style="color:${tokens.line};"> &middot; </span>`,
        ) +
      `</td></tr>`
    : "";

  return pt(
    `<tr><td style="padding:0 ${GUTTER}px;">` +
      pt(
        `<tr><td style="padding:0;"><div class="tl-hair" style="height:1px;background:${tokens.line};font-size:0;line-height:1px;">&nbsp;</div></td></tr>` +
          `<tr><td class="tl-muted" style="${TYPE.small}color:${tokens.muted};padding:14px 0 0 0;">` +
          `${inlineMarkdownHtml(spec.reply ?? REPLY_DEFAULT, tokens)}</td></tr>` +
          contextRow +
          `<tr><td class="tl-muted" style="${TYPE.context}color:${tokens.muted};padding:7px 0 0 0;">` +
          `${inlineMarkdownHtml(spec.notice ?? NOTICE_DEFAULT, tokens)}</td></tr>` +
          `<tr><td style="padding:18px 0 0 0;">${wordmarkHtml(tokens)}</td></tr>`,
      ) +
      `</td></tr>`,
  );
}

function nightCss() {
  const n = NIGHT;
  /* The :root declaration is what Apple Mail 13+ actually reads for scheme
   * opt-in; the meta tags cover Mail 12 and signal intent to inverting
   * clients. Both ship because neither alone covers the version range. */
  return `:root{color-scheme:light dark;supported-color-schemes:light dark;}
  @media (prefers-color-scheme: dark){
    .tl-page,.tl-card{background:${n.stock}!important;}
    .tl-ink,.tl-ink a{color:${n.ink}!important;}
    .tl-muted,.tl-muted a{color:${n.muted}!important;}
    .tl-link,.tl-link a,a.tl-link{color:${n.link}!important;}
    .tl-line{color:${n.line}!important;}
    .tl-hair{background:${n.line}!important;}
    .tl-ruled{border-bottom-color:${n.line}!important;}
    .tl-raised{background:${n.raised}!important;border-color:${n.line}!important;color:${n.ink}!important;}
    .tl-code{background:${n.raised}!important;color:${n.ink}!important;}
    .tl-check-on{background:${n.ink}!important;color:${n.stock}!important;}
    .tl-check-off{border-color:${n.strongLine}!important;}
  }`;
}

export function renderCard(spec, mode = "day") {
  const tokens = mode === "night" ? NIGHT : DAY;
  const body = parseMarkdown(spec.body ?? "");

  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="tl-card" ` +
    `style="border-collapse:collapse;table-layout:fixed;width:100%;max-width:${CARD_WIDTH}px;background:${tokens.stock};">` +
    (spec.system && !spec.code
      ? `<tr><td style="padding:30px ${GUTTER}px 0 ${GUTTER}px;">${systemHeaderHtml(spec, tokens)}</td></tr>`
      : "") +
    (spec.code
      ? `<tr><td style="padding:30px ${GUTTER}px 0 ${GUTTER}px;">${codePlateHtml(spec.code, tokens)}</td></tr>`
      : "") +
    (body.length
      ? `<tr><td style="padding:${spec.system || spec.code ? 22 : 30}px ${GUTTER}px 0 ${GUTTER}px;">${blocksHtml(body, tokens)}</td></tr>`
      : "") +
    `<tr><td style="padding:34px 0 0 0;">${footerHtml(spec, tokens)}</td></tr>` +
    `<tr><td style="height:28px;line-height:28px;font-size:0;">&nbsp;</td></tr>` +
    `</table>`
  );
}

function preheader(spec) {
  const first = parseMarkdown(spec.body ?? "").find(
    (node) => node.type === "paragraph",
  );
  return (first?.text ?? spec.subject ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
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
<body class="tl-page" style="margin:0;padding:0;background:${DAY.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader(spec))}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="tl-page" style="table-layout:fixed;background:${DAY.page};">
<tr><td align="center" style="padding:20px 12px 32px 12px;">${renderCard(spec, "day")}</td></tr>
</table>
</body></html>
`;
}

export function renderText(spec) {
  const out = [];

  if (spec.system && !spec.code) {
    const { result } = splitSubject(spec.subject);
    out.push(`${WORDMARK} · ${spec.system.toUpperCase()}`, "", ...wrap(result));
  }

  if (spec.code) out.push("", `    ${spec.code}`);
  if (spec.body?.trim()) {
    if (out.length) out.push("");
    out.push(...blocksText(parseMarkdown(spec.body)));
  }

  out.push("", "--", ...wrap(footerInlineText(spec.reply ?? REPLY_DEFAULT)));

  const context = contextPairs(spec);
  if (context.length) {
    out.push(
      ...wrap(context.map(([label, value]) => `${label} ${value}`).join(" · ")),
    );
  }

  out.push(
    ...wrap(footerInlineText(spec.notice ?? NOTICE_DEFAULT)),
    "Sent via tldr;",
    "",
  );
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
