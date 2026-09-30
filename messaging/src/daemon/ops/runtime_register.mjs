// runtime.register — admin-only (docs/security-model.md "Administrative
// operations"; plan standalone-agent-messaging W1 «Registration lifecycle»).
// The caller sends the PARSED manifest object, never a path: the CLI parses
// client-side to fail fast, and the daemon revalidates with the same strict
// parser before anything is persisted or activated. Persistence follows
// persist-then-activate (src/daemon/runtime_store.mjs): the manifest file
// lands atomically under <state-root>/runtimes/ first; only then is a new
// frozen registry snapshot swapped onto context.runtimeRegistry, so the
// merged registry gains the runtime without any restart.

import { registerRuntimeManifest } from '../runtime_store.mjs';

export const runtimeRegisterOp = {
  name: 'runtime.register',
  allowedScopes: ['admin'],
  permission: null,
  handler(context, payload) {
    const outcome = registerRuntimeManifest({ context, manifestObject: payload && payload.manifest });
    return outcome.replayed
      ? { result: { id: outcome.id, hash: outcome.hash, replayed: true } }
      : { result: { id: outcome.id, hash: outcome.hash, replayed: false, file: outcome.file } };
  },
};
