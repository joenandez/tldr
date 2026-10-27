// runtime.register — admin-only (docs/security-model.md "Administrative
// operations"; plan standalone-agent-messaging W1 «Registration lifecycle»).
// The caller sends the PARSED manifest object, never a path: the CLI parses
// client-side to fail fast, and the daemon revalidates with the same strict
// parser before anything is persisted or activated. Persistence follows
// persist-then-activate (src/daemon/runtime_store.mjs): the manifest file
// lands atomically under <state-root>/runtimes/ first; only then is a new
// frozen registry snapshot swapped onto context.runtimeRegistry, so the
// merged registry gains the runtime without any restart.
//
// `replace_stale: true` is tldr setup's request to replace its own stale
// `copilot` record after the package path moved (npm-publishable-install
// A2). The daemon, not the caller, decides whether the record is tldr's own.

import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { copilotPluginHooks } from '../../cli/copilot_hooks_install.mjs';
import { isCopilotPluginHooksPath, tldrCopilotRuntimeManifest } from '../../runtimes/copilot_contract.mjs';
import { canonicalManifestJson, registerRuntimeManifest } from '../runtime_store.mjs';

const TLDR_PACKAGE_NAME = '@joenandez/tldr';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function realpathOrNull(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}

const isTldrCopilotManifest = (manifest) =>
  canonicalManifestJson(manifest) === canonicalManifestJson(tldrCopilotRuntimeManifest(manifest.hooksInstall?.settingsPath));

// <root>/.copilot-plugin/hooks/hooks.json where <root>/package.json names tldr.
// The path shape alone is not enough: any package can ship that layout.
const inTldrPackage = (settingsPath) =>
  isCopilotPluginHooksPath(settingsPath) &&
  readJson(path.join(path.dirname(path.dirname(path.dirname(settingsPath))), 'package.json'))?.name === TLDR_PACKAGE_NAME;

// A deleted package root (an old nvm Node, a pruned plugin cache) leaves no
// package.json to check; a plugin hooks path that no longer exists is stale.
const isTldrOrGone = (settingsPath) =>
  inTldrPackage(settingsPath) || (isCopilotPluginHooksPath(settingsPath) && !fs.existsSync(settingsPath));

// The new path must be the realpath of a tldr package hooks file holding
// exactly the source-owned plugin hooks (what `hooks install --dry-run` verifies).
const isOwnCopilotHooksFile = (file) =>
  inTldrPackage(file) && realpathOrNull(file) === file && isDeepStrictEqual(readJson(file), copilotPluginHooks('copilot'));

/**
 * True only for tldr's own stale `copilot` record: both documents are tldr's
 * known Copilot manifest (which pins id "copilot"), the old path is inside a
 * tldr package root or no longer exists, and the new path is this package's
 * own hooks file.
 */
export function isOwnStaleCopilotRecord(existing, manifest) {
  if (!isTldrCopilotManifest(existing.manifest) || !isTldrCopilotManifest(manifest)) return false;
  return isTldrOrGone(existing.manifest.hooksInstall.settingsPath) && isOwnCopilotHooksFile(manifest.hooksInstall.settingsPath);
}

export const runtimeRegisterOp = {
  name: 'runtime.register',
  allowedScopes: ['admin'],
  permission: null,
  handler(context, payload) {
    const replaceStale =
      payload?.replace_stale === true
        ? (existing, manifest) => {
            const approved = isOwnStaleCopilotRecord(existing, manifest);
            context.logger?.info?.({ event: 'runtime_register_replace_checked', params: { runtime_id: existing.id }, result: { approved } });
            return approved;
          }
        : null;
    const outcome = registerRuntimeManifest({ context, manifestObject: payload && payload.manifest, replaceStale });
    return outcome.replayed
      ? { result: { id: outcome.id, hash: outcome.hash, replayed: true } }
      : { result: { id: outcome.id, hash: outcome.hash, replayed: false, replaced: outcome.replaced, file: outcome.file } };
  },
};
