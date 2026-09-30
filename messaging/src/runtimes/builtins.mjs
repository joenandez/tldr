// The immutable builtin runtime data. Seeded verbatim from
// src/daemon/runtime_table.mjs (whose entries are copied verbatim from
// Helm at revision 3545a719) plus the identity, hook-install, and
// capability evidence those modules carry hardcoded today:
//
//   templates        <- runtime_table.mjs resumeArgs/spawnArgs, with the
//                       substituted slot made a whole-element literal
//                       ({sessionId}/{prompt}) instead of a function
//   identity         <- src/cli/hook_identity.mjs SESSION_ENV_CHAIN (:20)
//                       and the resolveRuntime sniffer (:195-205), split
//                       per runtime in resolve order
//   hooksInstall     <- src/cli/hooks_install.mjs settingsPathFor (:86-90)
//
// Plan W1 «Layering (structural)»: this file is data only and imports
// nothing from any other source layer. A runtime absent from this data is
// not an error: its resume requests stay `pending` for an external
// `resume.claim` (docs/protocol.md «Resume requests»).
//
// resume_session.mjs:196-198 records the `--resume` (claude) versus
// `exec resume` (codex) inversion as a prior Helm regression — the two
// runtimes put the same idea in different argument positions, so the
// vectors are copied rather than derived. Never abbreviate them.

export const BUILTIN_RUNTIMES = Object.freeze({
  'claude-code': Object.freeze({
    id: 'claude-code',
    contractVersion: '1.0',
    // Loader-known metadata: set here, never serialized onto the wire or
    // into state, and never adapter-authored (a manifest declaring it is
    // rejected at parse time).
    origin: 'builtin',
    resumeStrategy: 'daemon',
    command: 'claude',
    // The resume vector ends without a positional prompt, so `-p` reads
    // the brief from stdin; the spawn vector carries it as the last
    // argument. Both are the source's shape, not a choice made here.
    resumeArgsTemplate: Object.freeze(['--resume', '{sessionId}', '--dangerously-skip-permissions', '-p', '--verbose', '--output-format', 'stream-json']),
    spawnArgsTemplate: Object.freeze(['-p', '--verbose', '--output-format', 'stream-json', '--dangerously-skip-permissions', '{prompt}']),
    identity: Object.freeze({
      sessionEnvVars: Object.freeze(['CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID']),
      envMarkers: Object.freeze(['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID']),
      transcriptHints: Object.freeze(['/.claude/', '/claude/projects/']),
    }),
    hooksInstall: Object.freeze({ settingsPath: '.claude/settings.json', format: 'claude-json' }),
    capabilities: Object.freeze({ stdoutInjection: true, blockExitCodes: Object.freeze([2]) }),
  }),
  codex: Object.freeze({
    id: 'codex',
    contractVersion: '1.0',
    origin: 'builtin',
    resumeStrategy: 'daemon',
    command: 'codex',
    // The resume vector's trailing `-` is codex's "read the prompt from
    // stdin"; the spawn vector carries it as the last argument.
    resumeArgsTemplate: Object.freeze(['exec', '--json', 'resume', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '{sessionId}', '-']),
    spawnArgsTemplate: Object.freeze(['--ask-for-approval', 'never', 'exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '{prompt}']),
    identity: Object.freeze({
      sessionEnvVars: Object.freeze(['CODEX_THREAD_ID']),
      envMarkers: Object.freeze(['CODEX_THREAD_ID']),
      transcriptHints: Object.freeze(['/.codex/', '/codex/sessions/']),
    }),
    hooksInstall: Object.freeze({ settingsPath: '.codex/hooks.json', format: 'claude-json' }),
    capabilities: Object.freeze({ stdoutInjection: true, blockExitCodes: Object.freeze([2]) }),
  }),
});

/** Every canonical id, in table order. */
export const CANONICAL_RUNTIME_IDS = Object.freeze(Object.keys(BUILTIN_RUNTIMES));

/**
 * Legacy stored ids that must compare equal to a canonical id. Rows
 * persisted under these spellings are never rewritten; new rows store the
 * canonical id (plan W1 «Canonical ids and legacy equivalence»). codex has
 * no legacy alias.
 */
export const LEGACY_RUNTIME_ALIASES = Object.freeze({
  claude: 'claude-code',
});
