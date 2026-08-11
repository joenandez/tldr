/* tldr; — the footer's context line, derived from a canonical row.
 *
 * Where it ran, who ran it, which session a reply lands in. Every value comes
 * off the row rather than out of the message, so the panel is the one part of
 * the email the agent could not have written.
 *
 * Order is the renderer's job (CONTEXT_ORDER in email.mjs). This only decides
 * which values exist and how each one reads.
 */

import { homedir as osHomedir } from "node:os";

import { AGENTS } from "./email.mjs";

/* Real ids are UUIDs. The owner reads this to tell one thread from another and
 * never types it, so it is shown at the length that distinguishes them. */
const SESSION_DISPLAY_LENGTH = 8;

/* `~/dev/orbit` is a place the owner recognises; an absolute home path is a
 * string they have to parse. Match only on a path boundary so a neighboring
 * account is never treated as the owner's home by a shared character prefix. */
function abbreviateHome(cwd, home) {
  if (!home || !cwd.startsWith(home)) return cwd;
  const rest = cwd.slice(home.length);
  if (rest === "") return "~";
  return rest.startsWith("/") ? `~${rest}` : cwd;
}

/* An adapter id we do not have a label for is left off entirely. A footer that
 * invents a name for the thing that wrote the message is worse than one that
 * stays quiet about it. */
const agentFor = (runtime) =>
  Object.values(AGENTS).find((entry) => entry.adapter === runtime) ?? null;

export function statePanelForRow(row, { homedir = osHomedir } = {}) {
  const metadata = row?.metadata ?? {};

  const statePanel = [];
  if (metadata.originator_cwd) {
    statePanel.push([
      "DIRECTORY",
      abbreviateHome(String(metadata.originator_cwd), homedir()),
    ]);
  }
  if (metadata.originator_session_id) {
    statePanel.push([
      "SESSION",
      String(metadata.originator_session_id).slice(0, SESSION_DISPLAY_LENGTH),
    ]);
  }

  return { statePanel, agent: agentFor(metadata.originator_runtime) };
}
