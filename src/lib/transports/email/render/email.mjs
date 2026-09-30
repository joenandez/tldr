/* The letter: what an owner actually receives.
 *
 * A message opens with the agent's first sentence, ends with the agent's name,
 * and puts everything the product needs to say below a short rule in a small
 * sans block. There is no masthead, no repeated subject, no summary panel, no
 * action chip, no preheader and no card — the document is the wrapper div and
 * the blocks inside it, which is what a person's mail client emits.
 *
 * System mail is the same letter signed `tldr;`. It carries no identity line
 * and no derived heading: the sender and the subject already say who is
 * writing, and a verification code deserves exactly one focal point.
 */

import {
  LEADING,
  MEASURE,
  MONO,
  MUTED,
  RULE,
  SANS,
  SERIF,
  SIZE,
} from "./tokens.mjs";
import { parseInline, parseMarkdown } from "./markdown.mjs";
import { blocksHtml, esc } from "./html.mjs";
import { blocksText, inlineText, wrap } from "./text.mjs";
import {
  ACTION,
  inlineMarkdownHtml,
  resolveAction,
  splitSubject,
} from "./tldr.mjs";

export const AGENTS = Object.freeze({
  claude: { label: "Claude Code", adapter: "claude", signoff: "Claude" },
  codex: { label: "Codex", adapter: "codex", signoff: "Codex" },
});

const RUNTIME_ALIASES = Object.freeze({
  "claude-code": "claude",
});
const RUNTIME_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const titleCaseRuntime = (runtime) =>
  runtime
    .split("-")
    .map((part) =>
      part === "cli"
        ? "CLI"
        : `${part.charAt(0).toUpperCase()}${part.slice(1)}`,
    )
    .join(" ");

/* The runtime is audited Tightbeam endpoint identity, not agent-authored copy.
 * Known adapters keep their product spelling. A newly supported kebab-case
 * runtime still signs with its own readable name without inheriting an old
 * provider's identity while the presentation catalog catches up. */
export function agentForRuntime(runtime) {
  if (typeof runtime !== "string") return null;
  const canonical = RUNTIME_ALIASES[runtime] ?? runtime;
  const known = Object.values(AGENTS).find(
    (entry) => entry.adapter === canonical,
  );
  if (known) return known;
  if (!RUNTIME_ID.test(runtime)) return null;
  const label = titleCaseRuntime(runtime);
  return Object.freeze({ label, adapter: runtime, signoff: label });
}

const REPLY_DEFAULT =
  "Reply to this email. The same session picks it up, in the same directory.";
const NOTICE_DEFAULT =
  "Only replies from your verified address reach the session.";

const SYSTEM_SIGNOFF = "tldr;";
const DEFAULT_SIGNOFF = "Agent";

const WRAPPER =
  `font-family:${SERIF};font-size:${SIZE.body};` +
  `line-height:${LEADING};max-width:${MEASURE}px`;

const SIGNATURE_BLOCK =
  `margin:0;font-family:${SANS};font-size:${SIZE.signature};` +
  `line-height:${LEADING};color:${MUTED}`;

/* The signature names four things and nothing else. A specimen's panel also
 * carries timestamps, which belong in the body of a message if they belong
 * anywhere; the signature answers where it ran, who ran it, and which session a
 * reply lands in. A Map rather than an object literal, so a row labelled
 * `toString` cannot inherit a match. */
const CONTEXT_ORDER = ["AGENT", "DIRECTORY", "BRANCH", "SESSION"];

const contextMap = (spec) =>
  new Map(
    [
      ...(spec.agent ? [["AGENT", spec.agent.label]] : []),
      ...(spec.statePanel ?? []),
    ]
      .filter(([, value]) => value)
      .map(([label, value]) => [String(label).toUpperCase(), String(value)]),
  );

export const contextPairs = (spec) => {
  const context = contextMap(spec);
  return CONTEXT_ORDER.filter((label) => context.has(label)).map((label) => [
    label.toLowerCase(),
    context.get(label),
  ]);
};

/* `session 1f4a9c2` reads; a bare id beside a branch name does not. */
const contextLine = (spec) =>
  contextPairs(spec)
    .map(([label, value]) => (label === "session" ? `session ${value}` : value))
    .join(" · ");

const signoffOf = (spec) =>
  spec.system ? SYSTEM_SIGNOFF : (spec.agent?.signoff ?? DEFAULT_SIGNOFF);

function signatureHtml(spec) {
  const line = contextLine(spec);
  return (
    `<p style="margin:24px 0 0">${esc(signoffOf(spec))}</p>` +
    `<div style="width:56px;border-top:1px solid ${RULE};margin:18px 0 10px"></div>` +
    `<p style="${SIGNATURE_BLOCK}">` +
    (line ? `${esc(line)}<br>` : "") +
    `${inlineMarkdownHtml(spec.reply ?? REPLY_DEFAULT)}<br>` +
    `${inlineMarkdownHtml(spec.notice ?? NOTICE_DEFAULT)}<br>` +
    `Sent via tldr;</p>`
  );
}

/* The code is the message. It is set once, large and letter-spaced, above the
 * sentence that explains it — never repeated into a heading or a preheader. */
const codePlateHtml = (spec) =>
  spec.code
    ? `<p style="margin:0 0 20px;font-family:${MONO};font-size:${SIZE.code_plate};letter-spacing:.12em">${esc(spec.code)}</p>`
    : "";

export function renderHtml(spec) {
  const letter =
    `<div style="${WRAPPER}">` +
    codePlateHtml(spec) +
    blocksHtml(parseMarkdown(spec.body ?? "")) +
    signatureHtml(spec) +
    `</div>`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body>
${letter}
</body></html>
`;
}

/* The reply and notice lines are the product's own Markdown — the recovery
 * state says ``Run `tldr-agents status` ``. The twin resolves the same tree the HTML
 * does and keeps the backticks, which in 72 columns of ASCII are the code
 * treatment. */
const plainInline = (value) => inlineText(parseInline(value));

export function renderText(spec) {
  const out = [];

  if (spec.code) out.push(`    ${spec.code}`);
  if (spec.body?.trim()) {
    if (out.length) out.push("");
    out.push(...blocksText(parseMarkdown(spec.body)));
  }

  out.push("", signoffOf(spec), "--");

  const line = contextLine(spec);
  if (line) out.push(...wrap(line));

  out.push(
    ...wrap(plainInline(spec.reply ?? REPLY_DEFAULT)),
    ...wrap(plainInline(spec.notice ?? NOTICE_DEFAULT)),
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
