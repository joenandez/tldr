import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function activeRuntimePointerPath(home = homedir()) {
  return join(home, ".tldr-agents", "active-runtime.json");
}

export function captureActiveRuntimePointer(path) {
  return existsSync(path) ? readFileSync(path) : null;
}

function writePrivatePointer(path, contents) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

export function restoreActiveRuntimePointer(path, previous) {
  try {
    if (previous === null) {
      try {
        unlinkSync(path);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    } else {
      writePrivatePointer(path, previous);
    }
  } catch (cause) {
    throw new Error(`tldr; active runtime pointer restore failed: ${path}`, {
      cause,
    });
  }
}

export function publishActiveRuntimePointer(path, sourceRoot) {
  try {
    const manifest = join(sourceRoot, "LOCAL-SNAPSHOT-MANIFEST.json");
    const release = existsSync(manifest)
      ? JSON.parse(readFileSync(manifest, "utf8")).localVersion
      : null;
    const version =
      release ||
      JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8"))
        .version;
    if (typeof version !== "string" || version.length === 0) {
      throw new Error("release version is unavailable");
    }
    writePrivatePointer(
      path,
      `${JSON.stringify({
        schema_version: 1,
        product: "tldr-agents",
        release: version,
        runtime_root: sourceRoot,
        bin: { tldr_agents: join(sourceRoot, "bin", "tldr-agents") },
      })}\n`,
    );
  } catch (cause) {
    throw new Error(`tldr; active runtime pointer publish failed: ${path}`, {
      cause,
    });
  }
}
