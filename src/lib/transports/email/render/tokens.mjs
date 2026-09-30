/* The values the letter is set in.
 *
 * An owner–agent email is correspondence, so it is typeset like a letter and
 * not like a product surface: one reading face, no fill anywhere, and structure
 * carried by one-pixel greys that survive a client's dark-mode inversion.
 *
 * Primary text takes no colour at all. Whatever ink the reader's client uses is
 * the right ink, and a declared near-black is the value an inverting client
 * fights with.
 */

/* Three faces and no more. Every one is installed on the machines that read
 * this mail, so nothing is fetched. Iowan Old Style is the Apple serif; Charter
 * covers the rest of the platforms that have it; Georgia is the floor. */
export const SERIF = "'Iowan Old Style',Charter,Georgia,serif";
export const MONO = "Menlo,Consolas,'Courier New',monospace";
export const SANS =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

/* Four greys. MUTED is the only colour on text — quotes, image placeholders,
 * unchanged diff lines and the signature block. The other three are rules,
 * graded so a table header reads heavier than a table row. */
export const MUTED = "#6b6b6b";
export const RULE = "#c0c0c0";
export const HEAD_RULE = "#8a8a8a";
export const HAIRLINE = "#dcdcdc";

/* 640 with a 15.5px serif is roughly 70 characters — the measure of a page,
 * and inside the width Outlook and Yahoo render without a horizontal scroll. */
export const MEASURE = 640;

export const LEADING = "1.55";

export const SIZE = Object.freeze({
  body: "15.5px",
  heading: "17px",
  subheading: "15.5px",
  code: "12.5px",
  table: "14px",
  signature: "11.5px",
  code_plate: "24px",
});
