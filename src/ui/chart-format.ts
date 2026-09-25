// src/ui/chart-format.ts
//
// Number and hour-of-year text, empty-pane text, and time-axis ticks, shared
// by every surface that prints figures so one screen has one number format.
// The axis is a (month, day, hour) index, never a date: different case years
// must overlay cleanly, so no `Date` may touch this file.

import type uPlot from 'uplot';
import { HOURS_PER_YEAR, MONTH_NAMES } from '../model/calendar';

/** Month boundaries in hour-of-year, for the time series x axis. The axis is
 * a (month, day, hour) index and never a date: different case years must
 * overlay cleanly, and no Date object may touch this. */
const MONTH_STARTS = (() => {
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const starts: number[] = [];
  let hour = 0;
  for (const days of lengths) {
    starts.push(hour);
    hour += days * 24;
  }
  return starts;
})();
/** Month for an hour-of-year, by index arithmetic on MONTH_STARTS. */
export function monthOf(hour: number): number {
  let month = 11;
  while (month > 0 && MONTH_STARTS[month] > hour) month--;
  return month;
}

/** Day of the month, 1-based, for an hour-of-year. Beside `monthOf` because
 * the two are always asked together and the arithmetic reads as an off-by-one
 * waiting to happen wherever it is spelled again. */
export function dayOfMonth(hour: number): number {
  return Math.floor((hour - MONTH_STARTS[monthOf(hour)]) / 24) + 1;
}

export function hourLabel(hour: number): string {
  return `${MONTH_NAMES[monthOf(hour)]} ${dayOfMonth(hour)} · HE ${(hour % 24) + 1}`;
}

/** The width one time-axis label needs, in the unit `width` is given in.
 * "Feb 25" needs ~64 CSS px on a pane; without this the ticks are spaced by
 * calendar and overprint each other on a narrow plot. */
export const TIME_LABEL_ROOM = 64;

/**
 * Time-axis ticks on calendar boundaries, for an x window in hour-of-year and
 * a plot `width`. Pure, so a pane and a print figure given the same window
 * tick it the same way: months past 60 days, days past 2, else hours on a
 * 1/2/3/6/12-hour step. An evenly spaced tick would get the label of whatever
 * month contains it, and the dedupe would then drop a month.
 */
export function timeTicks(
  min: number,
  max: number,
  width: number,
  labelRoom = TIME_LABEL_ROOM,
): { splits: number[]; labels: string[] } {
  const splits = timeSplitsFor(min, max, width, labelRoom);
  return { splits, labels: timeLabelsFor(splits, max - min) };
}

function timeSplitsFor(min: number, max: number, width: number, labelRoom: number): number[] {
  const span = max - min;
  const inWindow = (hours: number[]) => hours.filter((hour) => hour >= min && hour <= max);
  const room = Math.max(2, Math.floor(width / labelRoom));

  if (span > 60 * 24) return inWindow(MONTH_STARTS);

  if (span > 2 * 24) {
    const firstDay = Math.ceil(min / 24);
    const lastDay = Math.floor(max / 24);
    const step = Math.max(1, Math.ceil((lastDay - firstDay + 1) / room));
    const days: number[] = [];
    for (let day = firstDay; day <= lastDay; day += step) days.push(day * 24);
    return days;
  }

  const hours = Math.max(1, Math.round(span));
  const step = [1, 2, 3, 6, 12].find((candidate) => hours / candidate <= room) ?? 24;
  const ticks: number[] = [];
  for (let hour = Math.ceil(min / step) * step; hour <= max; hour += step) ticks.push(hour);
  return ticks;
}

/** Labels at the resolution a window of `span` hours is showing. */
function timeLabelsFor(splits: number[], span: number): string[] {
  return splits.map((hour) => {
    const month = monthOf(hour);
    const day = dayOfMonth(hour);
    if (span > 60 * 24) return MONTH_NAMES[month];
    if (span > 2 * 24) return `${MONTH_NAMES[month]} ${day}`;
    return `${MONTH_NAMES[month]} ${day} HE ${(hour % 24) + 1}`;
  });
}

/** `timeTicks`' splits as a uPlot axis `splits` hook. */
export function timeSplits(self: uPlot, _axis: number, min: number, max: number): number[] {
  return timeSplitsFor(min, max, self.bbox.width / (devicePixelRatio || 1), TIME_LABEL_ROOM);
}

/** `timeTicks`' labels as a uPlot axis `values` hook. */
export function timeAxisValues(self: uPlot, splits: number[]): string[] {
  const scale = self.scales.x;
  return timeLabelsFor(splits, (scale.max ?? HOURS_PER_YEAR) - (scale.min ?? 0));
}

/** Trim a label to a pixel width, with an ellipsis. Canvas has no text
 * overflow of its own. */
export function clip(context: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (context.measureText(text).width <= maxWidth) return text;
  let cut = text.length;
  while (cut > 1 && context.measureText(`${text.slice(0, cut)}…`).width > maxWidth) cut--;
  return `${text.slice(0, cut)}…`;
}

/** Whole from 1 up (MW and $ fractions are noise); below 1 the precision
 * stays, where per-unit and ratio values live. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  // en-US, like `displayCell`: the drawer and a stats table sit side by side.
  if (Math.abs(value) >= 1) return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return value.toPrecision(3);
}

/** A refusal if there is one; else "drop a file" with no Cases, or "pin a
 * row" with some (a user who just restored a study has already dropped). */
export function emptyPaneText(input: {
  refusal?: string;
  series: readonly { refusal?: string }[];
  hasCases: boolean;
}): string {
  return (
    input.refusal ??
    input.series[0]?.refusal ??
    (input.hasCases
      ? 'Nothing is pinned. Tick a row in the Browse drawer to draw it.'
      : 'Drop a CSV export to begin.')
  );
}
