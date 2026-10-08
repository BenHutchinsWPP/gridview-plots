// src/ui/chart-format.ts
//
// Number and hour text, empty-pane text, and time-axis ticks, shared by every
// surface that prints figures so one screen has one number format. The time
// axis and its labels follow AGENTS.md's "time axis is slot positions" rule.

import type uPlot from 'uplot';
import { isLeapYear, MONTH_NAMES, SLOT_MONTH_STARTS, YEAR_SLOT_HOURS } from '../model/calendar';

/** Month for an hour of the slot, by index arithmetic on the slot's month
 * starts: Feb 29 is hours 1416-1439 in every year, real or not. */
export function monthOf(hour: number): number {
  let month = 11;
  while (month > 0 && SLOT_MONTH_STARTS[month] * 24 > hour) month--;
  return month;
}

/** Day of the month, 1-based, for an hour-of-year. Beside `monthOf` because
 * the two are always asked together and the arithmetic reads as an off-by-one
 * waiting to happen wherever it is spelled again. */
export function dayOfMonth(hour: number): number {
  return Math.floor(hour / 24) - SLOT_MONTH_STARTS[monthOf(hour)] + 1;
}

/** One position on the time axis, read from an axis origin `firstYear`. */
export interface AxisHour {
  readonly year: number;
  /** 0 = Jan, as `MONTH_NAMES` indexes. */
  readonly month: number;
  readonly day: number;
  /** Hour-ending, 1-24. */
  readonly he: number;
  /** Feb 29 of a non-leap year: a slot with no hour behind it. */
  readonly phantom: boolean;
}

/** The date of axis position `x`, `firstYear` being the year at x = 0. */
export function axisHour(x: number, firstYear: number): AxisHour {
  const offset = Math.floor(x / YEAR_SLOT_HOURS);
  const slot = Math.floor(x) - offset * YEAR_SLOT_HOURS;
  const year = firstYear + offset;
  const month = monthOf(slot);
  const day = dayOfMonth(slot);
  const phantom = month === 1 && day === 29 && !isLeapYear(year);
  return { year, month, day, he: (slot % 24) + 1, phantom };
}

/** "Mar 1 · HE 1" for a slot hour; "2027 Mar 1 · HE 1" for an axis position
 * given its origin, and a phantom hour says it is no such day. */
export function hourLabel(hour: number, firstYear?: number): string {
  const at = axisHour(hour, firstYear ?? 0);
  const date = `${MONTH_NAMES[at.month]} ${at.day} · HE ${at.he}`;
  if (firstYear === undefined) return date;
  return `${at.year} ${date}${at.phantom ? ' · no such day' : ''}`;
}

/** The width one time-axis label needs, in the unit `width` is given in.
 * "Feb 25" needs ~64 CSS px on a pane; without this the ticks are spaced by
 * calendar and overprint each other on a narrow plot. */
export const TIME_LABEL_ROOM = 64;

/** Past this window the axis ticks years: "more than ~2 years". */
const YEAR_TICKS_PAST = 2 * YEAR_SLOT_HOURS;

/**
 * Time-axis ticks on calendar boundaries, for an x window in axis hours and a
 * plot `width`. Pure, so a pane and a print figure given the same window
 * tick it the same way: years past 2 years, months past 60 days, days past 2,
 * else hours on a 1/2/3/6/12-hour step. An evenly spaced tick would get the
 * label of whatever month contains it, and the dedupe would then drop a
 * month. With `firstYear` the labels carry the year where it changes (a year
 * tick, the first tick, the first tick in a new year); without, they are the
 * slot's own and no year shows.
 */
export function timeTicks(
  min: number,
  max: number,
  width: number,
  labelRoom = TIME_LABEL_ROOM,
  firstYear?: number,
): { splits: number[]; labels: string[] } {
  const splits = timeSplitsFor(min, max, width, labelRoom);
  return { splits, labels: timeLabelsFor(splits, max - min, firstYear) };
}

function timeSplitsFor(min: number, max: number, width: number, labelRoom: number): number[] {
  const span = max - min;
  const room = Math.max(2, Math.floor(width / labelRoom));
  const firstYear = Math.floor(min / YEAR_SLOT_HOURS);
  const lastYear = Math.floor(max / YEAR_SLOT_HOURS);

  if (span > YEAR_TICKS_PAST) {
    // `|| 0`: a window opening at -0.5 would otherwise tick at -0.
    const from = Math.ceil(min / YEAR_SLOT_HOURS) || 0;
    const step = Math.max(1, Math.ceil((lastYear - from + 1) / room));
    const years: number[] = [];
    for (let year = from; year <= lastYear; year += step) years.push(year * YEAR_SLOT_HOURS);
    return years;
  }

  if (span > 60 * 24) {
    // A year's twelve are never thinned, so one year ticks every month; past
    // that, every second, third or sixth month, Jan always among them.
    const months = Math.ceil(((span / YEAR_SLOT_HOURS) * 12) / Math.max(room, 12));
    const step = [1, 2, 3, 6].find((candidate) => candidate >= months) ?? 12;
    const ticks: number[] = [];
    for (let year = firstYear; year <= lastYear; year++) {
      for (let month = 0; month < 12; month += step) {
        const hour = year * YEAR_SLOT_HOURS + SLOT_MONTH_STARTS[month] * 24;
        if (hour >= min && hour <= max) ticks.push(hour);
      }
    }
    return ticks;
  }

  if (span > 2 * 24) {
    const firstDay = Math.ceil(min / 24);
    const lastDay = Math.floor(max / 24);
    const step = Math.max(1, Math.ceil((lastDay - firstDay + 1) / room));
    const days: number[] = [];
    for (let day = firstDay; day <= lastDay; day += step) days.push(day * 24);
    return days;
  }

  // Every step divides 24, and 24 divides the slot, so an hour tick lands on
  // the same clock hour in every year.
  const hours = Math.max(1, Math.round(span));
  const step = [1, 2, 3, 6, 12].find((candidate) => hours / candidate <= room) ?? 24;
  const ticks: number[] = [];
  for (let hour = Math.ceil(min / step) * step; hour <= max; hour += step) ticks.push(hour);
  return ticks;
}

/** Labels at the resolution a window of `span` hours is showing. */
function timeLabelsFor(splits: number[], span: number, firstYear?: number): string[] {
  let shownYear: number | null = null;
  return splits.map((x) => {
    const at = axisHour(x, firstYear ?? 0);
    const month = MONTH_NAMES[at.month];
    if (span > YEAR_TICKS_PAST) {
      return firstYear === undefined ? month : String(at.year);
    }
    const newYear = firstYear !== undefined && at.year !== shownYear;
    shownYear = at.year;
    if (span > 60 * 24) return newYear ? `${month} ${at.year}` : month;
    const date = `${month} ${at.day}`;
    const label = span > 2 * 24 ? date : `${date} HE ${at.he}`;
    return newYear ? `${at.year} ${label}` : label;
  });
}

/** `timeTicks` as the uPlot axis `splits` and `values` hooks, for an axis
 * whose x = 0 is Jan 1 of `firstYear`. Without one, the labels are the
 * slot's and name no year. */
export function timeAxis(firstYear?: number): {
  splits: (self: uPlot, axis: number, min: number, max: number) => number[];
  values: (self: uPlot, splits: number[]) => string[];
} {
  return {
    splits: (self, _axis, min, max) =>
      timeSplitsFor(min, max, self.bbox.width / (devicePixelRatio || 1), TIME_LABEL_ROOM),
    values: (self, splits) => {
      const scale = self.scales.x;
      return timeLabelsFor(splits, (scale.max ?? YEAR_SLOT_HOURS) - (scale.min ?? 0), firstYear);
    },
  };
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
