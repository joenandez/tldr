/* tldr; — Markdown tree to email HTML.
 *
 * Every block becomes a row in one outer table and carries its whole style in a
 * style attribute, because a client that strips <style> must still get the
 * document right. Classes are emitted alongside, and only ever used by the
 * night-lighting media query.
 *
 * Rules this file exists to hold:
 *   - flat. A change of plane or a 1px boundary, never a shadow.
 *   - the reading face sets every sentence; the condensed face sets short
 *     phrases and meaningful numerals; mono sets things you could type.
 *   - no citron. The live edge is the envelope's judgment about the message,
 *     not something the agent's Markdown can reach for. Nothing in this file
 *     can emit the accent, which is a stronger guarantee than a budget.
 */

import { BODY, DISPLAY, MONO, RADIUS, TYPE } from "./tokens.mjs";
import { parseInline } from "./markdown.mjs";

export function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const table = (inner, style = "") =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;${style}">${inner}</table>`;

/* --------------------------------------------------------------- inlines */

export function inlineHtml(nodes, t) {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
          return esc(node.value);
        case "break":
          return "<br>";
        case "softbreak":
          return " ";
        case "code":
          /* Identifiers, flags and file paths — the densest thing in agent
           * prose, six to a paragraph in a real handoff.
           *
           * The chip is a fill and not a bounded box. A 1px boundary around
           * every identifier puts four hard edges into the middle of a sentence
           * and the paragraph stops being readable; the powder fill separates
           * the token just as clearly with no edge at all. A code block is a
           * slab and gets the boundary; an identifier is a word and gets a
           * highlight. */
          return (
            `<code class="tl-code" style="font-family:${MONO};font-size:.95em;` +
            `background:${t.field};color:${t.ink};border-radius:${RADIUS.sm};` +
            `padding:1px 4px;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;">${esc(node.value)}</code>`
          );
        case "strong":
          return `<strong style="font-weight:700;">${inlineHtml(node.children, t)}</strong>`;
        case "em":
          return `<em style="font-style:italic;">${inlineHtml(node.children, t)}</em>`;
        case "strike":
          return `<span class="tl-muted" style="text-decoration:line-through;color:${t.muted};">${inlineHtml(node.children, t)}</span>`;
        case "link":
          /* Link blue, underlined, always. The identity colour is the one the
           * whole world already reads as "this goes somewhere". */
          return (
            `<a class="tl-link" href="${esc(node.href)}" style="color:${t.link};` +
            `text-decoration:underline;overflow-wrap:anywhere;word-break:break-word;">${inlineHtml(node.children, t)}</a>`
          );
        case "image":
          return imagePlaceholder(node, t);
        default:
          return "";
      }
    })
    .join("");
}

const inlineText = (source, t) => inlineHtml(parseInline(source), t);

/* Mail clients block remote images and no information may live only in one, so
 * an image is drawn, not loaded. The alt text is the content. */
function imagePlaceholder(node, t) {
  const label = node.alt?.trim() || "Image";
  const href = node.href
    ? `<div style="${TYPE.tag}color:${t.muted};padding-top:6px;word-break:break-all;" class="tl-muted">` +
      `<a class="tl-muted" href="${esc(node.href)}" style="color:${t.muted};text-decoration:underline;">${esc(node.href)}</a></div>`
    : "";
  return (
    `<div class="tl-raised" style="border:1px solid ${t.line};border-radius:${RADIUS.sm};background:${t.raised};padding:14px 16px;">` +
    `<div class="tl-muted" style="${TYPE.tag}color:${t.muted};text-transform:uppercase;padding-bottom:6px;">Image — not loaded</div>` +
    `<div class="tl-ink" style="${TYPE.small}color:${t.ink};">${esc(label)}</div>${href}</div>`
  );
}

/* ---------------------------------------------------------------- blocks */

/* The declared spacing scale. A normal transition is 24; a major reading
 * section separates by 40; a heading always takes more space above than below. */
const GAP = {
  paragraph: 16,
  heading: 40,
  subheading: 28,
  list: 16,
  code: 24,
  table: 24,
  quote: 24,
  rule: 24,
  image: 24,
};

export function blocksHtml(nodes, t, { first = true } = {}) {
  let afterHeading = false;
  let isFirst = first;

  const rows = nodes.map((node) => {
    const gap = isFirst ? 0 : afterHeading ? 12 : GAP[gapKey(node)];
    isFirst = false;
    afterHeading = node.type === "heading";
    return `<tr><td style="padding:${gap}px 0 0 0;">${blockHtml(node, t)}</td></tr>`;
  });

  return table(rows.join(""));
}

function gapKey(node) {
  if (node.type === "heading")
    return node.level <= 2 ? "heading" : "subheading";
  return GAP[node.type] ? node.type : "paragraph";
}

function blockHtml(node, t) {
  switch (node.type) {
    case "paragraph": {
      const only = onlyImage(node);
      if (only) return imagePlaceholder(only, t);
      return `<div class="tl-ink" style="${TYPE.body}color:${t.ink};">${inlineText(node.text, t)}</div>`;
    }

    case "heading":
      return headingHtml(node, t);

    case "rule":
      /* A 1px rule across the measure. The hairline is a div inside the cell —
       * a cell with a background grows to the row's height and prints as a bar. */
      return table(
        `<tr><td style="padding:0;">` +
          `<div class="tl-hair" style="height:1px;background:${t.line};font-size:0;line-height:1px;">&nbsp;</div></td></tr>`,
      );

    case "code":
      return codeHtml(node, t);

    case "quote":
      return quoteHtml(node, t);

    case "list":
      return listHtml(node, t);

    case "table":
      return tableHtml(node, t);

    default:
      return "";
  }
}

function onlyImage(node) {
  const parsed = parseInline(node.text);
  const meaningful = parsed.filter(
    (n) => !(n.type === "text" && !n.value.trim()),
  );
  return meaningful.length === 1 && meaningful[0].type === "image"
    ? meaningful[0]
    : null;
}

/* The subject owns the top of the document, so `#` is a section rather than a
 * competing title. Sections are where the condensed face does its work: a short
 * phrase at 21px over a 1px link-blue rule. */
function headingHtml(node, t) {
  const text = inlineText(node.text, t);
  if (node.level <= 2) {
    return table(
      `<tr><td class="tl-ink" style="${TYPE.section}color:${t.ink};padding:0 0 8px 0;">${text}</td></tr>` +
        `<tr><td style="padding:0;"><div class="tl-hair-link" style="height:1px;background:${t.link};font-size:0;line-height:1px;">&nbsp;</div></td></tr>`,
    );
  }
  return `<div class="tl-muted" style="${TYPE.sub}color:${t.muted};">${text}</div>`;
}

/* Fenced code with an info string takes a muted label above the field. It is how
 * you know at a glance whether you are looking at a shell, a diff or a config. */
function codeHtml(node, t) {
  const lang = node.lang ? node.lang.toUpperCase() : "";
  const label = lang
    ? `<tr><td class="tl-muted" style="${TYPE.tag}color:${t.muted};padding:0 0 6px 0;">${esc(lang)}</td></tr>`
    : "";

  const body =
    node.lang.toLowerCase() === "diff"
      ? node.lines.map((line) => diffLine(line, t)).join("<br>")
      : node.lines.map((line) => esc(line) || "&nbsp;").join("<br>");

  return table(
    label +
      `<tr><td class="tl-raised" style="border:1px solid ${t.line};border-radius:${RADIUS.sm};background:${t.raised};` +
      `padding:14px 16px;${TYPE.code}color:${t.ink};white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;">${body}</td></tr>`,
  );
}

/* No red and no green, anywhere. A diff is weighted instead: additions at full
 * ink and bold, removals receded, hunk headers set as labels. It survives a
 * monochrome print and a colour-blind reader unchanged. */
function diffLine(line, t) {
  const safe = esc(line) || "&nbsp;";
  if (line.startsWith("@@")) {
    return `<span class="tl-muted" style="color:${t.muted};letter-spacing:.04em;">${safe}</span>`;
  }
  if (line.startsWith("+")) {
    return `<span class="tl-ink" style="color:${t.ink};font-weight:700;">${safe}</span>`;
  }
  return `<span class="tl-muted" style="color:${t.muted};">${safe}</span>`;
}

/* A quote whose first line is a bold CAUTION / NOTE / ABORT becomes a banded
 * box — the Markdown an agent can reach for to raise the register. Everything
 * else stays an ordinary quote. */
const BANDS = new Set(["CAUTION", "NOTE", "ABORT"]);

export function bandOf(node) {
  const first = node.children?.[0];
  if (!first || first.type !== "paragraph") return null;
  const match = /^\*\*([A-Z]{3,10})\*\*\s*(?::|\n|$)/.exec(first.text.trim());
  if (!match || !BANDS.has(match[1])) return null;
  const rest = first.text.trim().slice(match[0].length).trim();
  return {
    label: match[1],
    children: [
      ...(rest ? [{ type: "paragraph", text: rest }] : []),
      ...node.children.slice(1),
    ],
  };
}

function quoteHtml(node, t) {
  const band = bandOf(node);
  if (band) return bandHtml(band.label, blocksHtml(band.children, t), t);
  return table(
    `<tr><td width="1" class="tl-hair" style="background:${t.line};width:1px;font-size:0;line-height:1px;">&nbsp;</td>` +
      `<td class="tl-muted" style="padding:0 0 0 16px;color:${t.muted};">${quoteInner(node.children, t)}</td></tr>`,
  );
}

function quoteInner(children, t) {
  return blocksHtml(
    children.map((child) =>
      child.type === "paragraph" ? { ...child, quoted: true } : child,
    ),
    { ...t, ink: t.muted },
  );
}

/* The banded box: a solid identity-plane tab over a bounded field. Bands are
 * told apart by the word, never by a colour — there is no warning amber and no
 * error red in this system, and a reader who cannot separate two hues still
 * reads CAUTION and ABORT perfectly. */
export function bandHtml(label, innerHtml, t) {
  return table(
    `<tr><td style="padding:0;"><span class="tl-tab" style="display:inline-block;background:${t.solid};` +
      `color:${t.onSolid};${TYPE.chip}text-transform:uppercase;border-radius:${RADIUS.sm} ${RADIUS.sm} 0 0;padding:5px 10px;">${esc(label)}</span></td></tr>` +
      `<tr><td class="tl-raised" style="border:1px solid ${t.line};border-radius:0 ${RADIUS.sm} ${RADIUS.sm} ${RADIUS.sm};` +
      `background:${t.raised};padding:14px 16px;">${innerHtml}</td></tr>`,
  );
}

/* Lists are tables. Real <ul>/<ol> lose their indentation in Outlook, and the
 * numerals belong in a fixed gutter anyway. */
function listHtml(node, t) {
  const rows = node.items.map((item, index) => {
    const marker =
      item.checked === null
        ? node.ordered
          ? /* The numeral device: an oversized condensed figure indexing a real
             * step. Numerals are never decorative and never invented. */
            `<span class="tl-link" style="${TYPE.numeral}color:${t.link};">${node.start + index}</span>`
          : `<span class="tl-line" style="font-family:${BODY};font-size:16px;line-height:1;color:${t.line};">&#8212;</span>`
        : checkbox(item.checked, t);

    const gutter = node.ordered ? 30 : 22;
    const pad = node.loose ? 6 : 3;
    /* A 20px numeral and a 16px body line do not share a baseline on their own,
     * and a checkbox is a block in a line box rather than a glyph on a baseline.
     * Each marker gets the offset that seats it optically. */
    const top = item.checked === null ? pad + (node.ordered ? 1 : 5) : pad + 5;
    return (
      `<tr><td width="${gutter}" align="${node.ordered ? "right" : "left"}" valign="top" ` +
      `style="padding:${top}px 10px ${pad}px 0;line-height:1;">${marker}</td>` +
      `<td valign="top" style="padding:${pad}px 0;">${blocksHtml(item.children, t)}</td></tr>`
    );
  });
  return table(rows.join(""));
}

/* Completion has no colour of its own: a done item is a solid identity-plane box
 * with the check reversed out of it, so if a client drops the glyph the filled
 * box still reads as done. */
function checkbox(checked, t) {
  const box = `display:inline-block;width:13px;height:13px;line-height:13px;text-align:center;border-radius:${RADIUS.sm};`;
  return checked
    ? `<span class="tl-check-on" style="${box}background:${t.solid};color:${t.onSolid};font-family:${BODY};font-size:10px;font-weight:700;">&#10003;</span>`
    : `<span class="tl-check-off" style="${box}border:1px solid ${t.line};">&nbsp;</span>`;
}

/* A ledger, not a grid: condensed caps heads over a solid rule, 1px separators
 * between rows, no cell borders and no zebra. */
function tableHtml(node, t) {
  const last = node.headers.length - 1;
  const head = node.headers
    .map(
      (cell, i) =>
        `<td align="${node.align[i]}" class="tl-ink" style="${TYPE.tableHead}color:${t.ink};` +
        `text-transform:uppercase;padding:0 ${i === last ? 0 : 14}px 8px 0;` +
        `border-bottom:1px solid ${t.ink};vertical-align:bottom;">${inlineText(cell, t)}</td>`,
    )
    .join("");

  const body = node.rows
    .map(
      (row) =>
        `<tr>${row
          .map(
            (cell, i) =>
              `<td align="${node.align[i]}" class="tl-ink tl-ruled" style="${TYPE.tableCell}color:${t.ink};` +
              `padding:9px ${i === last ? 0 : 14}px 9px 0;border-bottom:1px solid ${t.line};vertical-align:top;">` +
              `${inlineText(cell, t)}</td>`,
          )
          .join("")}</tr>`,
    )
    .join("");

  return table(`<tr>${head}</tr>${body}`);
}

export { table as presentationTable, imagePlaceholder, DISPLAY, BODY, MONO };
