import { spawn } from "node:child_process";

// execFile with a hard bound that kills the whole process group (ac-jfv.74.1, review r4 #4).
// execFile drops `detached`, so its own timeout kills only the direct child and a hung CLI's own
// children keep the pipes open: the call never returns and the processes outlive it. Here the
// command is its own group leader, `timeoutMs` SIGKILLs the group, and the call settles at the
// timeout. Resolves { stdout } on exit 0; otherwise rejects with { code, signal, stdout, stderr }
// like execFile does.
// `detached: false` keeps the command in the caller's own process group, for a caller that is a
// group leader its parent kills as a whole (the warm notice child): killing the caller then ends
// the command too, with no orphan. A timeout cannot kill a group it shares, so it SIGKILLs the
// command and settles at once; what the command started stays until the caller's group is killed.
export function execInGroup(
  command,
  args,
  { env, timeoutMs, maxBuffer = 64 * 1024, detached = true },
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      if (detached) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        return;
      }
      child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      reject(
        Object.assign(new Error("command timed out"), {
          code: null,
          signal: "SIGKILL",
          stdout,
          stderr,
        }),
      );
    }, timeoutMs);
    const keep = (text, chunk) =>
      text.length < maxBuffer ? text + chunk.toString("utf8") : text;
    child.stdout.on("data", (chunk) => (stdout = keep(stdout, chunk)));
    child.stderr.on("data", (chunk) => (stderr = keep(stderr, chunk)));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(Object.assign(error, { stdout, stderr }));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          Object.assign(new Error(`command exited ${code ?? signal}`), {
            code,
            signal,
            stdout,
            stderr,
          }),
        );
    });
  });
}
