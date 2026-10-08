// src/series/interval.ts
//
// The interval chart's arithmetic: one series cut into days, weeks or months,
// each period laid on one shared axis so they can be overlaid. Pure, so the
// cutting is tested without a canvas.
//
// **Periods follow the calendar, never the filter.** A week is Monday to
// Sunday in the Case's own year and a month is its calendar month; the dates
// and other filters only blank hours inside them. So a period the dates cut
// keeps its place on the axis (a partial first week starts mid-axis), and
// narrowing the dates never shifts which hours share an x.
//
// The month axis is 31 days long. A shorter month stops early rather than
// being stretched, which would put its 15th somewhere other than July's.

import { DAY_NAMES, MONTH_NAMES, SLOT_MONTH_STARTS, YEAR_SLOT_DAYS } from '../model/calendar';
import { dayLabel, monthOfDay } from '../model/date-range';

export type IntervalLength = 'day' | 'week' | 'month';

export interface Period {
  /** "Tue Feb 20", "week of Feb 19", "Feb". */
  label: string;
  /** The period's first day of the year, kept or not, for colour by weekday
   * or month. */
  startDay: number;
  /** One value per axis hour, NaN where filtered out, missing or outside the
   * period. */
  values: Float32Array;
}

/** Hours on the axis: a day, a week, or a 31-day month. */
export function axisHours(length: IntervalLength): number {
  return length === 'day' ? 24 : length === 'week' ? 7 * 24 : 31 * 24;
}

/**
 * Cut `values` (one 8,784-hour slot, NaN where not kept) into periods.
 * `weekday` gives a day's weekday in the series' own year, 0 = Monday .. 6 =
 * Sunday, or -1 for a phantom Feb 29, which no period holds. A period with no
 * kept hour is left out.
 */
export function cutPeriods(
  values: ArrayLike<number>,
  length: IntervalLength,
  weekday: (day: number) => number,
): Period[] {
  const span = axisHours(length);
  const periods: Period[] = [];
  const add = (label: string, startDay: number, days: number[], offset: (d: number) => number) => {
    const out = new Float32Array(span).fill(NaN);
    let kept = false;
    for (const d of days) {
      const at = offset(d) * 24;
      for (let h = 0; h < 24; h++) {
        const value = values[d * 24 + h];
        if (Number.isNaN(value)) continue;
        out[at + h] = value;
        kept = true;
      }
    }
    if (kept) periods.push({ label, startDay, values: out });
  };

  if (length === 'day') {
    for (let d = 0; d < YEAR_SLOT_DAYS; d++) {
      if (weekday(d) < 0) continue;
      add(`${DAY_NAMES[weekday(d)]} ${dayLabel(d)}`, d, [d], () => 0);
    }
  } else if (length === 'week') {
    // By each day's own weekday, never by counting days in sevens: a
    // non-leap year's slot holds a phantom Feb 29, so from Mar 1 day numbers
    // and weekdays part by one.
    let days: number[] = [];
    const flush = () => {
      if (days.length > 0) add(`week of ${dayLabel(days[0])}`, days[0], days, weekday);
      days = [];
    };
    for (let d = 0; d < YEAR_SLOT_DAYS; d++) {
      if (weekday(d) < 0) continue;
      if (days.length > 0 && weekday(d) <= weekday(days[days.length - 1])) flush();
      days.push(d);
    }
    flush();
  } else {
    for (let m = 0; m < 12; m++) {
      const start = SLOT_MONTH_STARTS[m];
      const end = m === 11 ? YEAR_SLOT_DAYS : SLOT_MONTH_STARTS[m + 1];
      const days: number[] = [];
      for (let d = start; d < end; d++) if (weekday(d) >= 0) days.push(d);
      add(MONTH_NAMES[m], start, days, (d) => d - start);
    }
  }
  return periods;
}

/** Per axis hour: the mean of the periods with a value there, and their 10th
 * and 90th percentiles (nearest rank). NaN where no period has one. */
export function periodSummary(
  periods: readonly Period[],
  span: number,
): { mean: Float32Array; p10: Float32Array; p90: Float32Array } {
  const mean = new Float32Array(span).fill(NaN);
  const p10 = new Float32Array(span).fill(NaN);
  const p90 = new Float32Array(span).fill(NaN);
  const column = new Float64Array(periods.length);
  for (let k = 0; k < span; k++) {
    let n = 0;
    for (const period of periods) {
      const value = period.values[k];
      if (!Number.isNaN(value)) column[n++] = value;
    }
    if (n === 0) continue;
    const sorted = column.subarray(0, n).sort();
    let sum = 0;
    for (let i = 0; i < n; i++) sum += sorted[i];
    mean[k] = sum / n;
    p10[k] = sorted[Math.floor(0.1 * (n - 1))];
    p90[k] = sorted[Math.ceil(0.9 * (n - 1))];
  }
  return { mean, p10, p90 };
}

/** The month, 0-11, a period starts in. */
export function periodMonth(period: Period): number {
  return monthOfDay(period.startDay);
}

/** An axis hour as a reader names it: "HE 18", "Tue HE 18", "day 12 HE 18". */
export function axisLabel(length: IntervalLength, hour: number): string {
  const he = `HE ${(hour % 24) + 1}`;
  if (length === 'day') return he;
  if (length === 'week') return `${DAY_NAMES[Math.floor(hour / 24)]} ${he}`;
  return `day ${Math.floor(hour / 24) + 1} ${he}`;
}
