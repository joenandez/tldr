import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve, sep } from "node:path";
import { writeJsonAtomic, appendJsonLine } from "./durable_file_io.mjs";
import {
  STATE_ROOT_MIGRATION_PENDING,
  STATE_ROOT_PARENT,
  STATE_ROOT_TEST_ISOLATION,
  defaultStateRoot,
  inspectStateRoot,
  legacyStateRoot,
  logStateRootEvent,
} from "./state_root_layout.mjs";

// The layout (STATE_ROOT_COMPONENTS and the default and legacy paths), the
// read-only inspection of one root, and the one-root creation guard live in
// state_root_layout.mjs. This module keeps the resolvers, the test-isolation
// guard, the whole-product guard and report, and scopes.
export {
  STATE_ROOT_COMPONENTS,
  STATE_ROOT_MIGRATION_PENDING,
  STATE_ROOT_PARENT,
  STATE_ROOT_TEST_ISOLATION,
  assertStateRootCreatable,
  canonicalStateRoot,
  defaultStateRoot,
  inspectStateRoot,
  legacyStateRoot,
  logStateRootEvent,
} from "./state_root_layout.mjs";

let accountHome;
function realAccountHome() {
  if (accountHome === undefined) {
    try {
      accountHome = userInfo().homedir || null;
    } catch {
      accountHome = null;
    }
  }
  return accountHome;
}

function isWithin(candidate, dir) {
  return candidate === dir || candidate.startsWith(`${dir}${sep}`);
}

// Under `node --test` (NODE_TEST_CONTEXT), an agent root inside the account's
// real ~/.tldr-agents or legacy ~/.tldr-agent is live state, whatever HOME
// says: the account's home comes from the password database, not the
// environment. The same rule as Helm's scheduling/src/lib/state_root.mjs and
// Tightbeam's messaging/src/protocol/state_root_location.mjs. Returns the
// facts or null.
export function agentRootTestIsolationBreach(root, { env = process.env } = {}) {
  if (!env.NODE_TEST_CONTEXT) return null;
  const realHome = realAccountHome();
  if (!realHome) return null;
  const candidate = resolve(root);
  const live = [
    join(realHome, STATE_ROOT_PARENT),
    legacyStateRoot("agent", realHome),
  ].find((dir) => isWithin(candidate, dir));
  return live ? { agent_root: candidate, live } : null;
}

// The resolver's guard. Every tldr agent-root path, read or written, derives
// from helmHomeFor (helmHome(), tldrAgentHomeFor(), resolveStateRoots()), so
// no test can reach the operator's live agent root. Silent on success: the
// resolver is called often, and outside `node --test` this is one env lookup.
export function assertAgentRootUsable(root) {
  const breach = agentRootTestIsolationBreach(root);
  if (!breach) return root;
  logStateRootEvent("error", "tldr.state_root.test_isolation_refused", {
    status: "refused",
    params: breach,
    result: { code: STATE_ROOT_TEST_ISOLATION },
  });
  const error = new Error(
    `refusing tldr agent root ${breach.agent_root} under node --test: it is inside the live ${breach.live}. ` +
      "Set TLDR_AGENT_HOME (or HOME) to a temporary directory in this test",
  );
  error.code = STATE_ROOT_TEST_ISOLATION;
  error.details = breach;
  throw error;
}

// tldr; never resolves state through ambient Helm configuration.
export function helmHomeFor({ tldrAgentHome, userHome = homedir() } = {}) {
  return assertAgentRootUsable(
    tldrAgentHome || defaultStateRoot("agent", userHome),
  );
}

// The tldr agent root (TLDR_AGENT_HOME). The name is historical: tldr's store
// began as a Helm store, and HELM_HOME in tldr processes still means this root.
export function helmHome() {
  return helmHomeFor({ tldrAgentHome: process.env.TLDR_AGENT_HOME });
}

export function tldrAgentHomeFor({
  env = process.env,
  userHome = homedir(),
} = {}) {
  return helmHomeFor({ tldrAgentHome: env.TLDR_AGENT_HOME, userHome });
}

// Helm's state root as tldr sees it (see STATE_ROOT_COMPONENTS.helm).
export function helmStateRootFor({ userHome = homedir() } = {}) {
  return defaultStateRoot("helm", userHome);
}

export function tightbeamStateRootFor({
  env = process.env,
  userHome = homedir(),
} = {}) {
  return env.TIGHTBEAM_STATE_ROOT || defaultStateRoot("tightbeam", userHome);
}

// The three roots this process resolves, with where each value came from.
export function resolveStateRoots({
  env = process.env,
  userHome = homedir(),
} = {}) {
  return Object.freeze({
    agent: Object.freeze({
      path: resolve(tldrAgentHomeFor({ env, userHome })),
      source: env.TLDR_AGENT_HOME ? "TLDR_AGENT_HOME" : "default",
    }),
    helm: Object.freeze({
      path: resolve(helmStateRootFor({ userHome })),
      source: "default",
    }),
    tightbeam: Object.freeze({
      path: resolve(tightbeamStateRootFor({ env, userHome })),
      source: env.TIGHTBEAM_STATE_ROOT ? "TIGHTBEAM_STATE_ROOT" : "default",
    }),
  });
}

// Checks every root at once so a refusal names all of the pending ones.
export function assertStateRootsCreatable({
  env = process.env,
  userHome = homedir(),
  roots = resolveStateRoots({ env, userHome }),
  // Components this caller creates itself; the others are only logged.
  guarded = Object.keys(roots),
  operation = "unspecified",
} = {}) {
  const pending = [];
  for (const [component, entry] of Object.entries(roots)) {
    if (!guarded.includes(component)) continue;
    if (!entry?.path || existsSync(entry.path)) continue;
    const inspected = inspectStateRoot({
      component,
      root: entry.path,
      userHome,
    });
    if (inspected.migration_pending) pending.push(inspected);
  }
  logStateRootEvent(
    pending.length ? "warn" : "info",
    pending.length ? "state_root_migration_pending" : "state_root_resolved",
    {
      status: pending.length ? "refused" : "ok",
      params: {
        operation,
        roots: Object.fromEntries(
          Object.entries(roots).map(([component, entry]) => [
            component,
            { path: entry?.path ?? null, source: entry?.source ?? null },
          ]),
        ),
        ...(pending.length
          ? { pending: pending.map((entry) => entry.component) }
          : {}),
      },
    },
  );
  if (!pending.length) return roots;
  const error = new Error(
    `tldr; state is still at ${pending
      .map((entry) => entry.legacy_path)
      .join(", ")}; refusing to create ${pending
      .map((entry) => entry.path)
      .join(", ")} before the state root migration`,
  );
  error.code = STATE_ROOT_MIGRATION_PENDING;
  error.details = Object.freeze({ operation, pending: Object.freeze(pending) });
  throw error;
}

// Status report: the resolved roots, and every legacy root still a real
// directory (the migration has not run, or something recreated it).
export function stateRootsReport({
  env = process.env,
  userHome = homedir(),
} = {}) {
  const roots = resolveStateRoots({ env, userHome });
  const entries = Object.fromEntries(
    Object.entries(roots).map(([component, entry]) => {
      const inspected = inspectStateRoot({
        component,
        root: entry.path,
        userHome,
      });
      return [
        component,
        Object.freeze({
          path: inspected.path,
          source: entry.source,
          exists: inspected.exists,
          legacy_path: inspected.legacy_path,
          legacy_kind: inspected.legacy_kind,
          legacy_real_directory: inspected.legacy_real_directory,
          migration_pending: inspected.migration_pending,
        }),
      ];
    }),
  );
  return Object.freeze({
    state_roots: Object.freeze(entries),
    legacy_state_roots: Object.freeze(
      Object.values(entries)
        .filter((entry) => entry.legacy_real_directory)
        .map((entry) => entry.legacy_path),
    ),
  });
}

export function resolveScope({ cwd = process.cwd() }) {
  if (typeof cwd !== "string") {
    throw new TypeError(
      `resolveScope: cwd must be a string, received ${typeof cwd} (${cwd}). Did you pass --cwd without a value?`,
    );
  }
  const projectRoot = canonicalizeCwd(cwd);
  const base = { cwd: projectRoot, scope_id: projectRoot };
  return {
    ...base,
    storage_root: scopeRuntimeRoot(base),
    legacy_storage_root: join(projectRoot, ".helm"),
  };
}

export const TLDR_AGENT_SCOPE_ID = "tldr-agent";

export function resolveTldrAgentScope({
  cwd = process.cwd(),
  tldrAgentHome = helmHome(),
} = {}) {
  if (typeof cwd !== "string") {
    throw new TypeError(
      `resolveTldrAgentScope: cwd must be a string, received ${typeof cwd}`,
    );
  }
  const root = resolve(tldrAgentHome);
  return {
    cwd: canonicalizeCwd(cwd),
    scope_id: TLDR_AGENT_SCOPE_ID,
    storage_root: root,
    legacy_storage_root: join(root, "legacy"),
  };
}

function canonicalizeCwd(cwd) {
  const resolved = resolve(cwd);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function scopeHash(scopeOrId) {
  const id = typeof scopeOrId === "string" ? scopeOrId : scopeOrId.scope_id;
  return createHash("sha1").update(String(id)).digest("hex");
}

export function scopeRuntimeRoot(scope) {
  return join(helmHome(), "workspaces", scopeHash(scope));
}

export function readJsonIfExists(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export { writeJsonAtomic, appendJsonLine };
