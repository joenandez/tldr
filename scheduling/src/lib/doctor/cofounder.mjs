import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertHelmHomeCreatable } from "../store.mjs";

export async function runCofounderChecks() {
  let identityImpl;
  try {
    identityImpl = await import("../identity.mjs");
  } catch {
    identityImpl = null;
  }

  const node_major =
    Number((process.version || "").replace(/^v/, "").split(".")[0]) || 0;
  // The resolver refuses a home it must not use (a pending state-root
  // migration); doctor reports that as not writable rather than crashing.
  let helm_home_path = null;
  try {
    helm_home_path = identityImpl?.getHelmHome?.() || null;
  } catch {
    helm_home_path = null;
  }
  let helm_home_writable = false;
  if (helm_home_path) {
    try {
      assertHelmHomeCreatable(helm_home_path);
      mkdirSync(helm_home_path, { recursive: true, mode: 0o700 });
      const probe = join(helm_home_path, `.doctor-probe-${process.pid}`);
      writeFileSync(probe, "");
      unlinkSync(probe);
      helm_home_writable = true;
    } catch {
      helm_home_writable = false;
    }
  }

  const identity = identityImpl?.readIdentity?.() || null;
  let workspaces_root_readable = "unknown";
  if (identity?.subspace_managed_workspaces) {
    workspaces_root_readable = "subspace_managed";
  } else if (identity?.workspaces_root) {
    try {
      workspaces_root_readable =
        existsSync(identity.workspaces_root) &&
        statSync(identity.workspaces_root).isDirectory();
    } catch {
      workspaces_root_readable = false;
    }
  }

  let claude_permission_posture = "unknown";
  try {
    const settings = join(homedir(), ".claude", "settings.json");
    if (existsSync(settings)) {
      claude_permission_posture = readFileSync(settings, "utf8").includes(
        "dangerously-skip-permissions",
      );
    }
  } catch {
    claude_permission_posture = "unknown";
  }

  return {
    node_version_ok: node_major >= 20,
    node_major,
    helm_home_writable,
    helm_home_path,
    identity_present: Boolean(identity),
    workspaces_root_readable,
    claude_permission_posture,
  };
}
