/* tldr; — email tokens.
 *
 * Mirrors docs/brand/tokens.css. Duplicated here because an email cannot load a
 * stylesheet: every value has to be baked into a style attribute, so the
 * renderer needs the numbers in JavaScript. tokens.css stays the source of
 * truth; if a value changes there it changes here, and nowhere else.
 *
 * Tokens are named for the job rather than the colour. `solid` means "the
 * identity plane", and in night lighting that plane is not #0000EE — a renderer
 * that asked for "blue" would get the wrong answer in one of the two modes.
 *
 * Every pairing these produce is declared and measured in
 * docs/brand/check-contrast.mjs. Thirty pairings, thirty passing.
 */

export const DAY = Object.freeze({
  mode: "day",
  stock: "#F8FAFC",
  raised: "#FFFFFF",
  ink: "#20242C",
  muted: "#465365",
  link: "#0000EE",
  field: "#AFCFF5",
  solid: "#0000EE",
  onSolid: "#F8FAFC",
  onSolidMuted: "#AFCFF5",
  line: "#6A7DA5",
  accent: "#D9FF00",
  onAccent: "#20242C",
});

export const NIGHT = Object.freeze({
  mode: "night",
  stock: "#101520",
  raised: "#19202E",
  ink: "#E9EDF5",
  muted: "#A6B3C9",
  link: "#93AEFF",
  field: "#1C2A45",
  solid: "#2440E8",
  onSolid: "#EAEFFF",
  onSolidMuted: "#C8D4FB",
  line: "#5A6880",
  accent: "#D9FF00",
  onAccent: "#20242C",
});

/* No webfont will ever load in a mail client, so these are the faces actually
 * present on the machine. That is the design, not a concession.
 *
 * The condensed face is the brand's voice and it is doing real work here: a
 * subject line holds about three more words per line in Arial Narrow than in the
 * reading face at the same size, and subjects are the one string in this system
 * whose length nobody controls. */
export const DISPLAY =
  "'Arial Narrow','Aptos Narrow','Helvetica Neue Condensed',Arial,sans-serif";
export const BODY = "Verdana,Geneva,Tahoma,sans-serif";
export const MONO =
  "ui-monospace,SFMono-Regular,Menlo,Consolas,'Courier New',monospace";

/* The condensed face carries short phrases and meaningful numerals only. It
 * never sets a paragraph — that is what the reading face is for, at a 16px floor
 * because the primary reading device is a phone held at arm's length at 3am. */
export const TYPE = Object.freeze({
  /* The TLDR result. The largest thing in the message, and the only display
   * string long enough to wrap. */
  result: `font-family:${DISPLAY};font-size:26px;line-height:1.12;font-weight:700;letter-spacing:-.02em;`,
  tldrLabel: `font-family:${DISPLAY};font-size:12px;line-height:1.2;font-weight:700;letter-spacing:.14em;`,
  chip: `font-family:${DISPLAY};font-size:11px;line-height:1.2;font-weight:700;letter-spacing:.1em;`,
  body: `font-family:${BODY};font-size:16px;line-height:1.55;`,
  small: `font-family:${BODY};font-size:13px;line-height:1.5;`,
  label: `font-family:${BODY};font-size:12px;line-height:1.25;font-weight:700;letter-spacing:.02em;`,
  context: `font-family:${MONO};font-size:12px;line-height:1.5;`,
  section: `font-family:${DISPLAY};font-size:21px;line-height:1.15;font-weight:700;letter-spacing:-.01em;`,
  sub: `font-family:${DISPLAY};font-size:16px;line-height:1.2;font-weight:700;letter-spacing:.02em;`,
  /* The numeral device: oversized condensed figures indexing a real step. */
  numeral: `font-family:${DISPLAY};font-size:20px;line-height:1;font-weight:700;`,
  code: `font-family:${MONO};font-size:13px;line-height:1.5;`,
  tag: `font-family:${MONO};font-size:11px;line-height:1.2;letter-spacing:.08em;`,
  tableHead: `font-family:${DISPLAY};font-size:12px;line-height:1.2;font-weight:700;letter-spacing:.08em;`,
  tableCell: `font-family:${BODY};font-size:14px;line-height:1.5;`,
  /* The system bar. */
  stamp: `font-family:${DISPLAY};font-size:12px;line-height:1.2;font-weight:700;letter-spacing:.1em;`,
});

/* One reading column. */
export const CARD_WIDTH = 600;

/* Radius is 0, 2 or 4. Four is the maximum in the system and the TLDR block is
 * where it is spent; code takes two; nothing is a rounded card. */
export const RADIUS = Object.freeze({ sm: "2px", md: "4px" });
