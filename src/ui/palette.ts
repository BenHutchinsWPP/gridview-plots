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
