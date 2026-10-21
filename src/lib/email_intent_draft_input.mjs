// Validation of a caller's email-intent draft fields, split from
// email_intent_drafts.mjs (which re-exports these names): only user-authored
// recipient/content or a notification summary is accepted, never store-owned
// lifecycle fields, provider receipts, delivery claims, or secrets.
const INPUT_FIELDS = new Set([
  "session",
  "action_kind",
  "recipient",
  "subject",
  "content",
  "notification_summary",
]);
// Store-owned lifecycle fields, provider receipts, delivery claims, and
// credentials are never accepted from a caller.
const FORBIDDEN_FIELD =
  /^(?:id|state|created_at|expires_at|claimed_at|claimed_by_pid|claimed_by_start|commit_cwd)$|receipt|deliver|message_id|provider|sent|status|api_?key|secret|token|password|credential|verification|code/iu;
const SECRET_PATTERNS = [
  /\b(?:am|sk|pk|rk)_[A-Za-z0-9_]{16,}/u,
  /\b(?:api[_ -]?key|secret|token|password|passcode)\b\s*[:=]/iu,
  /\b(?:verification|confirmation|security|login|one[- ]time|auth(?:entication)?)\s+(?:code|pin)\b\D{0,24}\d{4,8}\b/iu,
  /\b(?:otp|2fa|mfa)\b\D{0,24}\d{4,8}\b/iu,
];
const LIMITS = Object.freeze({
  session: 200,
  subject: 200,
  content: 20_000,
  notification_summary: 2_000,
});
const KIND_FIELDS = Object.freeze({
  send: ["recipient", "subject", "content"],
  notification: ["notification_summary"],
});

export class EmailIntentDraftError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function refuseDraft(code, message) {
  throw new EmailIntentDraftError(code, message);
}

function checkText(field, value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    refuseDraft("DRAFT_INVALID", `${field} must be nonblank text`);
  }
  if (value.length > LIMITS[field]) {
    refuseDraft(
      "DRAFT_INVALID",
      `${field} is longer than ${LIMITS[field]} characters`,
    );
  }
  if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) {
    refuseDraft(
      "DRAFT_SECRET_REJECTED",
      `${field} looks like it holds a credential or verification code; drafts never store secrets`,
    );
  }
}

// Returns only the fields a draft may keep for its action kind.
export function validateDraftInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    refuseDraft("DRAFT_INVALID", "a draft needs an object of fields");
  }
  for (const field of Object.keys(input)) {
    if (INPUT_FIELDS.has(field)) continue;
    if (FORBIDDEN_FIELD.test(field)) {
      refuseDraft(
        "DRAFT_FIELD_FORBIDDEN",
        `${field} is never stored in a draft`,
      );
    }
    refuseDraft("DRAFT_FIELD_UNKNOWN", `${field} is not a draft field`);
  }
  const kindFields = KIND_FIELDS[input.action_kind];
  if (!kindFields)
    refuseDraft("DRAFT_INVALID", "action_kind must be send or notification");
  if (
    typeof input.session !== "string" ||
    !/^[\w.:@-]+$/u.test(input.session)
  ) {
    refuseDraft("DRAFT_INVALID", "session must be a session reference");
  }
  checkText("session", input.session);
  for (const field of [
    "recipient",
    "subject",
    "content",
    "notification_summary",
  ]) {
    const present = input[field] !== undefined;
    if (present !== kindFields.includes(field)) {
      refuseDraft(
        "DRAFT_INVALID",
        `${field} is ${present ? "not allowed" : "required"} for a ${input.action_kind} draft`,
      );
    }
  }
  if (input.action_kind === "send" && input.recipient !== "user") {
    refuseDraft(
      "DRAFT_INVALID",
      "recipient must be user: email goes only to the owner",
    );
  }
  for (const field of kindFields.filter((name) => name !== "recipient")) {
    checkText(field, input[field]);
  }
  return Object.fromEntries(
    ["session", "action_kind", ...kindFields].map((field) => [
      field,
      input[field],
    ]),
  );
}
