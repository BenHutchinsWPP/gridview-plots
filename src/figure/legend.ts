// src/figure/legend.ts
//
// The figure's legend: a table under the plot, two lines to a row, one column
// per fact that differs between lines (`placeFacts`). A table, not a run of
// "swatch label" pairs, so long keys stay aligned and a reader can scan one
// column. Two to a row so one or two lines take one row and the plot keeps
// its height; a single line still gets its row, so the key is always in the
// same place on every figure.
//
// Widths come from the caller's `measureText` with slack: Word may set Aptos
// wider than the font the browser measured with. When the columns do not fit
// half the width, the narrow ones keep their width and the wide ones share
// what is left, wrapping their cells onto more lines: a key cut short could
// name a different line.

import { line, outlinedRect, text, type StrokeStyle } from './svg';
import type { LegendColumn } from './facts';

/** Measured widths are scaled by this before layout. */
export const MEASURE_SLACK = 1.12;

export const LEGEND_PT = 8.5;
const UNDER_PT = 7.5;
const LEADING = 1.3;
const SWATCH = 16;
const SWATCH_GAP = 4;
const COLUMN_GAP = 8;
const HALF_GAP = 14;
/** A box's outline and its fill's opacity over the white page, as the pane
 * draws a box: the swatch and the box are one mark. */
export const BOX_STROKE_PT = 0.75;
export const BOX_FILL_ALPHA = 0.25;

/**
 * `text` broken at spaces into lines no wider than `width` points (slack
 * included), a word wider than a line broken where it must be.
 */
export function wrapText(
  text: string,
  width: number,
  fontPt: number,
  measureText: (text: string, fontPt: number) => number,
): string[] {
  const fits = (candidate: string) => measureText(candidate, fontPt) * MEASURE_SLACK <= width;
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    const joined = current ? `${current} ${word}` : word;
    if (fits(joined)) {
      current = joined;
      continue;
    }
    if (current) lines.push(current);
    current = word;
    // A word alone too wide for a line is cut, after its last `_` or `-`
    // that fits (study names join their parts with them), else where it must.
    while (current.length > 1 && !fits(current)) {
      let cut = current.length - 1;
      while (cut > 1 && !fits(current.slice(0, cut))) cut--;
      const joint = Math.max(current.lastIndexOf('_', cut - 1), current.lastIndexOf('-', cut - 1));
      if (joint > 0) cut = joint + 1;
      lines.push(current.slice(0, cut));
      current = current.slice(cut);
    }
  }
  lines.push(current);
  return lines;
}

/**
 * Column widths that fit `available`: max-min fair, so a column narrower than
 * an equal share keeps its natural width and only the wider ones give way.
 */
function fitWidths(natural: readonly number[], available: number): number[] {
  const total = natural.reduce((sum, w) => sum + w, 0);
  if (total <= available) return [...natural];
  const out = [...natural];
  let remaining = Math.max(0, available);
  const order = natural.map((_, c) => c).sort((a, b) => natural[a] - natural[b]);
  order.forEach((c, i) => {
    out[c] = Math.min(natural[c], remaining / (order.length - i));
    remaining -= out[c];
  });
  return out;
}

export interface LegendEntry {
  readonly stroke: StrokeStyle;
  /** A box's fill: the swatch is a filled box rather than a stroke. */
  readonly fill?: string;
}

export interface LegendLayout {
  readonly height: number;
  /** The legend's markup with its top edge at `top`. */
  draw(top: number): string[];
}

/**
 * Lay out `entries` (one per line, in pane order) in `width` points starting
 * at `left`. `say(id, text)` returns the text to draw for a cell, so a
 * per-export edit replaces exactly that cell.
 */
export function layoutLegend(
  entries: readonly LegendEntry[],
  columns: readonly LegendColumn[],
  underRow: readonly string[],
  left: number,
  width: number,
  measureText: (text: string, fontPt: number) => number,
  say: (id: string, text: string) => string,
): LegendLayout {
  const cells = entries.map((_, row) =>
    columns.map((column, c) => say(`legend[${row}][${c}]`, column.cells[row] ?? '')),
  );
  const under = entries.map((_, row) =>
    underRow[row] ? say(`legend[${row}][under]`, underRow[row]) : '',
  );
  const half = (width - HALF_GAP) / 2;
  const natural = columns.map((_, c) =>
    Math.max(0, ...cells.map((row) => measureText(row[c], LEGEND_PT) * MEASURE_SLACK)),
  );
  const widths = fitWidths(
    natural,
    half - SWATCH - SWATCH_GAP - COLUMN_GAP * Math.max(0, columns.length - 1),
  );
  const wrapped = cells.map((row) =>
    row.map((cell, c) => (cell ? wrapText(cell, widths[c], LEGEND_PT, measureText) : [])),
  );
  const offsets: number[] = [];
  let at = SWATCH + SWATCH_GAP;
  for (const w of widths) {
    offsets.push(at);
    at += w + COLUMN_GAP;
  }
  const underWidth = half - (offsets[0] ?? SWATCH + SWATCH_GAP);
  const underWrapped = under.map((text) =>
    text ? wrapText(text, underWidth, UNDER_PT, measureText) : [],
  );

  const rows = Math.ceil(entries.length / 2);
  const rowLine = LEGEND_PT * LEADING;
  const underLine = UNDER_PT * LEADING;
  /** The lines one entry's cells take, and the lines under them. */
  const cellLines = (i: number) => Math.max(1, ...wrapped[i].map((lines) => lines.length));
  const rowHeights = Array.from({ length: rows }, (_, r) =>
    Math.max(
      ...[2 * r, 2 * r + 1]
        .filter((i) => i < entries.length)
        .map((i) => cellLines(i) * rowLine + underWrapped[i].length * underLine),
    ),
  );
  const height = rowHeights.reduce((sum, h) => sum + h, 0);

  return {
    height,
    draw(top) {
      const out: string[] = [];
      let rowTop = top;
      for (let r = 0; r < rows; r++) {
        const baseline = rowTop + LEGEND_PT;
        for (const i of [2 * r, 2 * r + 1]) {
          if (i >= entries.length) continue;
          const x0 = left + (i % 2) * (half + HALF_GAP);
          const mid = baseline - LEGEND_PT * 0.32;
          const { stroke, fill } = entries[i];
          out.push(
            fill
              ? outlinedRect(x0 + SWATCH / 4, mid - 3.5, SWATCH / 2, 7, fill, {
                  ...stroke,
                  width: BOX_STROKE_PT,
                })
              : line(x0, mid, x0 + SWATCH, mid, stroke),
          );
          wrapped[i].forEach((lines, c) => {
            lines.forEach((part, k) =>
              out.push(text(part, x0 + offsets[c], baseline + k * rowLine, { size: LEGEND_PT })),
            );
          });
          const underTop = baseline + (cellLines(i) - 1) * rowLine;
          underWrapped[i].forEach((part, k) =>
            out.push(
              text(part, x0 + offsets[0], underTop + (k + 1) * underLine, {
                size: UNDER_PT,
                fill: '#444444',
                italic: true,
              }),
            ),
          );
        }
        rowTop += rowHeights[r];
      }
      return out;
    },
  };
}
