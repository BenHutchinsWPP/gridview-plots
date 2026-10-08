// src/model/date-range.ts
//
// The dates filter's arithmetic: one run of days of the year, and how the
// rail, a pane's zoom and the overview move it. Pure, so the stepping rules
// are tested without a DOM.
//
// A day is a day of the leap-calendar slot, 0-365, Feb 29 = 59 in every
// year. Day `d` is hours `24d … 24d + 23` in every Case whatever its year: no
// calendar lookup, and the one filter that means the same hours in a 2035 and
// a 2036 Case. In a non-leap year Feb 29 is an ordinary day that keeps no
// hours.

import {
  MONTH_NAMES,
  SLOT_MONTH_LENGTHS,
  SLOT_MONTH_STARTS,
  YEAR_SLOT_DAYS,
  buildCalendar,
  getDayOfWeek,
  isPhantomDay,
} from './calendar';

/** Days `start` to `end`, both kept. */
export interface DateRange {
  readonly start: number;
  readonly end: number;
}

const LAST_DAY = YEAR_SLOT_DAYS - 1;

const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value));

/** The month, 0-11, a day falls in. */
export function monthOfDay(day: number): number {
  let m = 11;
  while (SLOT_MONTH_STARTS[m] > day) m--;
  return m;
}

/** "Feb 20". */
export function dayLabel(day: number): string {
  const m = monthOfDay(day);
  return `${MONTH_NAMES[m]} ${day - SLOT_MONTH_STARTS[m] + 1}`;
}

/** "Feb 20 – Mar 10", or "Feb 20" for one day. */
export function rangeLabel(range: DateRange): string {
  return range.start === range.end
    ? dayLabel(range.start)
    : `${dayLabel(range.start)} – ${dayLabel(range.end)}`;
}

/** The range from `a` to `b` in either order, kept inside the year. */
export function rangeOf(a: number, b: number): DateRange {
  return {
    start: clamp(Math.min(a, b), 0, LAST_DAY),
    end: clamp(Math.max(a, b), 0, LAST_DAY),
  };
}

function sameRange(a: DateRange | null, b: DateRange | null): boolean {
  return a === b || (a !== null && b !== null && a.start === b.start && a.end === b.end);
}

export function rangeDays(range: DateRange): number {
  return range.end - range.start + 1;
}

/** Hour indexes `[from, to)` the range keeps. */
export function rangeHours(range: DateRange): [number, number] {
  return [range.start * 24, (range.end + 1) * 24];
}

/** The days a window of hour indexes `min … max` touches, as a pane's
 * drag-zoom reports it. */
export function rangeOfHours(min: number, max: number): DateRange {
  return rangeOf(Math.floor(Math.ceil(min) / 24), Math.floor(Math.floor(max) / 24));
}

export function monthRange(month: number): DateRange {
  return {
    start: SLOT_MONTH_STARTS[month],
    end: SLOT_MONTH_STARTS[month] + SLOT_MONTH_LENGTHS[month] - 1,
  };
}

/** How many whole months the range is, or 0 when it is not whole months. */
export function wholeMonths(range: DateRange): number {
  const m0 = monthOfDay(range.start);
  const m1 = monthOfDay(range.end);
  return range.start === SLOT_MONTH_STARTS[m0] && range.end === monthRange(m1).end
    ? m1 - m0 + 1
    : 0;
}

/**
 * Move by the window's own length, `dir` = ±1. Whole months step by months,
 * so February steps to March and not 28 days on. The window stops at Jan 1
 * and Dec 31 and never wraps.
 */
export function stepRange(range: DateRange, dir: 1 | -1): DateRange {
  const k = wholeMonths(range);
  if (k > 0) {
    const m0 = clamp(monthOfDay(range.start) + dir * k, 0, 12 - k);
    return { start: SLOT_MONTH_STARTS[m0], end: monthRange(m0 + k - 1).end };
  }
  const len = rangeDays(range);
  const start = clamp(range.start + dir * len, 0, YEAR_SLOT_DAYS - len);
  return { start, end: start + len - 1 };
}

/** Move the end one day, never before the start. */
export function extendRange(range: DateRange, dir: 1 | -1): DateRange {
  return { start: range.start, end: clamp(range.end + dir, range.start, LAST_DAY) };
}

/** The Day, Week and Month window buttons: Day and Week start at `from`,
 * Month is the calendar month containing it. */
export function windowFrom(from: number, length: 'day' | 'week' | 'month'): DateRange {
  if (length === 'month') return monthRange(monthOfDay(from));
  const days = length === 'day' ? 1 : 7;
  const start = clamp(from, 0, YEAR_SLOT_DAYS - days);
  return { start, end: start + days - 1 };
}

/** A typed date, or why it is refused. */
export type ParsedDay = { day: number } | { refusal: string };

/** "Feb 20", "February 20", "2/20" or "2-20". */
export function parseDay(text: string): ParsedDay {
  const t = text.trim();
  const named = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2})$/i.exec(t);
  const numeric = /^(\d{1,2})\s*[/-]\s*(\d{1,2})$/.exec(t);
  let month: number;
  let day: number;
  if (named) {
    month = MONTH_NAMES.findIndex((name) => name.toLowerCase() === named[1].toLowerCase());
    day = Number(named[2]);
  } else if (numeric) {
    month = Number(numeric[1]) - 1;
    day = Number(numeric[2]);
  } else {
    return { refusal: 'A date like “Feb 20” or “2/20”.' };
  }
  if (month < 0 || month > 11 || day < 1 || day > SLOT_MONTH_LENGTHS[month]) {
    return { refusal: `${t} is not a date.` };
  }
  return { day: SLOT_MONTH_STARTS[month] + day - 1 };
}

/** A day's weekday in one year, 0 = Monday .. 6 = Sunday, from the calendar
 * every mask is built on; -1 for Feb 29 of a non-leap year, which is no day
 * at all. A walker over days skips a -1: counted as a weekday, it would cut a
 * spurious week at Mar 1 or shade a phantom day as a Monday. */
export function weekdayOf(year: number, day: number): number {
  const entry = buildCalendar(year)[day * 24];
  return isPhantomDay(entry) ? -1 : getDayOfWeek(entry);
}

// ------------------------------------------------------------ scattered days
//
// The filter is any set of days, held as runs: sorted, never overlapping and
// never touching, so Feb 20–22 plus Feb 23 is one run and labels and steps
// see it as one. One run behaves exactly as a `DateRange`.

/** Runs of days, sorted, apart by at least one day. */
export type DateSet = readonly DateRange[];

/** Sort, clamp and merge runs that overlap or touch; `null` when none is left,
 * because no days would mean no hours, and `null` is every day. */
export function normalize(runs: readonly DateRange[]): DateSet | null {
  const sorted = runs.map((run) => rangeOf(run.start, run.end)).sort((a, b) => a.start - b.start);
  const merged: DateRange[] = [];
  for (const run of sorted) {
    const last = merged[merged.length - 1];
    if (last && run.start <= last.end + 1) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, run.end) };
    } else {
      merged.push(run);
    }
  }
  return merged.length === 0 ? null : merged;
}

export function sameSet(a: DateSet | null, b: DateSet | null): boolean {
  return (
    a === b ||
    (a !== null && b !== null && a.length === b.length && a.every((run, i) => sameRange(run, b[i])))
  );
}

export function hasDay(set: DateSet | null, day: number): boolean {
  return set === null || set.some((run) => day >= run.start && day <= run.end);
}

/** Add `day`, or take it out when picked, which may split its run. With no
 * filter (every day), the day alone. */
export function toggleDay(set: DateSet | null, day: number): DateSet | null {
  if (set === null) return [{ start: day, end: day }];
  const inside = set.find((run) => day >= run.start && day <= run.end);
  if (!inside) return normalize([...set, { start: day, end: day }]);
  const rest = set.filter((run) => run !== inside);
  if (inside.start < day) rest.push({ start: inside.start, end: day - 1 });
  if (inside.end > day) rest.push({ start: day + 1, end: inside.end });
  return normalize(rest);
}

/** The set with `run` added; with no filter, the run alone. */
export function addRun(set: DateSet | null, run: DateRange): DateSet | null {
  return normalize([...(set ?? []), run]);
}

/** The set with run `index` replaced, merged if it now meets another. */
export function replaceRun(set: DateSet, index: number, run: DateRange): DateSet | null {
  return normalize(set.map((was, i) => (i === index ? run : was)));
}

/** The first day to the last. */
export function setBounds(set: DateSet): DateRange {
  return { start: set[0].start, end: set[set.length - 1].end };
}

export function setDays(set: DateSet): number {
  return set.reduce((sum, run) => sum + rangeDays(run), 0);
}

/** Every run moved by `days`, stopping where the first or last would pass the
 * year's ends. */
function shiftSet(set: DateSet, days: number): DateSet {
  const { start, end } = setBounds(set);
  const by = clamp(days, -start, LAST_DAY - end);
  return set.map((run) => ({ start: run.start + by, end: run.end + by }));
}

/** ◀ ▶: one run steps by its own length (`stepRange`); several move together
 * by a week, keeping their shape. */
export function stepSet(set: DateSet, dir: 1 | -1): DateSet {
  return set.length === 1 ? [stepRange(set[0], dir)] : shiftSet(set, dir * 7);
}

/** Alt+← →: everything by one day. */
export function slideSet(set: DateSet, dir: 1 | -1): DateSet {
  return shiftSet(set, dir);
}

/** Shift+← →: the last run's end by one day. */
export function extendSet(set: DateSet, dir: 1 | -1): DateSet {
  return normalize([...set.slice(0, -1), extendRange(set[set.length - 1], dir)]) ?? set;
}

/** "Feb 20 – Feb 22, Jul 14". `most` shortens a long set to its first runs
 * and a count, for a status line; the CSV descriptor names every run. */
export function setLabel(set: DateSet, most = Infinity): string {
  if (set.length <= most) return set.map(rangeLabel).join(', ');
  const rest = set.length - most;
  return `${set.slice(0, most).map(rangeLabel).join(', ')} and ${rest} more run${rest === 1 ? '' : 's'}`;
}
