// src/figure/stacked.ts
//
// The stacked pane as a figure: bands in the pane's stack order, each drawn
// between running totals, on the time pane's hour axis and ticks. The capture
// lists lines bottom band first; the legend reads top to bottom, like the
// bands.
//
// Totals follow the pane: an hour no line holds is a break, and a line's
// missing hour adds nothing while another line holds it. The pane refuses a
// stack of mixed units, negative values or overlapping series before it
// draws, and a refused pane offers no figure, so none of those reach here.
//
// Bands are thinned on their totals at columns every band shares
// (`thinShared`), so one band's top edge is exactly the next one's bottom.

import { circle, polygon, polyline, tint } from './svg';
import { thinShared } from './thin';
import { COLUMNS_PER_PT, TIME_PANE, hoursIn } from './time';
import type { PaneRenderer } from './build';

/** The pane's band fill opacity, laid over the white page. */
const FILL_ALPHA = 0.3;

/** Running totals, bottom band first: NaN where no line holds the hour. */
export function runningTotals(values: readonly ArrayLike<number>[]): Float64Array[] {
  const length = values[0]?.length ?? 0;
  const totals = values.map(() => new Float64Array(length));
  for (let hour = 0; hour < length; hour++) {
    const held = values.some((line) => !Number.isNaN(line[hour]));
    let sum = 0;
    values.forEach((line, i) => {
      if (!Number.isNaN(line[hour])) sum += line[hour];
      totals[i][hour] = held ? sum : NaN;
    });
  }
  return totals;
}

export const STACKED_PANE: PaneRenderer = {
  lead: (what) => `Stacked hourly ${what}`,
  extent: TIME_PANE.extent,
  hoursShown: TIME_PANE.hoursShown,
  xTicks: TIME_PANE.xTicks,

  // Each band spans from the axis to its total: the bottom band is filled
  // down to zero, so zero is always on the scale.
  yExtents(values, window) {
    return runningTotals(values).map((total) => {
      const [low, high] = TIME_PANE.extent(total, window);
      return low > high ? [low, high] : [Math.min(0, low), Math.max(0, high)];
    });
  },

  legendOrder: (count) => Array.from({ length: count }, (_, i) => count - 1 - i),

  marks(lines, window, frame) {
    const [x0, x1] = window;
    const [from, to] = hoursIn(window);
    const columns = Math.max(1, Math.round(frame.width * COLUMNS_PER_PT));
    const totals = runningTotals(lines.map((entry) => entry.values));
    const runs = thinShared(totals, from, to, x0, x1, columns);
    const xOf = (hour: number) => frame.left + ((hour - x0) / (x1 - x0)) * frame.width;
    const fills: string[] = [];
    const strokes: string[] = [];
    lines.forEach((entry, i) => {
      const below = (hour: number) => (i === 0 ? entry.y(0) : entry.y(totals[i - 1][hour]));
      for (const run of runs) {
        const top = run.map((hour) => [xOf(hour), entry.y(totals[i][hour])] as const);
        if (top.length === 1) {
          strokes.push(circle(top[0][0], top[0][1], entry.stroke.width, entry.stroke.color));
          continue;
        }
        const bottom = [...run].reverse().map((hour) => [xOf(hour), below(hour)] as const);
        fills.push(polygon([...top, ...bottom], tint(entry.stroke.color, FILL_ALPHA)));
        strokes.push(polyline(top, entry.stroke));
      }
    });
    // Every fill under every edge, so no band hides the line below it.
    return [...fills, ...strokes];
  },
};
