// assignment_flags — the per-verb flag allowlist behind strict flag parsing.
//
// parseArgs accepts any --flag, so a typo such as `--skil` used to be dropped
// silently and the command ran without it. Each list holds exactly the flags
// that verb reads. They were checked against every known caller (Subspace's
// Helm module, Academy's capability probe, the tldr docs) so strict mode does
// not break a working caller on upgrade.

const GLOBAL_FLAGS = ["pretty", "help", "json"];

// Flags that never take a value; see parseArgs.
export const BOOLEAN_FLAGS = [
  ...GLOBAL_FLAGS,
  "activate",
  "enable",
  "disable",
  "all-scopes",
  "with-terminal-runs",
  "partial",
  "include-tasks",
  "no-network-check",
];

const SCHEDULE_FLAGS = [
  "in",
  "at",
  "once-at",
  "cron",
  "every",
  "timezone",
  "end-at",
  "jitter-sec",
  "missed-run-policy",
  "misfire-grace-sec",
  "max-catchup-runs",
  "max-catchup-cost",
  "estimated-catchup-cost",
  "overlap-policy",
  "no-network-check",
  "network-host",
];

const WRITE_FLAGS = [
  "cwd",
  "name",
  "description",
  "completion-delivery",
  "skill",
  "provider",
  "academy-agent",
  "academy-runtime",
  "model",
  "reasoning-effort",
  "permission-mode",
  ...SCHEDULE_FLAGS,
];

const VERB_FLAGS = {
  create: [...WRITE_FLAGS, "activate"],
  update: [...WRITE_FLAGS, "enable", "disable", "skill-path"],
  list: [
    "cwd",
    "status",
    "all-scopes",
    "with-terminal-runs",
    "partial",
    "include-tasks",
  ],
  show: ["cwd", "include-tasks"],
  runs: ["cwd", "include-tasks", "all-scopes", "partial"],
  path: ["cwd"],
  skill: ["cwd"],
  completion: ["cwd"],
  archive: ["cwd"],
  unarchive: ["cwd"],
  run: ["cwd"],
  logs: ["cwd"],
  retarget: ["cwd", "to-cwd"],
  "runtime-options": [],
  "session-origin": ["session"],
};

const HINTS = {
  schedule:
    "--schedule is not a valid flag; use: --in <dur>, --at <iso>, --cron '<expr>', or --every <dur>",
};

// Returns the first flag the verb does not read, as a fail() payload, or null.
// An unknown verb returns null so the caller reports unknown_command instead.
export function unknownFlagError(verb, flags) {
  const verbFlags = VERB_FLAGS[verb];
  if (!verbFlags) return null;
  const allowed = [...verbFlags, ...GLOBAL_FLAGS].sort();
  const flag = Object.keys(flags)
    .sort()
    .find((key) => !allowed.includes(key));
  if (flag === undefined) return null;
  return {
    message:
      HINTS[flag] ||
      `--${flag} is not a valid flag for ${verb}; accepted: ${allowed.map((f) => `--${f}`).join(" ")}`,
    details: { flag: `--${flag}`, allowed: allowed.map((f) => `--${f}`) },
  };
}
