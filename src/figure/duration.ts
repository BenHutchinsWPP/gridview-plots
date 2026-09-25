// src/figure/duration.ts
//
// The duration pane as a figure: each line's kept hours sorted ascending and
// spread over 0-100 % of interval, as the pane draws them, so Cases with
// different kept-hour counts overlay. The x axis reads as the pane's does
// (`% of interval`, whole-percent ticks) over the pane's zoom window.
//
// The sort is monotonic, so thinning a curve keeps its shape exactly: each
// output column's lowest and highest point are its first and last.

import { HOURS_PER_YEAR } from '../model/calendar';
import { circle, polyline } from './svg';
import { thinLine } from './thin';
import { COLUMNS_PER_PT } from './time';
import type { PaneRenderer } from './build';

/** The pane's x-axis title. */
export const DURATION_X_TITLE = '% of interval';

/** Room a tick label takes, in points: a label per this much width at most. */
const TICK_ROOM_PT = 40;

const sortedCache = new WeakMap<object, Float64Array>();

/** A line's kept values, ascending. A single kept hour is a flat curve, as
 * the pane draws it. */
function sortedOf(values: ArrayLike<number>): Float64Array {
  const held = sortedCache.get(values);
  if (held) return held;
  const kept: number[] = [];
  for (let hour = 0; hour < values.length; hour++) {
    if (!Number.isNaN(values[hour])) kept.push(values[hour]);
  }
  kept.sort((a, b) => a - b);
  const sorted = Float64Array.from(kept.length === 1 ? [kept[0], kept[0]] : kept);
  sortedCache.set(values, sorted);
  return sorted;
}

/** The sorted positions inside a window in % of interval, as fractional
 * indexes and the whole ones between them; `[0, -1]` for an empty line. */
function positions(
  sorted: Float64Array,
  window: readonly [number, number],
): { x0: number; x1: number; from: number; to: number } {
  const last = sorted.length - 1;
  const x0 = (window[0] / 100) * last;
  const x1 = (window[1] / 100) * last;
  let from = Math.max(0, Math.ceil(x0));
  let to = Math.min(last, Math.floor(x1));
  // A window narrower than one step still shows the step it falls in.
  if (last >= 0 && from > to) from = to = Math.min(last, Math.max(0, Math.round(x0)));
  return { x0, x1, from, to };
}

export const DURATION_PANE: PaneRenderer = {
  lead: (what) => `Duration curve of ${what}`,
  xTitle: DURATION_X_TITLE,

  extent(values, window) {
    const sorted = sortedOf(values);
    if (sorted.length === 0) return [Infinity, -Infinity];
    const { from, to } = positions(sorted, window);
    return [sorted[from], sorted[to]];
  },

  // A duration curve reorders hours, so a zoom narrows the ranks shown, not
  // which hours are in them: every kept hour is part of the curve.
  hoursShown(lines) {
    let count = 0;
    for (let hour = 0; hour < HOURS_PER_YEAR; hour++) {
      if (lines.some((values) => !Number.isNaN(values[hour]))) count++;
    }
    return count;
  },

  xTicks(window, plotWidth) {
    const [p0, p1] = window;
    const span = p1 - p0;
    if (!(span > 0)) return [];
    const most = Math.max(2, Math.floor(plotWidth / TICK_ROOM_PT));
    const step = [1, 2, 5, 10, 20, 25, 50, 100].find((s) => span / s <= most) ?? 100;
    const ticks: { at: number; label: string }[] = [];
    for (let at = Math.ceil(p0 / step) * step; at <= p1 + 1e-9; at += step) {
      ticks.push({ at: (at - p0) / span, label: `${Math.round(at)}%` });
    }
    return ticks;
  },

  marks(lines, window, frame) {
    const [p0, p1] = window;
    const columns = Math.max(1, Math.round(frame.width * COLUMNS_PER_PT));
    const out: string[] = [];
    for (const entry of lines) {
      const sorted = sortedOf(entry.values);
      if (sorted.length === 0) continue;
      const last = sorted.length - 1;
      const { x0, x1, from, to } = positions(sorted, window);
      const xOf = (index: number) =>
        frame.left + (((index / last) * 100 - p0) / (p1 - p0)) * frame.width;
      for (const run of thinLine(sorted, from, to, x0, x1, columns)) {
        const points = run.map(([index, value]) => [xOf(index), entry.y(value)] as const);
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
