import { helmHome } from "../store.mjs";
import { runtimeStorePath } from "../runtime_store.mjs";
import { withRuntimeStoreTransactionRetry } from "../runtime_store_retry.mjs";

function defaultStoreArgs(opts) {
  const home = opts?.home ?? helmHome();
  return { home, path: opts?.path ?? runtimeStorePath(home) };
}

function mutateThread(scope, threadId, opts, stage, mutate) {
  const result = withRuntimeStoreTransactionRetry(
    defaultStoreArgs(opts),
    { context: { stage } },
    (db) => {
      const row = db
        .prepare(
          "SELECT payload FROM canonical_threads WHERE scope_id=? AND thread_id=?",
        )
        .get(scope.scope_id, threadId);
      if (!row) return { ok: false, reason: "thread_missing" };
      const prior = JSON.parse(row.payload);
      const decision = mutate(prior);
      if (!decision.ok || !decision.next) return decision;
      const next = decision.next;
      db.prepare(
        `UPDATE canonical_threads
           SET payload=?, owner_session_id=?, external_thread_id=?, updated_at=?
         WHERE scope_id=? AND thread_id=?`,
      ).run(
        JSON.stringify(next),
        next.owner_session_id ?? null,
        next.external_thread_id ?? null,
        new Date().toISOString(),
        scope.scope_id,
        threadId,
      );
      return { ...decision, thread: next };
    },
  );
  return result.ok ? result.value : { ok: false, reason: "store_busy" };
}

function claim(scope, threadId, sessionId, opts) {
  return mutateThread(scope, threadId, opts, "claimThreadIdentity", (prior) => {
    const owner = prior.owner_session_id || null;
    const pending = prior.pending_owner_session_id || null;
    if (owner && owner !== sessionId) {
      return { ok: false, reason: "thread_not_owned_by_session", owner };
    }
    if (pending && pending !== sessionId) {
      return { ok: false, reason: "thread_owner_claimed", owner: pending };
    }
    if (owner || pending === sessionId) return { ok: true, thread: prior };
    return {
      ok: true,
      next: {
        ...prior,
        pending_owner_session_id: sessionId,
        pending_owner_claimed_at: new Date().toISOString(),
      },
    };
  });
}

function activate(scope, threadId, sessionId, externalThreadId, opts) {
  return mutateThread(
    scope,
    threadId,
    opts,
    "activateThreadIdentity",
    (prior) => {
      const owner = prior.owner_session_id || null;
      const pending = prior.pending_owner_session_id || null;
      if (
        (owner && owner !== sessionId) ||
        (pending && pending !== sessionId)
      ) {
        return {
          ok: false,
          reason: "thread_not_owned_by_session",
          owner: owner || pending,
        };
      }
      if (
        prior.external_thread_id &&
        prior.external_thread_id !== externalThreadId
      ) {
        return {
          ok: false,
          reason: "external_thread_mismatch",
          external_thread_id: prior.external_thread_id,
        };
      }
      return {
        ok: true,
        next: {
          ...prior,
          owner_session_id: owner || sessionId,
          external_thread_id: prior.external_thread_id || externalThreadId,
          pending_owner_session_id: null,
          owner_session_established_at:
            prior.owner_session_established_at || new Date().toISOString(),
        },
      };
    },
  );
}

function release(scope, threadId, sessionId, opts) {
  return mutateThread(
    scope,
    threadId,
    opts,
    "releaseThreadIdentityClaim",
    (prior) => {
      if (
        prior.owner_session_id ||
        prior.pending_owner_session_id !== sessionId
      ) {
        return { ok: true, thread: prior };
      }
      return {
        ok: true,
        next: {
          ...prior,
          pending_owner_session_id: null,
          pending_owner_claimed_at: null,
        },
      };
    },
  );
}

export function createThreadIdentityOperations({ storeOpts } = {}) {
  return {
    claimThreadIdentity(scope, threadId, sessionId) {
      return claim(scope, threadId, sessionId, storeOpts?.(scope));
    },
    activateThreadIdentity(scope, threadId, sessionId, externalThreadId) {
      return activate(
        scope,
        threadId,
        sessionId,
        externalThreadId,
        storeOpts?.(scope),
      );
    },
    releaseThreadIdentityClaim(scope, threadId, sessionId) {
      return release(scope, threadId, sessionId, storeOpts?.(scope));
    },
  };
}
