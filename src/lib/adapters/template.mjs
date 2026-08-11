const PLACEHOLDER_RE =
  /\{\{\s*([^}|]+?)(?:\s*\|\s*default:\s*([^}]*?))?\s*\}\}/g;

function resolvePath(expr, ctx) {
  const parts = expr.split(".");
  let cur = ctx;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

export function expandTemplate(input, ctx) {
  if (typeof input !== "string") return input;
  return input.replace(PLACEHOLDER_RE, (_, rawExpr, defaultVal) => {
    const expr = rawExpr.trim();
    const value = resolvePath(expr, ctx);
    if (value !== undefined && value !== null) return String(value);
    if (defaultVal !== undefined) return defaultVal.trim();
    throw new Error(
      `template: unknown placeholder or unresolved value: ${expr}`,
    );
  });
}

export function expandArgv(argv, ctx) {
  if (!Array.isArray(argv)) return argv;
  return argv.map((item) => expandTemplate(item, ctx));
}
