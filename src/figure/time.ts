// src/figure/time.ts
//
// The time pane as a figure: hour-of-year on x, over the pane's zoom window,
// ticked by the pane's own `timeTicks` so months, `Jan 5` and `HE` read the
// same in the app and the report. Lines are cropped to the window here, not
// by `clipPath`, and thinned to what a 300 dpi column can show.

import { HOURS_PER_YEAR } from '../model/calendar';
import { TIME_LABEL_ROOM, timeTicks } from '../ui/chart-format';
import { circle, polyline } from './svg';
import { thinLine } from './thin';
import type { PaneRenderer } from './build';

/** The pane's label room is CSS pixels at 96 per inch; a figure is in points. */
const LABEL_ROOM_PT = (TIME_LABEL_ROOM * 72) / 96;

/** Output pixels per point at the resolution a figure is exported at. */
export const COLUMNS_PER_PT = 300 / 72;

/** The whole hours inside a window, clamped to the year. */
export function hoursIn(window: readonly [number, number]): [number, number] {
  return [Math.max(0, Math.ceil(window[0])), Math.min(HOURS_PER_YEAR - 1, Math.floor(window[1]))];
}

export const TIME_PANE: PaneRenderer = {
  lead: (what) => `Hourly ${what}`,
  drawsLimits: true,

  extent(values, window) {
    const [from, to] = hoursIn(window);
    let low = Infinity;
    let high = -Infinity;
    for (let hour = from; hour <= to; hour++) {
      const value = values[hour];
      if (Number.isNaN(value)) continue;
      if (value < low) low = value;
      if (value > high) high = value;
    }
    return [low, high];
  },

  hoursShown(lines, window) {
    const [from, to] = hoursIn(window);
    let count = 0;
    for (let hour = from; hour <= to; hour++) {
      if (lines.some((values) => !Number.isNaN(values[hour]))) count++;
    }
    return count;
  },

  xTicks(window, plotWidth) {
    const [x0, x1] = window;
    const { splits, labels } = timeTicks(x0, x1, plotWidth, LABEL_ROOM_PT);
    return splits.map((hour, i) => ({ at: (hour - x0) / (x1 - x0), label: labels[i] }));
  },

  marks(lines, window, frame) {
    const [x0, x1] = window;
    const [from, to] = hoursIn(window);
    const columns = Math.max(1, Math.round(frame.width * COLUMNS_PER_PT));
    const xOf = (hour: number) => frame.left + ((hour - x0) / (x1 - x0)) * frame.width;
    const out: string[] = [];
    for (const entry of lines) {
      for (const run of thinLine(entry.values, from, to, x0, x1, columns)) {
        const points = run.map(([hour, value]) => [xOf(hour), entry.y(value)] as const);
        // A lone hour between gaps has nothing to stroke: a dot, as the pane
        // draws a point marker there.
        if (points.length === 1) {
          out.push(circle(points[0][0], points[0][1], entry.stroke.width, entry.stroke.color));
        } else {
          out.push(polyline(points, entry.stroke));
        }
      }
    }
    return out;
  },
};
