/* Email-specific reading tokens.
 *
 * The wider tldr; identity is deliberately not the visual world of an owner
 * conversation. Email should feel like careful correspondence between a person
 * and their agent. Brand colour is reserved for links and the final semicolon
 * in the quiet footer signature.
 */

/* Off-white rather than #FFFFFF: clients that auto-invert dark mode (classic
 * Outlook, Windows Mail) override pure white/black but leave near values to the
 * author, so the day document survives inversion heuristics intact. */
export const DAY = Object.freeze({
  mode: "day",
  page: "#FDFDFD",
  stock: "#FDFDFD",
  raised: "#F4F5F7",
  ink: "#24262B",
  muted: "#626770",
  link: "#315ECA",
  line: "#DADDE2",
  strongLine: "#C5C9D0",
});

export const NIGHT = Object.freeze({
  mode: "night",
  page: "#17181B",
  stock: "#17181B",
  raised: "#222429",
  ink: "#ECEDEF",
  muted: "#A8ACB4",
  link: "#9AAFF0",
  line: "#373A41",
  strongLine: "#50545D",
});

/* Native UI faces make the email feel authored in the reader's environment,
 * not typeset by a product. These are installed defaults, so nothing is fetched
 * and every major client has a compatible fallback. */
export const BODY =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
export const DISPLAY = BODY;
export const MONO =
  "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono','Courier New',monospace";

/* 14px/1.5 body is the density of mail people actually write to each other —
 * Outlook composes at ~14.7px, Gmail and Apple Mail read smaller. The 16–18px
 * convention belongs to marketing mail read at a glance, not correspondence.
 * Headings stay within ~1.3× body: a colleague bolds a line, they do not set
 * display type. */
export const TYPE = Object.freeze({
  body: `font-family:${BODY};font-size:14px;line-height:1.5;font-weight:400;`,
  small: `font-family:${BODY};font-size:12.5px;line-height:1.5;font-weight:400;`,
  label: `font-family:${BODY};font-size:12px;line-height:1.45;font-weight:600;`,
  context: `font-family:${BODY};font-size:11.5px;line-height:1.5;font-weight:400;`,
  section: `font-family:${BODY};font-size:17px;line-height:1.4;font-weight:600;letter-spacing:-.01em;`,
  sub: `font-family:${BODY};font-size:15px;line-height:1.45;font-weight:600;`,
  code: `font-family:${MONO};font-size:12.5px;line-height:1.55;font-weight:400;`,
  tag: `font-family:${BODY};font-size:11px;line-height:1.4;font-weight:600;`,
  tableHead: `font-family:${BODY};font-size:12.5px;line-height:1.45;font-weight:600;`,
  tableCell: `font-family:${BODY};font-size:13.5px;line-height:1.5;font-weight:400;`,
  systemLabel: `font-family:${BODY};font-size:11.5px;line-height:1.45;font-weight:500;`,
  systemTitle: `font-family:${BODY};font-size:19px;line-height:1.35;font-weight:600;letter-spacing:-.01em;`,
  codePlate: `font-family:${MONO};font-size:28px;line-height:1.3;font-weight:500;letter-spacing:.12em;`,
  colophon: `font-family:${BODY};font-size:11px;line-height:1.45;font-weight:400;`,
});

/* 640 sits inside the ~650px ceiling Outlook and Yahoo render comfortably and,
 * with 24px gutters, gives prose a 592px measure — the width of a note in a
 * desktop reading pane rather than a mobile-first promotional column. */
export const CARD_WIDTH = 640;
export const GUTTER = 24;
export const RADIUS = Object.freeze({ sm: "4px", md: "6px" });
