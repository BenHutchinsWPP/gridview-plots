// src/figure/time.ts
//
// The time pane as a figure: slot positions on x from the pane's axis origin
// (AGENTS.md, "the time axis is slot positions"), over the pane's zoom window,
// ticked by the pane's own `timeTicks` so years, months, `Jan 5` and `HE`
// read the same in the app and the report. Lines are cropped to the window
// here, not by `clipPath`, and thinned to what a 300 dpi column can show.
//
// Under "overlay years" the axis is one year slot with no year, each line one
// year of a series in its shade (`FigureLine.overlay`). The caption names the
// years overlaid, and the hours footnote counts each year's hours shown out
// of the real hours of the years drawn, as the span axis would lay them side
// by side.

import { TIME_LABEL_ROOM, timeTicks } from '../ui/chart-format';
import { circle, polyline } from './svg';
import { thinLine } from './thin';
import { listOf } from './naming';
import type { FigureCapture, PaneRenderer } from './build';

/** The pane's label room is CSS pixels at 96 per inch; a figure is in points. */
const LABEL_ROOM_PT = (TIME_LABEL_ROOM * 72) / 96;

/** Output pixels per point at the resolution a figure is exported at. */
export const COLUMNS_PER_PT = 300 / 72;

/** The whole hours inside a window, clamped to values `length` long. */
export function hoursIn(window: readonly [number, number], length: number): [number, number] {
  return [Math.max(0, Math.ceil(window[0])), Math.min(length - 1, Math.floor(window[1]))];
}

/** The hours in the window at which any of `lines` has a value. */
function hoursHeld(lines: readonly ArrayLike<number>[], window: readonly [number, number]): number {
  const [from, to] = hoursIn(window, Math.max(0, ...lines.map((values) => values.length)));
  let count = 0;
  for (let hour = from; hour <= to; hour++) {
    if (lines.some((values) => hour < values.length && !Number.isNaN(values[hour]))) count++;
  }
  return count;
}

/** `years 2035–2037 overlaid`, `years 2035 and 2037 overlaid`, or a lone
 * kept year as itself. */
function overlaidYears(years: readonly number[]): string | null {
  const sorted = [...new Set(years)].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return `${sorted[0]}`;
  const run = sorted[sorted.length - 1] - sorted[0] === sorted.length - 1;
  return `years ${run ? `${sorted[0]}–${sorted[sorted.length - 1]}` : listOf(sorted.map(String))} overlaid`;
}

export function timePane(capture: FigureCapture): PaneRenderer {
  // The drawn lines, in the order `hoursShown` is handed their values.
  const drawn = capture.lines.filter((entry) => entry.values !== null && !entry.dashed);
  const overlay = drawn.some((entry) => entry.overlay);
  return {
    lead: (what) => `Hourly ${what}`,
    drawsLimits: true,
    ...(overlay
      ? {
          years: overlaidYears(
            drawn.flatMap((entry) =>
              entry.overlay?.year === undefined ? [] : [entry.overlay.year],
            ),
          ),
        }
      : {}),

    extent(values, window) {
      const [from, to] = hoursIn(window, values.length);
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
      if (!overlay) return hoursHeld(lines, window);
      // Each year's hours apart, as the span axis lays the years side by side.
      const byYear = new Map<number | undefined, ArrayLike<number>[]>();
      lines.forEach((values, i) => {
        const year = drawn[i]?.overlay?.year;
        byYear.set(year, [...(byYear.get(year) ?? []), values]);
      });
      let count = 0;
      for (const held of byYear.values()) count += hoursHeld(held, window);
      return count;
    },

    xTicks(window, plotWidth) {
      const [x0, x1] = window;
      const { splits, labels } = timeTicks(x0, x1, plotWidth, LABEL_ROOM_PT, capture.firstYear);
      return splits.map((hour, i) => ({ at: (hour - x0) / (x1 - x0), label: labels[i] }));
    },

    marks(lines, window, frame) {
      const [x0, x1] = window;
      const columns = Math.max(1, Math.round(frame.width * COLUMNS_PER_PT));
      const xOf = (hour: number) => frame.left + ((hour - x0) / (x1 - x0)) * frame.width;
      const out: string[] = [];
      for (const entry of lines) {
        const [from, to] = hoursIn(window, entry.values.length);
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
}
