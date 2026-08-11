/* tldr; — Markdown parser.
 *
 * Agents write the body of an email in Markdown; tldr; renders it. This
 * file turns that Markdown into an abstract tree. It never emits HTML — the
 * HTML and plain-text renderers both consume the same tree, which is how the
 * two twins are kept from drifting apart.
 *
 * Scope: CommonMark blocks and inlines that an agent actually writes, plus the
 * GitHub extensions (tables, task lists, strikethrough, bare autolinks). What
 * is deliberately not supported is listed in SUPPORT at the bottom of the file
 * and rendered on the gallery, so the gap is documented rather than discovered.
 *
 * The agent body is untrusted. This parser never passes raw HTML through: an
 * HTML block is captured as literal text and escaped at render time.
 */

const BULLET = /^([-*+])(\s+|$)/;
const ORDERED = /^(\d{1,9})([.)])(\s+|$)/;
const ATX = /^(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const FENCE = /^(```+|~~~+)\s*([^`]*)$/;
const RULE = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const TASK = /^\[([ xX])\]\s+/;
const DIVIDER = /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/;

const indentOf = (line) => line.length - line.trimStart().length;
const blank = (line) => line.trim() === "";

/* ---------------------------------------------------------------- blocks */

function parseBlocks(lines) {
  const nodes = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (blank(line)) {
      i += 1;
      continue;
    }

    const trimmed = line.trim();

    if (RULE.test(line)) {
      nodes.push({ type: "rule" });
      i += 1;
      continue;
    }

    const fence = FENCE.exec(trimmed);
    if (fence) {
      const [, marker, info] = fence;
      const closer = marker[0];
      const code = [];
      i += 1;
      while (i < lines.length) {
        const candidate = lines[i].trim();
        if (
          candidate.startsWith(closer.repeat(3)) &&
          !candidate.slice(3).includes(closer === "`" ? "`" : "~")
        ) {
          i += 1;
          break;
        }
        code.push(lines[i]);
        i += 1;
      }
      nodes.push({
        type: "code",
        lang: info.trim().split(/\s+/)[0] ?? "",
        lines: dedent(code),
      });
      continue;
    }

    const atx = ATX.exec(trimmed);
    if (atx) {
      nodes.push({
        type: "heading",
        level: atx[1].length,
        text: (atx[2] ?? "").trim(),
      });
      i += 1;
      continue;
    }

    if (trimmed.startsWith(">")) {
      const quoted = [];
      while (
        i < lines.length &&
        (lines[i].trim().startsWith(">") || (!blank(lines[i]) && quoted.length))
      ) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      nodes.push({ type: "quote", children: parseBlocks(quoted) });
      continue;
    }

    /* Indented code, but only where a list cannot claim the indentation. */
    if (
      indentOf(line) >= 4 &&
      !nodes.some((n) => n.type === "list" && n.loose === undefined)
    ) {
      const code = [];
      while (i < lines.length && (indentOf(lines[i]) >= 4 || blank(lines[i]))) {
        code.push(lines[i].slice(4));
        i += 1;
      }
      while (code.length && blank(code[code.length - 1])) code.pop();
      nodes.push({ type: "code", lang: "", lines: code });
      continue;
    }

    const table = readTable(lines, i);
    if (table) {
      nodes.push(table.node);
      i = table.next;
      continue;
    }

    if (BULLET.test(trimmed) || ORDERED.test(trimmed)) {
      const list = readList(lines, i);
      nodes.push(list.node);
      i = list.next;
      continue;
    }

    /* Paragraph: runs until a blank line or a block that interrupts it. */
    const para = [];
    while (i < lines.length && !blank(lines[i])) {
      const candidate = lines[i].trim();
      if (
        para.length &&
        (ATX.test(candidate) ||
          FENCE.test(candidate) ||
          RULE.test(lines[i]) ||
          candidate.startsWith(">") ||
          BULLET.test(candidate) ||
          ORDERED.test(candidate))
      ) {
        break;
      }
      /* Setext heading: the underline belongs to the paragraph above it. */
      if (para.length === 1 && /^(=+|-{2,})\s*$/.test(candidate)) {
        nodes.push({
          type: "heading",
          level: candidate.startsWith("=") ? 1 : 2,
          text: para[0].trim(),
        });
        para.length = 0;
        i += 1;
        break;
      }
      para.push(lines[i]);
      i += 1;
    }
    if (para.length)
      nodes.push({ type: "paragraph", text: para.join("\n").trim() });
  }

  return nodes;
}

function dedent(lines) {
  const widths = lines.filter((l) => !blank(l)).map(indentOf);
  const shift = widths.length ? Math.min(...widths) : 0;
  return lines.map((l) => l.slice(shift));
}

/* ----------------------------------------------------------------- lists */

function readList(lines, start) {
  const first = lines[start].trim();
  const ordered = ORDERED.test(first);
  const items = [];
  const base = indentOf(lines[start]);
  const nested = base + 2;
  let i = start;
  let loose = false;
  const startNumber = ordered ? Number(ORDERED.exec(first)[1]) : null;

  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      /* A blank line inside a list makes it loose; two ends it. */
      if (
        i + 1 < lines.length &&
        !blank(lines[i + 1]) &&
        indentOf(lines[i + 1]) > base
      ) {
        loose = true;
        i += 1;
        continue;
      }
      break;
    }

    const trimmed = line.trim();
    const bullet = BULLET.exec(trimmed);
    const number = ORDERED.exec(trimmed);
    const marker = ordered ? number : bullet;

    /* A list of the other kind, at the same indent, ends this one rather than
     * being swallowed as a continuation line. */
    if (!marker && (ordered ? bullet : number) && indentOf(line) < nested)
      break;

    /* Anything indented past the marker column belongs to the open item —
     * a nested list, a second paragraph, a fenced block. It is dedented and
     * parsed as that item's own content. */
    if (!marker || indentOf(line) >= nested) {
      if (!items.length) break;
      items[items.length - 1].lines.push(
        line.slice(Math.min(indentOf(line), nested)),
      );
      i += 1;
      continue;
    }

    const rest = trimmed.slice(marker[0].length);
    const task = TASK.exec(rest);
    items.push({
      lines: [task ? rest.slice(task[0].length) : rest],
      checked: task ? task[1].toLowerCase() === "x" : null,
    });
    i += 1;
  }

  return {
    node: {
      type: "list",
      ordered,
      start: startNumber ?? 1,
      loose,
      items: items.map((item) => ({
        checked: item.checked,
        children: parseBlocks(item.lines),
      })),
    },
    next: i,
  };
}

/* ---------------------------------------------------------------- tables */

function splitRow(line) {
  const cells = [];
  let cell = "";
  let escaped = false;
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  for (const ch of body) {
    if (escaped) {
      cell += ch;
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function readTable(lines, start) {
  const head = lines[start];
  const divider = lines[start + 1];
  if (!divider || !head.includes("|")) return null;
  if (!DIVIDER.test(divider.trim())) return null;

  const headers = splitRow(head);
  const spec = splitRow(divider);
  if (spec.length !== headers.length) return null;

  const align = spec.map((s) => {
    const left = s.startsWith(":");
    const right = s.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });

  const rows = [];
  let i = start + 2;
  while (i < lines.length && !blank(lines[i]) && lines[i].includes("|")) {
    const cells = splitRow(lines[i]);
    while (cells.length < headers.length) cells.push("");
    rows.push(cells.slice(0, headers.length));
    i += 1;
  }

  return { node: { type: "table", headers, align, rows }, next: i };
}

/* ------------------------------------------------------------------ api */

/* Inlines live in markdown_inline.mjs for the file-size cap, not because they
 * are a separate concern. This is the parser's one public door. */
export { parseInline } from "./markdown_inline.mjs";

export function parseMarkdown(source) {
  const lines = String(source ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .split("\n");
  return parseBlocks(lines);
}

/* Rendered on the gallery. If a row moves, the gallery says so. */
export const SUPPORT = Object.freeze({
  supported: [
    "ATX and setext headings",
    "Paragraphs, hard and soft breaks",
    "Bullet, ordered and nested lists",
    "Task lists (GitHub)",
    "Tables with column alignment (GitHub)",
    "Fenced and indented code, with an info string",
    "Block quotes, including the band forms",
    "Thematic breaks",
    "Links, autolinks and bare URLs",
    "Emphasis, strong, inline code, strikethrough",
    "Backslash escapes",
  ],
  unsupported: [
    [
      "Raw HTML",
      "Escaped and shown as literal text. The agent body is untrusted; it never reaches a client as markup.",
    ],
    [
      "Remote images",
      "Rendered as a labelled placeholder with the URL beneath. Mail clients block them and no information may live only in an image.",
    ],
    [
      "Reference links and footnotes",
      "Rare in agent output, and a broken reference reads as a typo in a 3am email. Write the URL inline.",
    ],
    [
      "Heading anchors and inline anchors",
      "An email has no table of contents to link into.",
    ],
  ],
});
