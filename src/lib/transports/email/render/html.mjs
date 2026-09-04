/* Markdown tree to quiet, client-safe email HTML.
 *
 * Every block becomes a row in one outer table and carries its whole style in a
 * style attribute, because a client that strips <style> must still get the
 * document right. Classes are emitted alongside, and only ever used by the
 * night-lighting media query.
 *
 * The body should read like well-formatted correspondence: one native reading
 * face, restrained neutral structure, and blue reserved for actual links.
 */

import { BODY, MONO, RADIUS, TYPE } from "./tokens.mjs";
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
          return (
            `<code class="tl-code" style="font-family:${MONO};font-size:.95em;` +
            `background:${t.raised};color:${t.ink};border-radius:${RADIUS.sm};` +
            `padding:1px 4px;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;">${esc(node.value)}</code>`
          );
        case "strong":
          return `<strong style="font-weight:700;">${inlineHtml(node.children, t)}</strong>`;
        case "em":
          return `<em style="font-style:italic;">${inlineHtml(node.children, t)}</em>`;
        case "strike":
          return `<span class="tl-muted" style="text-decoration:line-through;color:${t.muted};">${inlineHtml(node.children, t)}</span>`;
        case "link":
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
    `<div class="tl-raised" style="border:1px solid ${t.line};border-radius:${RADIUS.sm};background:${t.raised};padding:12px 14px;">` +
    `<div class="tl-muted" style="${TYPE.tag}color:${t.muted};text-transform:uppercase;padding-bottom:6px;">Image — not loaded</div>` +
    `<div class="tl-ink" style="${TYPE.small}color:${t.ink};">${esc(label)}</div>${href}</div>`
  );
}

/* ---------------------------------------------------------------- blocks */

const GAP = {
  paragraph: 14,
  heading: 28,
  subheading: 22,
  list: 14,
  code: 20,
  table: 20,
  quote: 20,
  rule: 20,
  image: 20,
};

export function blocksHtml(nodes, t, { first = true } = {}) {
  let afterHeading = false;
  let isFirst = first;

  const rows = nodes.map((node) => {
    const gap = isFirst ? 0 : afterHeading ? 8 : GAP[gapKey(node)];
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

function headingHtml(node, t) {
  const text = inlineText(node.text, t);
  if (node.level <= 2) {
    return `<div class="tl-ink" style="${TYPE.section}color:${t.ink};">${text}</div>`;
  }
  return `<div class="tl-ink" style="${TYPE.sub}color:${t.ink};">${text}</div>`;
}

/* Fenced code with an info string takes a muted label above the field. It is how
 * you know at a glance whether you are looking at a shell, a diff or a config. */
function codeHtml(node, t) {
  const lang = node.lang ? node.lang : "";
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
      `padding:12px 14px;${TYPE.code}color:${t.ink};white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-all;">${body}</td></tr>`,
  );
}

function diffLine(line, t) {
  const safe = esc(line) || "&nbsp;";
  if (line.startsWith("@@")) {
    return `<span class="tl-muted" style="color:${t.muted};letter-spacing:.04em;">${safe}</span>`;
  }
  if (line.startsWith("+")) {
    return `<span class="tl-ink" style="color:${t.ink};font-weight:600;">${safe}</span>`;
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
      `<td class="tl-muted" style="padding:0 0 0 14px;color:${t.muted};">${quoteInner(node.children, t)}</td></tr>`,
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

export function bandHtml(label, innerHtml, t) {
  return table(
    `<tr><td class="tl-raised" style="border:1px solid ${t.strongLine};border-radius:${RADIUS.sm};` +
      `background:${t.raised};padding:12px 14px;">` +
      `<div class="tl-ink" style="${TYPE.label}color:${t.ink};padding:0 0 8px 0;">${esc(label)}</div>` +
      `${innerHtml}</td></tr>`,
  );
}

function listHtml(node, t) {
  const rows = node.items.map((item, index) => {
    const marker =
      item.checked === null
        ? node.ordered
          ? `<span class="tl-muted" style="font-family:${BODY};font-size:13px;line-height:1.4;color:${t.muted};">${node.start + index}.</span>`
          : `<span class="tl-muted" style="font-family:${BODY};font-size:13.5px;line-height:1;color:${t.muted};">&bull;</span>`
        : checkbox(item.checked, t);

    const gutter = node.ordered ? 24 : 18;
    const pad = node.loose ? 5 : 3;
    const top = item.checked === null ? pad + (node.ordered ? 2 : 4) : pad + 4;
    return (
      `<tr><td width="${gutter}" align="${node.ordered ? "right" : "left"}" valign="top" ` +
      `style="padding:${top}px 10px ${pad}px 0;line-height:1;">${marker}</td>` +
      `<td valign="top" style="padding:${pad}px 0;">${blocksHtml(item.children, t)}</td></tr>`
    );
  });
  return table(rows.join(""));
}

function checkbox(checked, t) {
  const box = `display:inline-block;width:13px;height:13px;line-height:13px;text-align:center;border-radius:${RADIUS.sm};`;
  return checked
    ? `<span class="tl-check-on" style="${box}background:${t.ink};color:${t.stock};font-family:${BODY};font-size:10px;font-weight:600;">&#10003;</span>`
    : `<span class="tl-check-off" style="${box}border:1px solid ${t.strongLine};">&nbsp;</span>`;
}

function tableHtml(node, t) {
  const last = node.headers.length - 1;
  const head = node.headers
    .map(
      (cell, i) =>
        `<td align="${node.align[i]}" class="tl-ink" style="${TYPE.tableHead}color:${t.ink};` +
        `padding:0 ${i === last ? 0 : 12}px 7px 0;` +
        `border-bottom:1px solid ${t.strongLine};vertical-align:bottom;">${inlineText(cell, t)}</td>`,
    )
    .join("");

  const body = node.rows
    .map(
      (row) =>
        `<tr>${row
          .map(
            (cell, i) =>
              `<td align="${node.align[i]}" class="tl-ink tl-ruled" style="${TYPE.tableCell}color:${t.ink};` +
              `padding:8px ${i === last ? 0 : 12}px 8px 0;border-bottom:1px solid ${t.line};vertical-align:top;">` +
              `${inlineText(cell, t)}</td>`,
          )
          .join("")}</tr>`,
    )
    .join("");

  return table(`<tr>${head}</tr>${body}`);
}

export { table as presentationTable, imagePlaceholder, BODY, MONO };
