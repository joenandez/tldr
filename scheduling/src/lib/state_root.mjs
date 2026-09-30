// Phase E (item 19): every tldr; component keeps its state under one root,
// ~/.tldr-agents. Helm's default home is ~/.tldr-agents/helm; ~/.helm is the
// legacy home and stays a compatibility symlink to the new one until item 36.
// HELM_HOME still overrides the default (store.mjs helmHomeFor).

import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve, sep } from "node:path";

export const STATE_ROOT_MIGRATION_PENDING = "STATE_ROOT_MIGRATION_PENDING";
export const STATE_ROOT_TEST_ISOLATION = "STATE_ROOT_TEST_ISOLATION";

export function defaultHelmHome(home = homedir()) {
  return join(home, ".tldr-agents", "helm");
}

export function legacyHelmHome(home = homedir()) {
  return join(home, ".helm");
}

function canonicalPath(path) {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

// The production guards (canonical-checkout and dev-daemon refusal) match the
// new home and the legacy ~/.helm by realpath: before the migration the data
// lives at ~/.helm, after it ~/.helm is a symlink to the new home.
export function isProductionHelmHome(home) {
  const candidate = canonicalPath(home);
  return (
    candidate === canonicalPath(defaultHelmHome()) ||
    candidate === canonicalPath(legacyHelmHome())
  );
}

// Legacy guard. Creating the default home while ~/.helm is still a real
// directory would split Helm's state in two, so report that case. It applies
// only to the default home (an explicit HELM_HOME elsewhere is its own
// store), only while that home is missing, and never to a ~/.helm symlink,
// which is the post-migration compatibility shim.
export function pendingStateRootMigration(home) {
  if (resolve(home) !== resolve(defaultHelmHome())) return null;
  if (existsSync(home)) return null;
  const legacy = legacyHelmHome();
  let stat;
  try {
    stat = lstatSync(legacy);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
  return { helm_home: home, legacy_helm_home: legacy };
}

// Called by every path that would create the Helm home. Cheap when the home
// exists or is not the default (one resolve, at most one stat); logs and
// throws only on the refusal.
export function assertHelmHomeCreatable(home) {
  const pending = pendingStateRootMigration(home);
  if (!pending) return;
  process.stderr.write(
    `${JSON.stringify({
      event: "helm.state_root.create_refused",
      status: "refused",
      params: pending,
      result: { code: STATE_ROOT_MIGRATION_PENDING },
    })}\n`,
  );
  const err = new Error(
    `refusing to create Helm home ${pending.helm_home} while the legacy home ${pending.legacy_helm_home} is still a real directory; run the state-root migration first`,
  );
  err.code = STATE_ROOT_MIGRATION_PENDING;
  err.details = pending;
  throw err;
}

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

// Under `node --test` (NODE_TEST_CONTEXT), a Helm home inside the account's
// real ~/.tldr-agents or ~/.helm is live state, whatever HOME says: the
// account's home comes from the password database, not the environment. The
// same rule as Tightbeam's state_root_location.mjs. Returns the facts or null.
export function testIsolationBreach(home, { env = process.env } = {}) {
  if (!env.NODE_TEST_CONTEXT) return null;
  const realHome = realAccountHome();
  if (!realHome) return null;
  const candidate = resolve(home);
  const live = [join(realHome, ".tldr-agents"), legacyHelmHome(realHome)].find(
    (dir) => isWithin(candidate, dir),
  );
  return live ? { helm_home: candidate, live } : null;
}

// Homes already seen to exist: the migration guard can no longer fire for
// them, so the resolvers skip its stat on later calls.
const existingHomes = new Set();

// The resolvers' guard (store.mjs helmHome() and identity.mjs getHelmHome()).
// Every Helm path, read or written, derives from one of them, so no writer
// (events, read, perf, sessions, sentinel, service, workspaces, ...) can
// create the default home beside a real legacy ~/.helm, and no test can
// reach the operator's live home. Silent on success: helmHome() is called
// often.
export function assertHelmHomeUsable(home) {
  const breach = testIsolationBreach(home);
  if (breach) {
    process.stderr.write(
      `${JSON.stringify({
        event: "helm.state_root.test_isolation_refused",
        status: "refused",
        params: breach,
        result: { code: STATE_ROOT_TEST_ISOLATION },
      })}\n`,
    );
    const err = new Error(
      `refusing Helm home ${breach.helm_home} under node --test: it is inside the live ${breach.live}. Import tests/isolated_process_home.mjs or set HELM_HOME (or HOME) to a temporary directory in this test`,
    );
    err.code = STATE_ROOT_TEST_ISOLATION;
    err.details = breach;
    throw err;
  }
  if (existingHomes.has(home)) return home;
  assertHelmHomeCreatable(home);
  if (existsSync(home)) existingHomes.add(home);
  return home;
}
