/* Message semantics retained independently from presentation.
 *
 * State/action resolution still supports callers and future optional summaries,
 * but the ordinary correspondence renderer does not turn it into a branded
 * panel or badge. The agent's words own the visible hierarchy.
 */

import { inlineHtml } from "./html.mjs";
import { parseInline, parseMarkdown } from "./markdown.mjs";

export const ACTION = Object.freeze({
  now: "Needs you now",
  later: "Can wait",
  none: "Nothing needed",
});

const NOW_STATES =
  /^(needs you|needs text|blocked|can[’']?t resume|action needed|verify)/i;
const NONE_STATES =
  /^(done|got it|complete|completed|finished|delivered|text only)/i;
const IDENTIFIER = /^[^\s]*[_/.\-@][^\s]*/;

const sentenceCase = (value) =>
  IDENTIFIER.test(value) || !/^[a-z]/.test(value)
    ? value
    : value[0].toUpperCase() + value.slice(1);

export function splitSubject(subject) {
  const match = /^([^:]{2,24}):\s*(.+)$/s.exec(String(subject).trim());
  if (!match) return { state: null, result: String(subject).trim() };
  return { state: match[1].trim(), result: sentenceCase(match[2].trim()) };
}

export function resolveAction(spec) {
  if (spec.action && ACTION[spec.action]) return spec.action;

  const raised = parseMarkdown(spec.body ?? "").some((node) => {
    if (node.type !== "quote") return false;
    const text = node.children?.[0]?.text?.trim() ?? "";
    return /^\*\*(CAUTION|ABORT)\*\*/.test(text);
  });
  if (raised) return "now";

  const { state } = splitSubject(spec.subject ?? "");
  if (state && NOW_STATES.test(state)) return "now";
  if (state && NONE_STATES.test(state)) return "none";
  return "later";
}

export const isLive = (spec) => resolveAction(spec) === "now";
export const inlineMarkdownHtml = (value, tokens) =>
  inlineHtml(parseInline(value), tokens);
