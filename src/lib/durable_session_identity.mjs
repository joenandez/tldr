import {
  readIdentity,
  readState,
  writeIdentity,
  writeState,
} from "./identity_state.mjs";

export function ensureDurableSessionIdentity({
  sessionId,
  runtime,
  pid = null,
  cwd = null,
}) {
  if (!sessionId || !runtime) return;
  if (!readIdentity(sessionId)) {
    writeIdentity({
      sessionId,
      runtime,
      pid,
      controllingTty: null,
      launchMode: "non_interactive",
      launchSource: "durable_resume",
      installPath: cwd || null,
      cwd: cwd || null,
    });
  }
  if (!readState(sessionId)) {
    writeState(sessionId, { state: "idle", lastPid: pid });
  }
}
