import { lstat, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeTextAtomic } from "./durable_file_io.mjs";

function invalidIdentity() {
  const error = new Error("TLDR Tightbeam Slack identity is invalid");
  error.code = "TLDR_SLACK_IDENTITY_INVALID";
  return error;
}

const nonEmpty = (value) => typeof value === "string" && value.length > 0;

export function slackIdentityStore(home) {
  const path = join(home, "tightbeam-slack-identity.json");
  return Object.freeze({
    async load() {
      try {
        if (!(await lstat(path)).isFile()) throw invalidIdentity();
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw invalidIdentity();
      }
      let identity;
      try {
        identity = JSON.parse(await readFile(path, "utf8"));
      } catch {
        throw invalidIdentity();
      }
      if (!nonEmpty(identity?.app_id) || !nonEmpty(identity?.app_secret)) {
        throw invalidIdentity();
      }
      return identity;
    },
    async save(identity) {
      await mkdir(home, { recursive: true, mode: 0o700 });
      writeTextAtomic(path, `${JSON.stringify(identity)}\n`, {
        durable: true,
        mode: 0o600,
      });
    },
  });
}
