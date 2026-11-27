// The ack-first gate's refusal copy (ac-jfv.156): what the agent reads when a
// tool call is refused. Message bodies are sender-controlled and feed a model,
// so they are neutralized and capped here.

import { ARRIVAL_TAG, arrivalField } from "./arrival_block.mjs";

export const ACK_GATE_BODY_CAP = 2000;
// Refusal text feeds a model: show a few messages in full, name the rest.
export const MAX_SHOWN = 3;
const EMBEDDED_TAG = new RegExp(`<(?=\\s*/?\\s*${ARRIVAL_TAG}\\b)`, "gi");

/** A sender-controlled body, safe to print: no spelling of the arrival tag survives, at most 2,000 chars. */
export function neutralizeAckBody(body) {
  const text = String(body ?? "").replace(EMBEDDED_TAG, "&lt;");
  return text.length > ACK_GATE_BODY_CAP
    ? `${text.slice(0, ACK_GATE_BODY_CAP)} [truncated]`
    : text;
}

// Subject and thread when known (a local refusal may know neither).
const describe = (item) =>
  [
    ...(item.subject ? [`Subject: ${arrivalField(item.subject)}`] : []),
    ...(item.thread ? [`Thread: ${item.thread}`] : []),
  ].join(" · ");

/** The refusal while a user message is still unread: read it first, oldest first. */
export function unreadRefusalText(
  item,
  { prefix, nextReceiveMessageId = null },
) {
  const next = nextReceiveMessageId ?? item.message_id;
  return [
    `[tldr] This tool call did not run. Read message ${item.message_id} first: a user is waiting for your reply.`,
    ...(describe(item) ? [describe(item)] : []),
    `Receive command: ${prefix} agent receive --message ${next}`,
    ...(next === item.message_id
      ? []
      : [
          `Receive returns the oldest unread message first (${next}); keep receiving until ${item.message_id} is read.`,
        ]),
    "If receive says an older message must come first, receive the one it names.",
  ].join("\n");
}

/**
 * ac-kf9rt R4: the refusal while a user message whose body the agent was shown
 * is unanswered: reply directly. Showing is not a read; the reply is.
 */
export function shownRefusalText(item, { prefix }) {
  return [
    `[tldr] This tool call did not run. Reply to message ${item.message_id} first: a user is waiting, and you were shown its text.`,
    ...(describe(item) ? [describe(item)] : []),
    FIRST_REPLY_RULE,
    replyCommand(item, prefix),
  ].join("\n");
}

const replyCommand = (item, prefix) =>
  `Reply command: ${prefix} agent reply --message ${item.message_id} --body "<reply>"`;

// Also shown in every user-message notice (arrival_notification.mjs): first replies took 11-17 s to write (ac-jfv.230).
export const FIRST_REPLY_RULE =
  "Reply now in at most two sentences: the answer if you already have it, else what you understood and when the full answer comes; send anything longer as a second reply.";

function commandLines(item, prefix) {
  const work = item.work_id;
  return [
    replyCommand(item, prefix),
    ...(work && item.ack_pending
      ? [`Ack command: ${prefix} agent ack --work ${work} --body "<progress>"`]
      : []),
    ...(work
      ? [
          `Park command: ${prefix} agent delegate --work ${work} --at <when you expect the answer> --body "<what you are doing and when you will report back>"`,
        ]
      : []),
  ];
}

/** The refusal once the message is read and no reply is recorded: the message, the rule, the commands. */
export function readRefusalText(items, { prefix }) {
  const shown = items.slice(0, MAX_SHOWN);
  const blocks = shown.map((item) =>
    [
      [
        `Message ${item.message_id}${item.sender_label ? ` from ${arrivalField(item.sender_label)}` : ""}`,
        describe(item),
      ]
        .filter(Boolean)
        .join(" · "),
      neutralizeAckBody(item.body),
    ].join("\n"),
  );
  const more = items.length - shown.length;
  return [
    "[tldr] This tool call did not run. A user message is waiting for your reply.",
    ...blocks,
    ...(more > 0
      ? [
          `${more} more waiting; run ${prefix} agent inbox --unread to list them.`,
        ]
      : []),
    FIRST_REPLY_RULE,
    ...shown.flatMap((item) => commandLines(item, prefix)),
  ].join("\n");
}
