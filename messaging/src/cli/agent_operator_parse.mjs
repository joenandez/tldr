// Flags of the operator verbs (drive-liveness T5): `agent status|cancel
// --operator` runs outside a session, and both verbs take `--timeout <ms>`.
// Kept free of imports so agent_commands.mjs can use it without a cycle.

export const OPERATOR_TIMEOUT_MAX_MS = 3_600_000;

// `--name value`, `--name=value`, or a bare boolean `--name`; undefined when absent.
function take(args, name, { boolean = false } = {}) {
  const index = args.findIndex(
    (token) => token === `--${name}` || token.startsWith(`--${name}=`),
  );
  if (index === -1) return undefined;
  const [token] = args.splice(index, 1);
  const inline = token.startsWith(`--${name}=`);
  return boolean && !inline
    ? true
    : inline
      ? token.slice(name.length + 3)
      : args.splice(index, 1)[0];
}

function readOperator(args, parsed, fail) {
  const operator = take(args, "operator", { boolean: true });
  if (operator === undefined) return;
  if (operator !== true) fail("--operator does not take a value");
  if (parsed.command === "status" && !parsed.workId)
    fail("--operator reads one work: use --work <work_id>");
  if (parsed.waitDeliveryMs)
    fail("--operator cannot be combined with --wait-delivery");
  parsed.operator = true;
}

function readTimeout(args, parsed, fail) {
  const timeout = take(args, "timeout");
  if (timeout === undefined) return;
  const ms = /^\d+$/.test(timeout) ? Number(timeout) : NaN;
  if (!(ms >= 1 && ms <= OPERATOR_TIMEOUT_MAX_MS))
    fail(
      `--timeout must be a whole number of milliseconds from 1 to ${OPERATOR_TIMEOUT_MAX_MS}`,
    );
  parsed.deadlineMs = ms;
}

/** Reads --operator and --timeout off `args` onto `parsed`; `fail` throws the verb's usage error. Only a flag that was given is set. */
export function parseOperatorFlags(args, parsed, fail) {
  readOperator(args, parsed, fail);
  readTimeout(args, parsed, fail);
}
