// Minimal INI merge for .wslconfig and wsl.conf: set keys, keep everything else.

function sectionRange(lines, name) {
  let start = lines.findIndex((l) => l.trim().toLowerCase() === `[${name}]`);
  if (start < 0) {
    if (lines.length) lines.push("");
    lines.push(`[${name}]`);
    start = lines.length - 1;
  }
  const next = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
  return [start, next < 0 ? lines.length : next];
}

function setKey(lines, name, [key, value]) {
  const [start, end] = sectionRange(lines, name);
  const keyLine = new RegExp(`^\\s*${key}\\s*=`, "i");
  const at = lines.findIndex((l, i) => i > start && i < end && keyLine.test(l));
  if (at >= 0) {
    const current = lines[at].slice(lines[at].indexOf("=") + 1).trim();
    if (current !== value) lines[at] = `${key}=${value}`;
    return;
  }
  let last = end;
  while (last > start + 1 && lines[last - 1].trim() === "") last -= 1;
  lines.splice(last, 0, `${key}=${value}`);
}

// Sets only the given keys. Other keys, sections, comments, and line endings stay.
export function mergeIni(text, sections) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines =
    text.trim() === "" ? [] : text.replace(/\r?\n$/, "").split(/\r?\n/);
  for (const [name, keys] of Object.entries(sections))
    for (const pair of Object.entries(keys)) setKey(lines, name, pair);
  return lines.join(eol) + eol;
}
