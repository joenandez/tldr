// Single source of the Slack setup steps. The local page shows one step per
// view; the CLI and the setup skill only send the link and SLACK_SETUP_LINK_LINE.
export const SLACK_SETUP_STEPS = Object.freeze([
  "Get a configuration token",
  "Install the app",
  "Done",
]);

export const SLACK_SETUP_LINK_LINE = `Open this link and follow the ${SLACK_SETUP_STEPS.length} steps on the page.`;

// HTML for the local setup page; every dynamic value goes through esc().
const esc = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

const heading = (n) =>
  `<h2>Step ${n} of ${SLACK_SETUP_STEPS.length}: ${SLACK_SETUP_STEPS[n - 1]}</h2>`;
const list = (items) =>
  `<ol>${items.map((i) => `<li>${i}</li>`).join("")}</ol>`;
const newTab = (href, label) =>
  `<a href="${esc(href)}" target="_blank" rel="noreferrer">${esc(label)}</a>`;

function form({ path, key, label, name }) {
  const field = name
    ? `<label>${esc(label)} <input type="password" name="${name}" autocomplete="off" required></label> `
    : "";
  return `<form method="post" action="${path}?key=${esc(key)}">${field}<button type="submit">${name ? "Continue" : esc(label)}</button></form>`;
}

const refreshTag = (key) =>
  `<meta http-equiv="refresh" content="3;url=/?key=${esc(key)}">`;

const configTokenView = (key) =>
  `${heading(1)}${list([
    `Open ${newTab("https://api.slack.com/apps", "api.slack.com/apps")} in a new tab.`,
    'Under "Your App Configuration Tokens", press "Generate Token".',
    'Pick your workspace and press "Generate".',
    'Press "Copy" next to the access token.',
    'Paste it below and press "Continue".',
  ])}${form({ path: "/config-token", key, label: "Access token", name: "configToken" })}`;

const installView = (authorizeUrl) =>
  `${heading(2)}${list([
    'Press "Install to Slack" below. Slack opens in a new tab.',
    'On Slack\'s screen, press "Allow".',
    "Then come back to this tab. It updates by itself.",
  ])}<p>${newTab(authorizeUrl, "Install to Slack")}</p>`;

const appTokenView = ({ key, appSettingsUrl }) =>
  `<h2>One more token</h2><p>Slack did not give you an app-level token. Make one now.</p>${list(
    [
      `Open ${newTab(appSettingsUrl, "your app's Basic Information page")} in a new tab.`,
      'Under "App-Level Tokens", press "Generate Token and Scopes".',
      'Add the scope connections:write and press "Generate".',
      'Copy the xapp- token, paste it below and press "Continue".',
    ],
  )}${form({ path: "/app-token", key, label: "App-level token (xapp-)", name: "appToken" })}`;

function doneView({ notice, channels }) {
  const made = channels?.length
    ? `<p>Channels made: ${esc(channels.map((c) => `#${c}`).join(", "))}.</p>`
    : "";
  const alert = notice
    ? `<p role="alert"><strong>${esc(notice)}</strong></p>`
    : "";
  return `${heading(3)}<p>Slack is connected.</p>${alert}${made}<p>You can close this tab.</p>`;
}

// While the post-install checks run the tab keeps refreshing (no "Try again"),
// so it flips to the done view by itself.
function tokenView({ key, session, error }) {
  if (session.appToken && session.checking && !error) {
    return {
      refresh: refreshTag(key),
      body: "<h2>Connecting…</h2><p>Slack is finishing the install. This tab updates by itself.</p>",
    };
  }
  const body = session.appToken
    ? `<h2>Install not finished</h2><p>Press "Try again" to check the install again.</p>${form({ path: "/app-token", key, label: "Try again" })}`
    : appTokenView({ key, appSettingsUrl: session.appSettingsUrl });
  return { refresh: "", body };
}

export function renderSlackSetupPage({ key, session, error }) {
  let refresh = "";
  let body;
  if (session.connected) {
    body = doneView(session);
  } else if (session.botToken) {
    ({ body, refresh } = tokenView({ key, session, error }));
  } else if (session.authorizeUrl) {
    // reload to "/" so the original tab shows the done view after Allow
    if (!error) refresh = refreshTag(key);
    body = installView(session.authorizeUrl);
  } else {
    body = configTokenView(key);
  }
  const problem = error
    ? `<p role="alert"><strong>${esc(error)}</strong></p>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>tldr Slack setup</title>${refresh}</head><body><h1>Connect Slack</h1>${problem}${body}</body></html>`;
}
