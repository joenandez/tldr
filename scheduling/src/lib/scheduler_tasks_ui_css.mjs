export const schedulerTasksCss = `
:root {
  color-scheme: light;
  --bg: #f4f1ea;
  --surface: #fffdf8;
  --surface-2: #ebe6dc;
  --ink: #1b1b18;
  --muted: #68645b;
  --line: #d7d0c2;
  --accent: #0e6f68;
  --ok: #16724f;
  --warn: #a65f00;
  --bad: #a13b3b;
  --shadow: 0 16px 34px rgba(33, 28, 18, 0.12);
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background:
    linear-gradient(90deg, rgba(27,27,24,.04) 1px, transparent 1px) 0 0 / 32px 32px,
    linear-gradient(180deg, rgba(14,111,104,.05), transparent 260px),
    var(--bg);
  color: var(--ink);
}
button, input, select { font: inherit; }
.shell { max-width: 1380px; margin: 0 auto; padding: 28px; }
header {
  display: grid;
  grid-template-columns: minmax(280px, 1fr) auto;
  gap: 20px;
  align-items: end;
  margin-bottom: 18px;
}
h1 { margin: 0; font-size: 28px; line-height: 1.08; letter-spacing: 0; }
.meta { margin-top: 8px; color: var(--muted); font-size: 13px; }
.toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.control, .segmented {
  background: var(--surface);
  border: 1px solid var(--line);
  box-shadow: inset 0 1px rgba(255,255,255,.75);
  height: 38px;
}
.control {
  border-radius: 8px;
  padding: 0 11px;
  min-width: 190px;
  color: var(--ink);
}
.segmented {
  border-radius: 8px;
  padding: 3px;
  display: inline-flex;
  gap: 3px;
}
.segmented button {
  border: 0;
  background: transparent;
  border-radius: 6px;
  padding: 0 10px;
  min-width: 78px;
  color: var(--muted);
  cursor: pointer;
}
.segmented button.active {
  background: var(--accent);
  color: white;
  box-shadow: 0 2px 8px rgba(14,111,104,.22);
}
.summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}
.metric {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px;
  box-shadow: inset 0 1px rgba(255,255,255,.78);
}
.metric b { display: block; font-size: 24px; line-height: 1; }
.metric span { color: var(--muted); font-size: 12px; }
.panel {
  background: rgba(255,253,248,.92);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: var(--shadow);
  overflow: hidden;
}
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th, td {
  text-align: left;
  border-bottom: 1px solid var(--line);
  padding: 11px 12px;
  vertical-align: middle;
  font-size: 13px;
}
th {
  background: var(--surface-2);
  color: var(--muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: .04em;
  position: sticky;
  top: 0;
  z-index: 1;
}
tr:last-child td { border-bottom: 0; }
tbody tr:hover { background: rgba(14,111,104,.045); }
.task-title { font-weight: 650; overflow-wrap: anywhere; }
.subtle { color: var(--muted); font-size: 12px; margin-top: 3px; overflow-wrap: anywhere; }
.state-cell {
  display: grid;
  grid-template-columns: 9px minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  min-width: 0;
}
.state-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--muted);
  box-shadow: 0 0 0 4px rgba(104,100,91,.12);
}
.state-cell.ok .state-dot {
  background: var(--ok);
  box-shadow: 0 0 0 4px rgba(22,114,79,.12);
}
.state-cell.warn .state-dot {
  background: var(--warn);
  box-shadow: 0 0 0 4px rgba(166,95,0,.14);
}
.state-title,
.result-title {
  font-weight: 680;
  line-height: 1.15;
  overflow-wrap: anywhere;
}
.state-note,
.result-note {
  margin-top: 3px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.2;
  overflow-wrap: anywhere;
}
.result-cell {
  display: inline-grid;
  min-width: 94px;
  max-width: 100%;
  border-radius: 8px;
  padding: 7px 9px;
  background: rgba(104,100,91,.08);
  color: var(--muted);
  box-shadow: inset 0 1px rgba(255,255,255,.55);
}
.result-cell.ok {
  background: rgba(22,114,79,.11);
  color: var(--ok);
}
.result-cell.warn {
  background: rgba(166,95,0,.12);
  color: var(--warn);
}
.result-cell.bad {
  background: rgba(161,59,59,.12);
  color: var(--bad);
}
.result-cell .result-note { color: color-mix(in srgb, currentColor 72%, var(--muted)); }
.pill {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  max-width: 100%;
  border-radius: 999px;
  padding: 3px 8px;
  background: var(--surface-2);
  color: var(--muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.pill.ok { background: rgba(22,114,79,.12); color: var(--ok); }
.pill.warn { background: rgba(166,95,0,.12); color: var(--warn); }
.pill.bad { background: rgba(161,59,59,.12); color: var(--bad); }
.switch {
  position: relative;
  width: 48px;
  height: 28px;
  border: 0;
  border-radius: 999px;
  background: #b9b1a2;
  cursor: pointer;
  box-shadow: inset 0 2px 5px rgba(0,0,0,.18);
}
.switch::after {
  content: "";
  position: absolute;
  width: 22px;
  height: 22px;
  top: 3px;
  left: 3px;
  border-radius: 50%;
  background: white;
  box-shadow: 0 2px 5px rgba(0,0,0,.25);
  transition: transform .16s ease;
}
.switch.on { background: var(--accent); }
.switch.on::after { transform: translateX(20px); }
.switch:disabled { opacity: .55; cursor: wait; }
.delete-button {
  min-height: 30px;
  border: 1px solid color-mix(in srgb, var(--bad) 44%, var(--line));
  border-radius: 7px;
  padding: 4px 9px;
  background: var(--surface);
  color: var(--bad);
  font-size: 12px;
  font-weight: 650;
  cursor: pointer;
  box-shadow: inset 0 1px rgba(255,255,255,.78), 0 1px 2px rgba(33,28,18,.08);
  transition: background .14s ease, color .14s ease, box-shadow .14s ease;
}
.delete-button:hover {
  background: var(--bad);
  color: white;
  box-shadow: inset 0 1px rgba(255,255,255,.2), 0 3px 8px rgba(161,59,59,.2);
}
.delete-button:focus-visible,
.switch:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--accent) 45%, transparent);
  outline-offset: 2px;
}
.delete-button:disabled { opacity: .55; cursor: wait; }
.empty, .error {
  padding: 34px;
  text-align: center;
  color: var(--muted);
}
.error { color: var(--bad); }
.toast {
  position: fixed;
  right: 22px;
  bottom: 22px;
  max-width: min(420px, calc(100vw - 44px));
  background: var(--ink);
  color: white;
  border-radius: 8px;
  padding: 12px 14px;
  box-shadow: var(--shadow);
  opacity: 0;
  transform: translateY(12px);
  pointer-events: none;
  transition: opacity .16s ease, transform .16s ease;
  font-size: 13px;
}
.toast.show { opacity: 1; transform: translateY(0); }
@media (max-width: 900px) {
  .shell { padding: 18px; }
  header { grid-template-columns: 1fr; align-items: start; }
  .toolbar { justify-content: flex-start; }
  .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  th:nth-child(4), td:nth-child(4),
  th:nth-child(5), td:nth-child(5) { display: none; }
}
@media (max-width: 620px) {
  .summary { grid-template-columns: 1fr; }
  .control { width: 100%; min-width: 0; }
  .segmented { width: 100%; height: auto; }
  .segmented button { flex: 1; height: 34px; min-width: 0; }
  th, td { padding: 10px 8px; }
  th:nth-child(3), td:nth-child(3),
  th:nth-child(6), td:nth-child(6) { display: none; }
  .result-cell { min-width: 0; padding: 6px 7px; }
}
`;
