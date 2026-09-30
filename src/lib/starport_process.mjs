import { spawn } from "node:child_process";

export function runWithClosedStdin(
  command,
  args,
  { env, maxBuffer = 64 * 1024 } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output = { stdout: "", stderr: "" };
    const rejectWithOutput = (error) => reject(Object.assign(error, output));
    for (const [stream, key] of [
      [child.stdout, "stdout"],
      [child.stderr, "stderr"],
    ]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        output[key] += chunk;
        if (Buffer.byteLength(output[key]) > maxBuffer) {
          child.kill();
          rejectWithOutput(
            new Error(`Tightbeam ${key} exceeds welcome buffer`),
          );
        }
      });
    }
    child.once("error", rejectWithOutput);
    child.once("close", (code) => {
      if (code === 0) resolve(output);
      else {
        const error = new Error(`Tightbeam exited with status ${code}`);
        error.code = code;
        rejectWithOutput(error);
      }
    });
    // Tightbeam's SessionStart refresh consumes hook stdin before it can send.
    child.stdin.end();
  });
}
