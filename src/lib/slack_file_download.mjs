import { chmod, open, rename, rm } from "node:fs/promises";

import { SlackApiError, abortError, untilAborted } from "./slack_api.mjs";
import { readSlackCredentials } from "./slack_credentials.mjs";

// Downloads one Slack file with the bot token, streaming it to disk. Without
// the files:read scope Slack sends the browser to a sign-in page instead of the
// file. Errors never carry the token.
export const FILE_MAX_BYTES = 25 * 1024 * 1024;
export const FILE_TIMEOUT_MS = 20_000;
const METHOD = "files.download";
const FILE_HOST = "files.slack.com";
const fail = (slackError, retryable = false) =>
  new SlackApiError({ method: METHOD, slackError, retryable });

// The bearer token must only go to Slack.
function isSlackUrl(value) {
  try {
    const { protocol, hostname } = new URL(value);
    return (
      protocol === "https:" &&
      (hostname === "slack.com" || hostname.endsWith(".slack.com"))
    );
  } catch {
    return false;
  }
}

// Without files:read, Slack redirects to the workspace sign-in page: an HTML
// answer that ended on a host other than the file host. Judged by host only, so
// a file named login-flow.png on the file host is never taken for it.
function endedOnSignIn(response) {
  if (!response.redirected) return false;
  try {
    return new URL(response.url).hostname !== FILE_HOST;
  } catch {
    return true;
  }
}

function botToken({ home, credentials }) {
  const creds =
    credentials !== undefined ? credentials : readSlackCredentials({ home });
  if (!creds?.botToken) throw fail("not_connected");
  return creds.botToken;
}

// Stops the body from downloading, then refuses.
function refuse(response, code) {
  response.body?.cancel().catch(() => {});
  throw fail(code);
}

// The bytes go to <dest>.part and move to dest only when complete.
async function streamToFile(response, dest, { maxBytes, bounded }) {
  const reader = response.body?.getReader();
  const part = `${dest}.part`;
  let out;
  let total = 0;
  try {
    out = await open(part, "w", 0o600);
    while (reader) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await untilAborted(reader.read(), bounded);
      if (done) break;
      total += value.length;
      if (total > maxBytes) throw fail("too_large");
      // eslint-disable-next-line no-await-in-loop
      await out.write(value);
    }
    await out.close();
    await chmod(part, 0o600);
    await rename(part, dest);
    return total;
  } catch (error) {
    reader?.cancel().catch(() => {});
    await out?.close().catch(() => {});
    await rm(part, { force: true });
    throw error;
  }
}

// A timeout or a caller abort may have lost a good answer: retryable.
async function guarded(work, { bounded, signal }) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SlackApiError) throw error;
    if (bounded.aborted) throw abortError(METHOD, signal);
    // a disk error has a code like ENOSPC; a network error is only a class
    if (/^E[A-Z]+$/.test(error?.code ?? ""))
      throw fail(`save_failed_${error.code}`);
    throw fail("network_error", true);
  }
}

// Returns the number of bytes saved to dest.
export async function downloadFile(url, dest, opts = {}) {
  const {
    fetchImpl = globalThis.fetch,
    signal,
    timeoutMs = FILE_TIMEOUT_MS,
    maxBytes = FILE_MAX_BYTES,
    allowHtml = false,
  } = opts;
  const token = botToken(opts);
  if (!isSlackUrl(url)) throw fail("untrusted_file_url");
  const bounded = AbortSignal.any(
    [AbortSignal.timeout(timeoutMs), signal].filter(Boolean),
  );
  const ctl = { bounded, signal };
  const response = await guarded(
    () =>
      untilAborted(
        fetchImpl(url, {
          headers: { Authorization: `Bearer ${token}` },
          signal: bounded,
        }),
        bounded,
      ),
    ctl,
  );
  const html = /text\/html/i.test(response.headers.get("content-type") ?? "");
  // First: the sign-in page arrives as a 403 after the redirect.
  if (html && endedOnSignIn(response))
    refuse(response, "missing_files_read_scope");
  if (!response.ok) refuse(response, `http_${response.status}`);
  if (html && !allowHtml) refuse(response, "html_page");
  if (Number(response.headers.get("content-length")) > maxBytes)
    refuse(response, "too_large");
  return guarded(
    () => streamToFile(response, dest, { maxBytes, bounded }),
    ctl,
  );
}
