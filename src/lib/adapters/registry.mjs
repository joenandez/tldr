import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadManifest } from "./manifest_loader.mjs";

function listYamlFiles(dir) {
  try {
    const entries = readdirSync(dir);
    return entries
      .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
      .map((name) => join(dir, name))
      .filter((path) => {
        try {
          return statSync(path).isFile();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

export function createAdapterRegistry({ dirs = [] } = {}) {
  const map = new Map();
  for (const dir of dirs) {
    for (const file of listYamlFiles(dir)) {
      try {
        const adapter = loadManifest(file);
        map.set(adapter.name, adapter);
      } catch {
        // Invalid manifests are skipped — they surface via direct loadManifest tests.
      }
    }
  }
  return {
    has(name) {
      return map.has(name);
    },
    get(name) {
      return map.get(name) || null;
    },
    list() {
      return [...map.values()];
    },
  };
}
