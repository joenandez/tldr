// Per-scope semaphore + registry of in-flight job runs.
//
// The Helm daemon dispatch tick is fire-and-forget: it spawns due jobs and
// returns immediately. The completion of each run lives on as a Promise here
// so tests can drain in-flight work and `dispatch_finished` semantics stay sane.
//
// Cap resolution order: HELM_MAX_CONCURRENT_RUNS env > config file > default 16.
// We deliberately don't read the config file here on each call — the daemon
// can call `setCap(scope, n)` at boot if it wants to override.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { helmHomeFor } from './store.mjs';

export const DEFAULT_MAX_CONCURRENT_RUNS = 16;

// scopeKey -> { inflight: Map<runId, Promise>, cap: number }
const REGISTRIES = new Map();

function scopeKey(scope) {
  if (scope && typeof scope === 'object') {
    return scope.scope_id || scope.cwd || '__default__';
  }
  return '__default__';
}

function resolveCapFromEnvOrConfig() {
  const envCap = Number.parseInt(process.env.HELM_MAX_CONCURRENT_RUNS, 10);
  if (Number.isFinite(envCap) && envCap > 0) return envCap;

  const helmHome = helmHomeFor({ envHome: process.env.HELM_HOME });
  const configPath = join(helmHome, 'service', 'config.json');
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
      const fromConfig = Number.parseInt(parsed?.maxConcurrentRuns, 10);
      if (Number.isFinite(fromConfig) && fromConfig > 0) return fromConfig;
    } catch {
      // fall through
    }
  }
  return DEFAULT_MAX_CONCURRENT_RUNS;
}

function getRegistry(scope) {
  const key = scopeKey(scope);
  let reg = REGISTRIES.get(key);
  if (!reg) {
    reg = { inflight: new Map(), cap: resolveCapFromEnvOrConfig() };
    REGISTRIES.set(key, reg);
  }
  return reg;
}

export function acquireSlot(scope, runId, completion) {
  const reg = getRegistry(scope);
  if (reg.inflight.size >= reg.cap) return null;
  reg.inflight.set(runId, completion);
  return function release() {
    reg.inflight.delete(runId);
  };
}

export function inflightCount(scope) {
  return getRegistry(scope).inflight.size;
}

export function capForScope(scope) {
  return getRegistry(scope).cap;
}

export async function drainInflight(scope) {
  const reg = getRegistry(scope);
  const promises = [...reg.inflight.values()];
  if (promises.length === 0) return;
  await Promise.allSettled(promises);
}

export function _resetForTest() {
  REGISTRIES.clear();
}

export function _setCapForTest(scope, cap) {
  getRegistry(scope).cap = cap;
}
