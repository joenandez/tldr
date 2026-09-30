import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_SUBSPACE_HOME = join(homedir(), ".subspace");

export function buildSubspaceProviderLaunch(
  env = {},
  scrubEnv = (value) => ({ ...value }),
  wrapperPath = undefined,
) {
  const explicit =
    typeof env.SUBSPACE_HOME === "string" ? env.SUBSPACE_HOME.trim() : "";
  const home = explicit || DEFAULT_SUBSPACE_HOME;
  const bin = join(home, "bin");
  const cleanEnv = scrubEnv(env);
  return {
    cleanEnv,
    directEnv: { ...cleanEnv, PATH: `${bin}:${cleanEnv.PATH || ""}` },
    wrapper:
      wrapperPath === undefined
        ? join(bin, "helm-job-memory-wrapper")
        : wrapperPath,
    wrapperEnv: {
      ...cleanEnv,
      SUBSPACE_HOME: home,
      PATH: `${bin}:${cleanEnv.PATH || ""}`,
    },
  };
}
