/* tldr; — drawn glyphs.
 *
 * An email cannot load an icon font, an SVG or a remote image, so the one mark
 * in this system is drawn out of table cells: a matrix of 2px squares, coloured
 * or nothing.
 *
 * Resolution is the whole game. At 3px cells and five rows there is not enough
 * room above and below the shaft for an arrowhead, and the reply mark renders as
 * a plus. 2px cells and nine rows is the floor at which a diagonal reads as a
 * diagonal.
 *
 * The glyph never carries meaning alone. It sits beside the sentence it marks,
 * so it adds structure to the block without asking the reader to decode it.
 *
 * There is no citron glyph. On a light card citron is 1.10:1 and decorative
 * only, so the live edge is a filled chip with `onAccent` text on it rather than
 * a drawn mark — the words carry the meaning and the colour carries the
 * attention. A citron arrow would be a mark nobody could see in daylight.
 */

const MATRIX = Object.freeze({
  /* Reply: an arrow back to the sender. It marks the next moment — the one
   * instruction in the message. */
  reply: [
    "....#.......",
    "...##.......",
    "..###.......",
    ".####.......",
    "############",
    ".####.......",
    "..###.......",
    "...##.......",
    "....#.......",
  ],
});

const CELL = 2;

/* `fillClass` lands on the inked cells only. The blank cells carry no class and
 * no background, so the night block can repaint a glyph without flooding the
 * whole matrix — the difference between a mark and a solid square. */
export function glyph(name, colour, fillClass) {
  const matrix = MATRIX[name];
  const rows = matrix
    .map(
      (row) =>
        `<tr>${[...row]
          .map((cell) =>
            cell === "#"
              ? `<td class="${fillClass}" height="${CELL}" width="${CELL}" bgcolor="${colour}" style="font-size:0;line-height:${CELL}px;padding:0;">&nbsp;</td>`
              : `<td height="${CELL}" width="${CELL}" style="font-size:0;line-height:${CELL}px;padding:0;">&nbsp;</td>`,
          )
          .join("")}</tr>`,
    )
    .join("");

  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" ` +
    `style="border-collapse:collapse;width:${CELL * matrix[0].length}px;">${rows}</table>`
  );
}

/* The plain-text twin marks the same place with the same intent. */
export const TEXT_GLYPH = Object.freeze({
  reply: "<-",
});
