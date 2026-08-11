/* tldr; — Markdown tree to plain text.
 *
 * The plain-text twin is an equal document, not a stripped fallback. It comes
 * off the same tree as the HTML, so the two cannot say different things, and it
 * keeps the structure the HTML carries: the TLDR block, banded boxes, ledger
 * tables, a numbered gutter.
 *
 * Fixed 72-column measure. Wider wraps badly in the clients that show plain text
 * at all, and narrower breaks the tables.
 */

import { parseInline } from "./markdown.mjs";
import { bandOf } from "./html.mjs";

export const COLUMNS = 72;

export function wrap(text, width = COLUMNS, indent = "") {
  const out = [];
  for (const paragraph of String(text).split("\n")) {
    if (!paragraph.trim()) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (!line) line = word;
      else if (`${line} ${word}`.length + indent.length <= width)
        line += ` ${word}`;
      else {
        out.push(indent + line);
        line = word;
      }
    }
    if (line) out.push(indent + line);
  }
  return out;
}

export function inlineText(nodes) {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
          return node.value;
        case "break":
        case "softbreak":
          return node.type === "break" ? "\n" : " ";
        case "code":
          return `\`${node.value}\``;
        case "strong":
          return inlineText(node.children).toUpperCase();
        case "em":
          return inlineText(node.children);
        case "strike":
          /* Kept as markers: a retraction that silently vanishes changes the
           * sentence, and the twin has to say the same thing as the HTML. */
          return `~~${inlineText(node.children)}~~`;
        case "link": {
          const label = inlineText(node.children);
          return label === node.href ? node.href : `${label} <${node.href}>`;
        }
        case "image":
          return `[image: ${node.alt || "untitled"}]${node.href ? ` <${node.href}>` : ""}`;
        default:
          return "";
      }
    })
    .join("");
}

const render = (source) => inlineText(parseInline(source));

/* `width` is the measure available to this block's own content. A quote, band
 * or list item spends part of the measure on its prefix and passes the rest
 * down — otherwise the decoration pushes the line past 72 columns. */
export function blocksText(
  nodes,
  indent = "",
  width = COLUMNS - indent.length,
) {
  const out = [];

  nodes.forEach((node, index) => {
    if (index > 0) out.push("");

    switch (node.type) {
      case "paragraph":
        out.push(...wrap(render(node.text), width, indent));
        break;

      case "heading": {
        const text = render(node.text).toUpperCase();
        out.push(indent + text);
        if (node.level <= 2)
          out.push(indent + "=".repeat(Math.min(text.length, width)));
        break;
      }

      case "rule":
        /* Spaced dashes, so a break inside the body cannot be mistaken for one
         * of the solid rules the envelope uses to separate its own parts. */
        out.push(indent + "- ".repeat(Math.floor(width / 2)).trimEnd());
        break;

      case "code": {
        if (node.lang) out.push(`${indent}${node.lang.toUpperCase()}`);
        out.push(...node.lines.map((line) => `${indent}    ${line}`));
        break;
      }

      case "quote": {
        const band = bandOf(node);
        if (band)
          out.push(
            ...bandText(
              band.label,
              blocksText(band.children, "", width - 4),
              indent,
              width,
            ),
          );
        else
          out.push(
            ...blocksText(node.children, "", width - 2).map((line) =>
              `${indent}> ${line}`.trimEnd(),
            ),
          );
        break;
      }

      case "list":
        node.items.forEach((item, i) => {
          const marker =
            item.checked === null
              ? node.ordered
                ? `${node.start + i}.`.padStart(3)
                : "  -"
              : item.checked
                ? "[x]"
                : "[ ]";
          const inner = blocksText(item.children, "", width - 4);
          out.push(`${indent}${marker} ${inner[0] ?? ""}`.trimEnd());
          out.push(
            ...inner.slice(1).map((line) => `${indent}    ${line}`.trimEnd()),
          );
          if (node.loose && i < node.items.length - 1) out.push("");
        });
        break;

      case "table":
        out.push(...tableText(node, indent, width));
        break;

      default:
        break;
    }
  });

  return out;
}

/* +-- CAUTION ------------------+
 * | ...                         |
 * +-----------------------------+ */
export function bandText(label, lines, indent = "", width = COLUMNS) {
  const inner = Math.min(
    Math.max(...lines.map((l) => [...l].length), label.length + 4, 28) + 2,
    width - indent.length - 2,
  );
  return [
    `${indent}+-- ${label} ${"-".repeat(Math.max(inner - label.length - 4, 3))}+`,
    ...lines.map((line) => `${indent}| ${line.padEnd(inner - 1)}|`),
    `${indent}+${"-".repeat(inner)}+`,
  ];
}

/* A table has to fit the measure like everything else. Columns start at their
 * natural width; if the row is too wide the widest column gives up a character
 * at a time until it fits, with a floor at the longest unbreakable word, and
 * the cells that no longer fit wrap onto continuation lines. Truncating would
 * be easier and would silently drop a file path. */
function tableText(node, indent, width) {
  const cells = [
    node.headers.map((h) => render(h).toUpperCase()),
    ...node.rows.map((r) => r.map(render)),
  ];
  const count = node.headers.length;
  const gaps = 2 * (count - 1);

  const widths = node.headers.map((_, i) =>
    Math.max(...cells.map((row) => (row[i] ?? "").length), 1),
  );
  const floors = node.headers.map((_, i) =>
    Math.max(
      ...cells.map((row) =>
        Math.max(
          ...String(row[i] ?? "")
            .split(/\s+/)
            .map((w) => w.length),
          1,
        ),
      ),
    ),
  );

  const available = width - indent.length - gaps;
  let guard = 400;
  while (widths.reduce((a, b) => a + b, 0) > available && guard-- > 0) {
    let widest = -1;
    widths.forEach((w, i) => {
      if (w > floors[i] && (widest === -1 || w > widths[widest])) widest = i;
    });
    if (widest === -1) break;
    widths[widest] -= 1;
  }

  const pad = (value, i) =>
    node.align[i] === "right"
      ? value.padStart(widths[i])
      : value.padEnd(widths[i]);

  const row = (cellsIn) => {
    const columns = cellsIn.map((cell, i) => wrap(cell ?? "", widths[i]));
    const height = Math.max(...columns.map((c) => c.length), 1);
    return Array.from({ length: height }, (_, line) =>
      (
        indent + columns.map((c, i) => pad(c[line] ?? "", i)).join("  ")
      ).trimEnd(),
    );
  };

  return [
    ...row(cells[0]),
    indent + widths.map((w) => "-".repeat(w)).join("  "),
    ...cells.slice(1).flatMap(row),
  ];
}
