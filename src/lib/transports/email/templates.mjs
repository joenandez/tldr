/* The seam between the product and the email renderer.
 *
 * renderTldrAgentEmail keeps its exported name — four call sites depend on it,
 * and the module namespace is on the repository's side of the rename, not the
 * owner's. Everything it renders says `tldr;`.
 *
 * There is no `heading` any more. The envelope flows the subject into the TLDR
 * block, so a heading would be the subject said twice. Callers may still pass
 * one; it is ignored.
 */

import { AGENTS, render } from "./render/email.mjs";

const TEMPLATE_VERSION = "tldr-email-v3";

const VALID_STATES = new Set([
  "conversation",
  "acknowledgement",
  "recovery",
  "attachment_ignored",
  "attachment_only",
  "verification_code",
  "owner_changed",
  "key_replaced",
]);

/* The word in the system bar, per state.
 *
 * A system message is tldr; speaking as itself, and it must not be mistakable
 * for the agent: without the bar, "Can't resume: your reply arrived, the session
 * did not" reads like the agent writing about itself. A conversation is the
 * agent speaking and deliberately carries no bar.
 *
 * The vocabulary is four words wide on purpose. A fifth is a distinction the
 * owner has to learn. SECURITY is separate from ERROR because a message about
 * the owner's credentials is not a message about the owner's code. */
const SYSTEM_KIND = Object.freeze({
  acknowledgement: "Receipt",
  recovery: "Error",
  attachment_only: "Error",
  attachment_ignored: "Notice",
  verification_code: "Security",
  owner_changed: "Security",
  key_replaced: "Security",
});

/* Bodies are Markdown, because the renderer takes Markdown and because these are
 * read beside agent-written messages that are. The copy is the approved specimen
 * copy — docs/brand/specimens.mjs renders exactly these words, so the gallery is
 * showing what actually ships.
 *
 * Every state needs a body. The envelope has no heading to fall back on, so a
 * state without one renders an empty message.
 *
 * `action` is declared on every state here rather than left to the derivation.
 * The derivation exists for agent messages, which nobody configures; a shipping
 * system state should never be one regex away from telling an owner that
 * something needs them when it does not. */
const DEFAULTS = Object.freeze({
  conversation: {
    subject: "Update from your agent",
    body: "",
  },
  acknowledgement: {
    action: "none",
    subject: "Got it: your reply reached the session",
    body: `The session is running again. I'll write back here with the result.`,
  },
  recovery: {
    action: "now",
    subject: "Can't resume: your reply arrived, the session did not",
    body: `The original session could not be resumed, and a different one was not
started in its place — a new session would not have your context.

On the machine running the agent:

\`\`\`bash
tldr status
\`\`\``,
    reply: "Run `tldr status` for the next repair step.",
  },
  attachment_ignored: {
    action: "none",
    subject:
      "Delivered: your text reached the session, the attachments did not",
    body: `Attachments aren't handled yet, so they were not shared with the agent.

If the agent needs what's in them, paste it as text.`,
  },
  attachment_only: {
    action: "now",
    subject: "Needs text: that reply was attachments only",
    body: `There was nothing to hand the agent, so the session was not resumed.

Reply again with the information as text and it picks up from where it
stopped.`,
    reply: "Reply again with the information as text.",
  },

  /* The broker's states. These reach an owner before the product works, so they
   * are the first thing the brand ever says — and the verification code is the
   * one message most likely to be checked for legitimacy. `__TLDR_CODE__` is
   * substituted by the broker at send time. */
  verification_code: {
    action: "now",
    subject: "Verify: your code is __TLDR_CODE__",
    code: "__TLDR_CODE__",
    body: `It finishes connecting this address, and it is single-use and expires in
10 minutes.

> **CAUTION**: Enter it only in the setup app on your own Mac. An agent will
> never ask you for it, and neither will anyone else.

If you didn't ask for this code, you can ignore this email.`,
    reply: "Enter the code in the setup app. Replying here does nothing.",
    notice: "Sent because this address was entered during setup.",
  },
  owner_changed: {
    action: "now",
    subject: "Changed: this address is no longer the verified owner",
    body: `The installation that used this address now has a different verified
owner.

If you didn't make this change, secure the Mac and review the installation
on it.`,
    reply: "No reply is needed. This notice is a record of the change.",
    notice: "Sent to the previous owner whenever ownership moves.",
  },
  key_replaced: {
    action: "now",
    subject: "Replaced: the AgentMail key for this inbox was changed",
    body: `The API key was replaced after the same inbox was verified again. The
owner did not change.

If you didn't make this change, secure the Mac and review your AgentMail
credentials.`,
    reply: "No reply is needed. This notice is a record of the change.",
    notice: "Sent to the verified owner whenever the stored key changes.",
  },
});

function cleanText(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function oneLine(value) {
  return cleanText(value).replace(/\s+/g, " ");
}

/* The body is the one field that passes through untouched apart from line
 * endings. It is Markdown an agent wrote, and reflowing it is what destroys a
 * fenced block or a table. */
export function renderTldrAgentEmail(input = {}) {
  const {
    state,
    subject = null,
    body = null,
    replyInstruction = null,
    securityNotice = null,
    statePanel = [],
    agent = null,
    action = null,
    code = null,
  } = input;

  if (!VALID_STATES.has(state)) {
    throw new TypeError(`unknown tldr; email state: ${state}`);
  }
  const defaults = DEFAULTS[state];

  const rendered = render({
    subject: oneLine(subject || defaults.subject),
    body: cleanText(body) || defaults.body,
    system: SYSTEM_KIND[state] ?? null,
    reply: cleanText(replyInstruction) || defaults.reply,
    notice: cleanText(securityNotice) || defaults.notice,
    action: action || defaults.action || null,
    code: cleanText(code) || defaults.code || null,
    statePanel,
    agent,
  });

  return { ...rendered, template_version: TEMPLATE_VERSION };
}

const WELCOME_SCENARIOS = Object.freeze([
  "Email me a summary when you finish.",
  "Send me the decision and anything still blocked.",
  "Email me if you need input before continuing.",
  "Reply to this email with a follow-up for this Claude Code session.",
]);

export function renderTldrAgentWelcomeEmail({
  scenarios = WELCOME_SCENARIOS,
} = {}) {
  const body = `# tldr; is ready

Claude Code can email you from this Mac. When you reply, tldr; returns your
message to the Claude Code session that sent the email.

## A few things to try

${scenarios.map((scenario) => `- “${oneLine(scenario)}”`).join("\n")}

You can also ask Claude to “Check tldr;,” “Configure tldr;,” “Repair
tldr;,” or “Uninstall tldr;.”`;
  const subject = "Ready: tldr; is connected";
  const rendered = renderTldrAgentEmail({
    state: "conversation",
    subject,
    body,
    replyInstruction: "Reply to continue this Claude Code session.",
    securityNotice: "tldr; sent this message only to its confirmed owner.",
    statePanel: [["tldr;", "Ready"]],
    agent: AGENTS.claude,
  });
  return Object.freeze({
    subject,
    body,
    replyInstruction: "Reply to continue this Claude Code session.",
    securityNotice: "tldr; sent this message only to its confirmed owner.",
    ...rendered,
  });
}

export const _internals = {
  TEMPLATE_VERSION,
  VALID_STATES,
  DEFAULTS,
  SYSTEM_KIND,
  AGENTS,
  WELCOME_SCENARIOS,
};
