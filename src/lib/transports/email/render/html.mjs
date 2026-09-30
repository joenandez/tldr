/* Markdown tree to the semantic markup of a letter.
 *
 * Every block is the element it actually is — <p>, <h2>, <ul>, <pre>,
 * <blockquote>, <table>, <hr> — with its whole treatment in a style attribute,
 * because no mail client is guaranteed to keep a stylesheet. There are no
 * classes, no presentation tables and no fills: a colleague's client does not
 * emit them, and the moment we do the message stops reading as a message.
 *
 * The agent body is untrusted. `esc` is the boundary, and an image is described
 * rather than fetched.
 */

import { HAIRLINE, HEAD_RULE, MONO, MUTED, RULE, SIZE } from "./tokens.mjs";
import { parseInline } from "./markdown.mjs";

export function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PARAGRAPH = 'style="margin:0 0 15px"';
const CODE_FACE = `font-family:${MONO};font-size:${SIZE.code}`;

/* --------------------------------------------------------------- inlines */

export function inlineHtml(nodes) {
  return nodes.map(inlineNode).join("");
}

function inlineNode(node) {
  switch (node.type) {
    case "text":
      return esc(node.value);
    case "break":
      return "<br>";
    case "softbreak":
      return " ";
    case "code":
      return `<code style="${CODE_FACE}">${esc(node.value)}</code>`;
    case "strong":
      /* <strong>/<em> rather than <b>/<i>: the plain-text twin turns the same
       * node into caps, so the emphasis is meaning, not weight. <b> is reserved
       * for the two places the letter uses weight as a mark — a callout label
       * and an added diff line. */
      return `<strong>${inlineHtml(node.children)}</strong>`;
    case "em":
      return `<em>${inlineHtml(node.children)}</em>`;
    case "strike":
      return `<s>${inlineHtml(node.children)}</s>`;
    case "link":
      /* No colour: the client's own link colour is the one the reader already
       * knows means "link" in their inbox. */
      return `<a href="${esc(node.href)}">${inlineHtml(node.children)}</a>`;
    case "image":
      return imagePlaceholder(node);
    default:
      return "";
  }
}

const inlineOf = (source) => inlineHtml(parseInline(source));

/* Mail clients block remote images and no information may live only in one, so
 * an image is named, not loaded. The alt text is the content and the URL is
 * offered as a link the reader chooses to follow. */
function imagePlaceholder(node) {
  const label = node.alt?.trim() || "Image";
  const href = node.href
    ? ` <a href="${esc(node.href)}">${esc(node.href)}</a>`
    : "";
  return `<span style="color:${MUTED}">[Image: ${esc(label)}]</span>${href}`;
}

/* ---------------------------------------------------------------- blocks */

export function blocksHtml(nodes) {
  return nodes.map(blockHtml).join("");
}

function blockHtml(node) {
  switch (node.type) {
    case "paragraph":
      return `<p ${PARAGRAPH}>${inlineOf(node.text)}</p>`;
    case "heading":
      return headingHtml(node);
    case "rule":
      return `<hr style="border:0;border-top:1px solid ${HAIRLINE};margin:20px 0">`;
    case "code":
      return codeHtml(node);
    case "quote":
      return quoteHtml(node);
    case "list":
      return listHtml(node);
    case "table":
      return tableHtml(node);
    default:
      return "";
  }
}

function headingHtml(node) {
  const text = inlineOf(node.text);
  if (node.level <= 2) {
    return `<h2 style="font-size:${SIZE.heading};line-height:1.35;font-weight:bold;margin:26px 0 8px">${text}</h2>`;
  }
  return `<h3 style="font-size:${SIZE.subheading};line-height:1.4;font-weight:bold;margin:20px 0 6px">${text}</h3>`;
}

/* A fence is a <pre>: the element already means "these line breaks are the
 * content". A left rule marks it without a fill, so an inverting client has
 * nothing to repaint. */
function codeHtml(node) {
  const body =
    node.lang.toLowerCase() === "diff"
      ? node.lines.map(diffLine).join("\n")
      : node.lines.map((line) => esc(line) || " ").join("\n");

  return (
    `<pre style="${CODE_FACE};line-height:1.5;border-left:1px solid ${RULE};` +
    `padding:2px 0 2px 12px;margin:0 0 15px;white-space:pre-wrap;` +
    `overflow-wrap:anywhere">${body}</pre>`
  );
}

/* Weight, not colour, carries the addition: it is the one thing that reads the
 * same in a client that has decided to recolour the block. */
function diffLine(line) {
  const safe = esc(line) || " ";
  return line.startsWith("+")
    ? `<b>${safe}</b>`
    : `<span style="color:${MUTED}">${safe}</span>`;
}

/* A quote whose first line is a bold CAUTION / NOTE / ABORT is the Markdown an
 * agent reaches for to raise the register. It becomes a bold label sentence in
 * the flow rather than a box — a person writes "CAUTION." and keeps going. */
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

function quoteHtml(node) {
  const band = bandOf(node);
  if (band) return bandHtml(band.label, band.children);
  return (
    `<blockquote style="margin:0 0 15px;padding:0 0 0 14px;` +
    `border-left:1px solid ${RULE};color:${MUTED}">${blocksHtml(node.children)}</blockquote>`
  );
}

/* The label always closes its own <p> — a block from the rest of the callout
 * is never interpolated inside it. Only a leading paragraph joins the label
 * sentence; anything after that (a second paragraph, a list, a fence) renders
 * as its own sibling block following the label paragraph. */
export function bandHtml(label, children) {
  const [first, ...rest] = children;
  const sentence = first?.type === "paragraph" ? inlineOf(first.text) : "";
  const tailNodes = first?.type === "paragraph" ? rest : children;
  const head = sentence
    ? `<p ${PARAGRAPH}><b>${esc(label)}.</b> ${sentence}</p>`
    : `<p ${PARAGRAPH}><b>${esc(label)}.</b></p>`;
  return head + blocksHtml(tailNodes);
}

function listHtml(node) {
  const tag = node.ordered ? "ol" : "ul";
  const start =
    node.ordered && node.start !== 1 ? ` start="${node.start}"` : "";
  const items = node.items.map(listItemHtml).join("");
  return `<${tag} style="margin:0 0 15px;padding-left:24px"${start}>${items}</${tag}>`;
}

/* A task item pulls its own glyph back into the gutter the bullet vacated, so
 * ☑ and ☐ line up with the plain items above and below them. */
function listItemHtml(item) {
  const inner = itemInner(item.children);
  if (item.checked === null || item.checked === undefined) {
    return `<li style="margin:0 0 4px">${inner}</li>`;
  }
  const glyph = item.checked ? "☑" : "☐";
  return `<li style="margin:0 0 4px;list-style:none;margin-left:-22px">${glyph}&nbsp; ${inner}</li>`;
}

/* An item's own prose is not a paragraph block — <p> inside <li> opens a gap
 * the writer did not put there. Anything else (a nested list, a fence) is the
 * block it is. */
function itemInner(children) {
  return children
    .map((child) =>
      child.type === "paragraph" ? inlineOf(child.text) : blockHtml(child),
    )
    .join("");
}

function tableHtml(node) {
  const head = node.headers
    .map(
      (cell, i) =>
        `<th style="text-align:${node.align[i]};font-weight:bold;padding:6px 18px 6px 0;` +
        `border-bottom:1px solid ${HEAD_RULE};font-size:${SIZE.table};vertical-align:bottom">` +
        `${inlineOf(cell)}</th>`,
    )
    .join("");

  const body = node.rows
    .map(
      (row) =>
        `<tr>${row.map((cell, i) => cellHtml(cell, i, node)).join("")}</tr>`,
    )
    .join("");

  return (
    `<table style="border-collapse:collapse;margin:0 0 18px;` +
    `font-variant-numeric:lining-nums tabular-nums"><tr>${head}</tr>${body}</table>`
  );
}

function cellHtml(cell, index, node) {
  return (
    `<td style="text-align:${node.align[index]};padding:6px 18px 6px 0;` +
    `border-bottom:1px solid ${HAIRLINE};font-size:${SIZE.table};vertical-align:top;` +
    `font-variant-numeric:lining-nums tabular-nums">${inlineOf(cell)}</td>`
  );
}

export { imagePlaceholder, MONO };
