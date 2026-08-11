/* tldr; — Markdown inlines.
 *
 * Split out of markdown.mjs, which owns blocks. The two halves are one parser
 * conceptually; they are two files because the repo caps a source file at 400
 * lines (scripts/check-file-size.mjs) and the combined parser is past it.
 * markdown.mjs re-exports parseInline, so consumers import from there and never
 * need to know about this boundary.
 *
 * The agent body is untrusted. safeHref is the only place a URL becomes an
 * href, and it fails closed.
 */

const SAFE_SCHEME = /^(https?:|mailto:|#|\/)/i;

function safeHref(raw) {
  const href = raw.trim().replace(/^<|>$/g, "");
  if (SAFE_SCHEME.test(href)) return href;
  if (/^[\w.+-]+@[\w.-]+\.\w+$/.test(href)) return `mailto:${href}`;
  return null;
}

/* Returns a flat list of inline nodes. Emphasis is resolved by a single
 * left-to-right pass with a delimiter stack, which is enough for the nesting
 * agents write and avoids a full CommonMark delimiter run implementation. */
export function parseInline(source) {
  const out = [];
  let text = "";
  let i = 0;

  const flush = () => {
    if (text) out.push({ type: "text", value: text });
    text = "";
  };

  while (i < source.length) {
    const ch = source[i];

    if (
      ch === "\\" &&
      i + 1 < source.length &&
      /[\\`*_{}[\]()#+\-.!|~>]/.test(source[i + 1])
    ) {
      text += source[i + 1];
      i += 2;
      continue;
    }

    if (ch === "\n") {
      const hard = /[ ]{2,}$/.test(text) || text.endsWith("\\");
      text = text.replace(/[ \\]+$/, "");
      flush();
      out.push({ type: hard ? "break" : "softbreak" });
      i += 1;
      continue;
    }

    if (ch === "`") {
      const run = /^`+/.exec(source.slice(i))[0];
      const end = source.indexOf(run, i + run.length);
      if (end !== -1) {
        flush();
        out.push({
          type: "code",
          value: source.slice(i + run.length, end).replace(/^ | $/g, ""),
        });
        i = end + run.length;
        continue;
      }
    }

    if (ch === "!" && source[i + 1] === "[") {
      const link = readLink(source, i + 1);
      if (link) {
        flush();
        out.push({
          type: "image",
          alt: link.label,
          href: safeHref(link.href),
          title: link.title,
        });
        i = link.next;
        continue;
      }
    }

    if (ch === "[") {
      const link = readLink(source, i);
      if (link) {
        const href = safeHref(link.href);
        flush();
        out.push(
          href
            ? { type: "link", href, children: parseInline(link.label) }
            : { type: "text", value: link.label },
        );
        i = link.next;
        continue;
      }
    }

    if (ch === "<") {
      const auto = /^<((?:https?:\/\/|mailto:)[^\s>]+)>/.exec(source.slice(i));
      if (auto) {
        flush();
        out.push({
          type: "link",
          href: auto[1],
          children: [{ type: "text", value: auto[1] }],
        });
        i += auto[0].length;
        continue;
      }
    }

    if (ch === "~" && source[i + 1] === "~") {
      const end = source.indexOf("~~", i + 2);
      if (end !== -1) {
        flush();
        out.push({
          type: "strike",
          children: parseInline(source.slice(i + 2, end)),
        });
        i = end + 2;
        continue;
      }
    }

    if (ch === "*" || ch === "_") {
      const run = new RegExp(`^\\${ch}{1,3}`).exec(source.slice(i))[0];
      /* Intraword underscores are literal: agents write file_names_like_this. */
      const intraword =
        ch === "_" &&
        /\w/.test(source[i - 1] ?? "") &&
        /\w/.test(source[i + run.length] ?? "");
      const close = intraword
        ? -1
        : findCloser(source, i + run.length, ch, run.length);
      if (close !== -1) {
        flush();
        const inner = parseInline(source.slice(i + run.length, close));
        out.push(
          run.length >= 2
            ? { type: "strong", children: inner }
            : { type: "em", children: inner },
        );
        i = close + run.length;
        continue;
      }
    }

    /* Bare URLs. Agents paste them constantly and every client links them. */
    const bare = /^https?:\/\/[^\s<>()[\]]+/.exec(source.slice(i));
    if (bare) {
      const href = bare[0].replace(/[.,;:!?]+$/, "");
      flush();
      out.push({
        type: "link",
        href,
        children: [{ type: "text", value: href }],
      });
      i += href.length;
      continue;
    }

    text += ch;
    i += 1;
  }

  flush();
  return out;
}

function findCloser(source, from, ch, width) {
  for (let i = from; i < source.length; i += 1) {
    if (source[i] === "\\") {
      i += 1;
      continue;
    }
    if (source[i] === "`") {
      const run = /^`+/.exec(source.slice(i))[0];
      const end = source.indexOf(run, i + run.length);
      if (end !== -1) {
        i = end + run.length - 1;
        continue;
      }
    }
    if (source[i] === ch && source.slice(i, i + width) === ch.repeat(width)) {
      if (i === from) continue;
      if (source[i - 1] === " ") continue;
      return i;
    }
  }
  return -1;
}

function readLink(source, at) {
  if (source[at] !== "[") return null;
  let depth = 0;
  let close = -1;
  for (let i = at; i < source.length; i += 1) {
    if (source[i] === "\\") {
      i += 1;
      continue;
    }
    if (source[i] === "[") depth += 1;
    if (source[i] === "]") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1 || source[close + 1] !== "(") return null;

  let depthParen = 0;
  let end = -1;
  for (let i = close + 1; i < source.length; i += 1) {
    if (source[i] === "(") depthParen += 1;
    if (source[i] === ")") {
      depthParen -= 1;
      if (depthParen === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;

  const target = source.slice(close + 2, end).trim();
  const titled = /^(\S+)\s+["'(](.*)["')]$/.exec(target);
  return {
    label: source.slice(at + 1, close),
    href: titled ? titled[1] : target,
    title: titled ? titled[2] : null,
    next: end + 1,
  };
}
