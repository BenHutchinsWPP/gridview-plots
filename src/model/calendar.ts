// src/model/calendar.ts
//
// The calendar of one year's 8,784-hour slot: one packed Uint32Array built
// once per year and memoized. Every field is index arithmetic, never a Date
// object: `new Date(str)` shifts rows by a day in half the world's timezones.
// Every year is laid out on the leap calendar, so a date is the same index in
// every year; a non-leap year's Feb 29 is a phantom day whose hours are NaN.
//
// Bit layout of one packed entry (LSB first):
//   month      bits  0- 3  (4 bits)  1-12
//   dayOfMonth bits  4- 8  (5 bits)  1-31
//   dayOfWeek  bits  9-11  (3 bits)  0-6, 0 = Monday .. 6 = Sunday
//   hourOfDay  bits 12-16  (5 bits)  1-24 (hour-ending, HE)
//   season     bits 17-18  (2 bits)  0=Winter 1=Spring 2=Summer 3=Fall
//   phantom    bit  31     (1 bit)   Feb 29 of a non-leap year: a slot with
//                                    no real hours and no weekday. Bit 31 is
//                                    the sign bit of a JS int, so read it
//                                    with `>>>`.

import type { Filters, HoursPresent, TouCodes } from './types';

// Every year occupies a fixed leap-calendar slot, so the same date is the
// same index in every year and Cases of different years line up hour for hour.
export const YEAR_SLOT_HOURS = 8784;
export const YEAR_SLOT_DAYS = 366;

/** Slot month lengths: Feb always has its 29th day, real or phantom. */
export const SLOT_MONTH_LENGTHS: readonly number[] = [
  31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
];
/** Day of the slot each month starts on (Jan 0, Feb 31, Mar 60, ...). */
export const SLOT_MONTH_STARTS: readonly number[] = SLOT_MONTH_LENGTHS.map((_, m) =>
  SLOT_MONTH_LENGTHS.slice(0, m).reduce((a, b) => a + b, 0),
);

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Hours a Case actually has. The slot is storage, never a count: every
 * denominator and coverage check uses this, not `YEAR_SLOT_HOURS * numYears`. */
export function realHours(firstYear: number, numYears: number): number {
  let hours = 0;
  for (let y = firstYear; y < firstYear + numYears; y++) hours += isLeapYear(y) ? 8784 : 8760;
  return hours;
}

/** A Case's years: what `realHours` counts. */
export interface YearSpan {
  readonly firstYear: number;
  readonly numYears: number;
}

/** The denominator of one count taken over several Cases' lines: the most
 * real hours any of them has. Cases share the slot hour for hour, so this is
 * what their union can hold: non-leap Cases alone read 8,760, a leap Case
 * makes it 8,784, and no unfiltered non-leap Case reads "8,760 of 8,784".
 * 0 for no span; the caller names its own neutral Case. */
export function mostRealHours(spans: readonly YearSpan[]): number {
  let most = 0;
  for (const span of spans) most = Math.max(most, realHours(span.firstYear, span.numYears));
  return most;
}

const MONTH_SHIFT = 0;
const MONTH_BITS = 4;
const MONTH_MASK = (1 << MONTH_BITS) - 1;

const DAY_SHIFT = MONTH_SHIFT + MONTH_BITS;
const DAY_BITS = 5;
const DAY_MASK = (1 << DAY_BITS) - 1;

const DOW_SHIFT = DAY_SHIFT + DAY_BITS;
const DOW_BITS = 3;
const DOW_MASK = (1 << DOW_BITS) - 1;

const HOUR_SHIFT = DOW_SHIFT + DOW_BITS;
const HOUR_BITS = 5;
const HOUR_MASK = (1 << HOUR_BITS) - 1;

const SEASON_SHIFT = HOUR_SHIFT + HOUR_BITS;
const SEASON_BITS = 2;
const SEASON_MASK = (1 << SEASON_BITS) - 1;

export const PHANTOM_DAY_SHIFT = 31;

export const SEASON_NAMES = ['Winter', 'Spring', 'Summer', 'Fall'] as const;

/** `DAY_NAMES` follows this file's dayOfWeek: 0 = Monday .. 6 = Sunday. */
// Two rows of six, so the twelve read as a calendar.
// prettier-ignore
export const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;
export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/**
 * TOU categories, indexed by the code stored in CaseData.tou. TOU is read
 * from the file and never recomputed; utilities vary the OnPeak window but the
 * file only distinguishes OnPeak/OffPeak.
 */
export const TOU_LABELS = ['OffPeak', 'OnPeak'] as const;

export function getMonth(entry: number): number {
  return (entry >>> MONTH_SHIFT) & MONTH_MASK;
}

export function getDayOfMonth(entry: number): number {
  return (entry >>> DAY_SHIFT) & DAY_MASK;
}

export function getDayOfWeek(entry: number): number {
  return (entry >>> DOW_SHIFT) & DOW_MASK;
}

export function getHourOfDay(entry: number): number {
  return (entry >>> HOUR_SHIFT) & HOUR_MASK;
}

export function getSeason(entry: number): number {
  return (entry >>> SEASON_SHIFT) & SEASON_MASK;
}

export function isPhantomDay(entry: number): boolean {
  return entry >>> PHANTOM_DAY_SHIFT === 1;
}

function seasonOf(month: number): number {
  if (month === 12 || month <= 2) return 0; // Winter: Dec/Jan/Feb
  if (month <= 5) return 1; // Spring: Mar/Apr/May
  if (month <= 8) return 2; // Summer: Jun/Jul/Aug
  return 3; // Fall: Sep/Oct/Nov
}

/**
 * Day of week via Sakamoto's algorithm -- pure integer arithmetic, no Date
 * object anywhere. Returns 0=Monday .. 6=Sunday.
 */
function dayOfWeek(year: number, month: number, day: number): number {
  const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  let y = year;
  if (month < 3) y -= 1;
  const sundayZero =
    (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + t[month - 1] + day) % 7;
  return (sundayZero + 6) % 7; // remap 0=Sunday..6=Saturday -> 0=Monday..6=Sunday
}

const cache = new Map<number, Uint32Array>();

/** Build (or return the memoized) packed calendar for `year`. Year-independent
 * except for day-of-week, so cases with different years (2034/2035/2044)
 * each get their own array, built once. */
export function buildCalendar(year: number): Uint32Array {
  const cached = cache.get(year);
  if (cached) return cached;

  const leap = isLeapYear(year);
  const calendar = new Uint32Array(YEAR_SLOT_HOURS);
  let h = 0;
  for (let month = 1; month <= 12; month++) {
    const season = seasonOf(month);
    const length = SLOT_MONTH_LENGTHS[month - 1];
    for (let day = 1; day <= length; day++) {
      // A phantom Feb 29 has no weekday: its dayOfWeek bits stay 0, and
      // buildMask drops the flagged hour before reading them.
      const phantom = !leap && month === 2 && day === 29;
      const dow = phantom ? 0 : dayOfWeek(year, month, day);
      for (let hourOfDay = 1; hourOfDay <= 24; hourOfDay++) {
        calendar[h++] =
          ((month << MONTH_SHIFT) |
            (day << DAY_SHIFT) |
            (dow << DOW_SHIFT) |
            (hourOfDay << HOUR_SHIFT) |
            (season << SEASON_SHIFT) |
            ((phantom ? 1 : 0) << PHANTOM_DAY_SHIFT)) >>>
          0;
      }
    }
  }
  cache.set(year, calendar);
  return calendar;
}

/** How many of a Case's real hours `seen` flags, year slot by year slot. A
 * phantom hour never counts, so a coverage check against `realHours` reads a
 * non-leap year's Feb 29 as expected-absent, never as a gap. */
export function realHoursSeen(
  seen: ArrayLike<number>,
  firstYear: number,
  numYears: number,
): number {
  let count = 0;
  for (let y = 0; y < numYears; y++) {
    const calendar = buildCalendar(firstYear + y);
    const base = y * YEAR_SLOT_HOURS;
    for (let h = 0; h < YEAR_SLOT_HOURS; h++) {
      if (seen[base + h] && !isPhantomDay(calendar[h])) count++;
    }
  }
  return count;
}

/**
 * Keep-mask over the calendar (1 = keep); `null` in a Filters field means no
 * constraint. Pass `out` to reuse a buffer. Callers pass THIS table's own
 * year and TOU codes, never a shared calendar: two vintages disagree about
 * which hour is a Sunday.
 */
export function buildMask(
  filters: Filters,
  calendar: Uint32Array,
  touBitmap: Uint8Array,
  out?: Uint8Array,
): Uint8Array {
  const mask = out ?? new Uint8Array(calendar.length);
  const { dates, hoursOfDay, daysOfWeek: daysOfWeekFilter, seasons, tou } = filters;
  // Day d of the slot is hours 24d … 24d + 23 in every year, so a day's
  // hours need no calendar lookup.
  let days: Uint8Array | null = null;
  if (dates !== null) {
    days = new Uint8Array(YEAR_SLOT_DAYS);
    for (const run of dates) days.fill(1, run.start, run.end + 1);
  }

  for (let h = 0; h < calendar.length; h++) {
    const entry = calendar[h];
    let keep = 1;
    // A phantom hour is no hour at all, whatever the filters ask for.
    if (isPhantomDay(entry)) keep = 0;
    else if (days !== null && days[Math.floor((h % YEAR_SLOT_HOURS) / 24)] === 0) keep = 0;
    else if (daysOfWeekFilter !== null && !daysOfWeekFilter.has(getDayOfWeek(entry))) keep = 0;
    else if (hoursOfDay !== null && !hoursOfDay.has(getHourOfDay(entry))) keep = 0;
    else if (seasons !== null && !seasons.has(SEASON_NAMES[getSeason(entry)])) keep = 0;
    else if (tou !== null && !tou.has(TOU_LABELS[touBitmap[h]])) keep = 0;
    mask[h] = keep;
  }
  return mask;
}

// Hours per plane of a bundle entry saved before Feb 29 was kept, leap year or not.
const PRE_SLOT_HOURS = 8760;

/** What a saved table entry carries on its hours. */
export interface SavedHours {
  readonly numYears?: unknown;
  readonly tou: TouCodes;
  readonly hoursPresent?: HoursPresent;
}

/**
 * A saved table's hours on the slot. A bundle entry without `numYears` was
 * written before Feb 29 was kept: each plane is 8,760 hours, Feb 29 dropped
 * even in a leap year. Feb 29 is INSERTED inside every plane (cube NaN, TOU
 * 0xff, `hoursPresent` 0), never padded at the end: that would hand Feb 29
 * Mar 1's hours and leave every later hour a day off. `planes` is the kind's
 * (Area: areas × metrics). An entry with `numYears` is returned as it is.
 */
export function savedHoursOnSlot(
  entry: SavedHours,
  cube: Float32Array,
  planes: number,
): { cube: Float32Array; tou: TouCodes; hoursPresent?: HoursPresent } {
  const { tou, hoursPresent } = entry;
  if (entry.numYears !== undefined) return { cube, tou, hoursPresent };
  const sizes: [string, number, number][] = [
    ['cube', cube.length, planes * PRE_SLOT_HOURS],
    ['TOU array', tou.length, PRE_SLOT_HOURS],
    ['hours-present array', hoursPresent?.length ?? PRE_SLOT_HOURS, PRE_SLOT_HOURS],
  ];
  for (const [what, length, expected] of sizes) {
    if (length !== expected) {
      throw new Error(
        `saved ${what} is ${length} values, expected ${expected} ` +
          `(${PRE_SLOT_HOURS} h per plane, saved before Feb 29 was kept)`,
      );
    }
  }
  return {
    cube: insertFeb29(cube, planes, NaN),
    tou: insertFeb29(tou, 1, 0xff),
    hoursPresent: hoursPresent === undefined ? undefined : insertFeb29(hoursPresent, 1, 0),
  };
}

// Feb 29 is day 59 of the slot; the 8,760-hour year has Mar 1 there.
const FEB_29_HOUR = (SLOT_MONTH_STARTS[1] + 28) * 24;

function insertFeb29<T extends Float32Array | Uint8Array>(
  from: T,
  planes: number,
  fill: number,
): T {
  const out = new (from.constructor as new (length: number) => T)(planes * YEAR_SLOT_HOURS);
  for (let plane = 0; plane < planes; plane++) {
    const source = plane * PRE_SLOT_HOURS;
    const target = plane * YEAR_SLOT_HOURS;
    out.set(from.subarray(source, source + FEB_29_HOUR), target);
    out.fill(fill, target + FEB_29_HOUR, target + FEB_29_HOUR + 24);
    out.set(
      from.subarray(source + FEB_29_HOUR, source + PRE_SLOT_HOURS),
      target + FEB_29_HOUR + 24,
    );
  }
  return out;
}
