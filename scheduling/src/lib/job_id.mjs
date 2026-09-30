const SAFE_JOB_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function isSafeJobId(value) {
  return typeof value === "string" && SAFE_JOB_ID_PATTERN.test(value);
}

export function assertSafeJobId(value) {
  if (!isSafeJobId(value)) {
    throw new TypeError(
      "job id must use lowercase letters, numbers, and dashes",
    );
  }
  return value;
}
