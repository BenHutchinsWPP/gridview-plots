// src/ui/palette.ts
//
// The shared colours, and nothing else: the ten categorical series colours and
// the fill-alpha derivative. The per-kind tints are drawn from these, but they
// are stated in `src/tables/registry.ts`, beside everything else a kind
// declares about itself.
//
// They were declared in `ui/shell.ts`, which registers a document keydown
// listener at import time and therefore cannot be imported under Node. The
// browse table's selection model is pure data and IS tested under Node, so the
// palette moved to a module with no DOM in it rather than being spelled a
// second time -- two palettes that drift apart is a legend that disagrees with
// the lines it labels. `ui/shell.ts` re-exports it, so every existing caller
// still reaches `CASE_COLORS` where it always did.
//
// Assigned at drop time (a case's colour) or at selection time (a series'),
// and never reshuffled: a ten-line overlay is only readable if the mapping is
// learned once.
//
// Nothing is imported back into this module on purpose: case-model and the
// registry both take their colours from here at runtime, so an import the
// other way would close a cycle, and this module must keep loading under Node
// beside the model suites that reach it.
// Five to a row, so the ten-colour palette is legible as a palette. A
// ten-line list of hex strings is not.
// prettier-ignore
export const CASE_COLORS = [
  '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
  '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf',
];

/**
 * A palette colour at reduced opacity, for a fill that sits under a stroke of
 * the same colour.
 *
 * Derived rather than spelled a second time: a filled band and the line on top
 * of it are one series, and a hand-written translucent twin of every entry is
 * two palettes again, drifting the way the one this module exists to prevent
 * drifted. Eight-digit hex because the entries are six-digit hex and a
 * two-digit alpha is the whole change; anything that is not `#rrggbb` is
 * returned untouched, so a caller passing a named colour gets an opaque fill
 * rather than a silently broken one.
 */
export function withAlpha(color: string, alpha: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color;
  const byte = Math.max(0, Math.min(255, Math.round(alpha * 255)));
  return color + byte.toString(16).padStart(2, '0');
}

/** The most a year's shade moves from the next year's, as a fraction of the
 * way to white or to black: two or three years stay plainly apart, and ten
 * spread over the room below. */
const SHADE_STEP = 0.25;
/** The whole ramp, white side and black side together. Wider pushes the
 * palette's light entries (#bcbd22, #17becf) towards the white page and its
 * dark ones (#8c564b, #d62728) towards the black axis text. */
const SHADE_SPAN = 0.8;

/**
 * Year `i` of `n` (0 the oldest) of one series drawn year over year: the
 * series' palette colour lightened for the older years and darkened for the
 * newer, the hue kept, so the lines read as one series and its years in
 * order. One rule for the pane and the Figure.
 *
 * The ramp is centred on the base colour, so the series' legend swatch is the
 * middle of its ramp and each end moves only part of the span from it. An
 * odd `n` draws its middle year in the base colour; an even `n` puts its two
 * middle years either side of it, the older lighter and the newer darker, a
 * full step apart. Rejected: the base at either end, which puts the whole
 * span on one side and takes a light entry onto the white page or a dark one
 * onto the black axis text. `shade(c, 0, 1)` is `c` itself.
 * A colour that is not `#rrggbb` comes back untouched, as from `withAlpha`.
 */
export function shade(color: string, i: number, n: number): string {
  if (n <= 1 || !/^#[0-9a-f]{6}$/i.test(color)) return color;
  const base = (n - 1) / 2;
  if (i === base) return color;
  // Negative towards white, positive towards black.
  const t = (i - base) * Math.min(SHADE_SPAN / (n - 1), SHADE_STEP);
  const rgb = parseInt(color.slice(1), 16);
  let out = '#';
  for (const shift of [16, 8, 0]) {
    const channel = (rgb >> shift) & 0xff;
    const moved = t < 0 ? channel + (0xff - channel) * -t : channel * (1 - t);
    out += Math.round(moved).toString(16).padStart(2, '0');
  }
  return out;
}
