export function nowIso() {
  return new Date().toISOString();
}

export function output(command, ok, data = {}, errors = [], pretty = false) {
  const payload = {
    ok,
    command,
    timestamp: nowIso(),
    data,
    errors,
  };
  const text = pretty
    ? JSON.stringify(payload, null, 2)
    : JSON.stringify(payload);
  process.stdout.write(`${text}\n`);
}

export function fail(command, code, message, details = {}, pretty = false) {
  output(command, false, details, [{ code, message }], pretty);
}

export function parseArgs(argv) {
  const args = [...argv];
  const positionals = [];
  const flags = {};
  const trailingArgs = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === "--") {
      for (let j = i + 1; j < args.length; j++) {
        trailingArgs.push(args[j]);
      }
      break;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = args[i + 1];
    if (!next || next === "--" || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    i += 1;
  }
  return { positionals, flags, trailingArgs };
}

export function commandName(positionals) {
  if (positionals.length === 0) return "";
  if (positionals[0] === "heartbeat" && positionals[1]) {
    return `heartbeat.${positionals[1]}`;
  }
  if (positionals[0] === "service" && positionals[1]) {
    return `service.${positionals[1]}`;
  }
  if (positionals[0] === "system" && positionals[1]) {
    return `system.${positionals[1]}`;
  }
  if (positionals[0] === "sentinel" && positionals[1]) {
    return `sentinel.${positionals[1]}`;
  }
  if (positionals[0] === "daemon" && positionals[1]) {
    return `daemon.${positionals[1]}`;
  }
  if (positionals[0] === "dev-daemon" && positionals[1]) {
    return `dev-daemon.${positionals[1]}`;
  }
  if (positionals[0] === "server" && positionals[1]) {
    return `server.${positionals[1]}`;
  }
  if (positionals[0] === "check" && positionals[1]) {
    return `check.${positionals[1]}`;
  }
  if (positionals[0] === "thread" && positionals[1] === "followup") {
    return "thread.followup";
  }
  return positionals[0];
}
