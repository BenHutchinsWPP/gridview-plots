// src/app/boxes.ts
//
// How a drawn series becomes the box-plot pane's groups.
//
// The whole of it is a partition of values the render path has already built,
// so nothing here reads a cube, a case or a table. It takes the series, the
// dimension to cut them by, a way to ask which years a case spans, and one
// scratch buffer.

import {
  buildCalendar,
  DAY_NAMES,
  getDayOfWeek,
  getHourOfDay,
  getMonth,
  getSeason,
  MONTH_NAMES,
  SEASON_NAMES,
  YEAR_SLOT_HOURS,
  type YearSpan,
} from '../model/calendar';
import { quantiles, type Quantiles } from '../tables/area/kernels';
import type { BoxDim } from '../tables/area/types';
import type { BoxGroup, CaseSeries } from '../ui/charts';

/**
 * The calendar dimensions a box plot can partition by: the category list to
 * draw, and the accessor that puts an hour in one of them. Kept as one table
 * rather than two switches -- the label list and the accessor have to agree
 * about what "key" means (1-based for month and hour-ending, 0-based for day
 * and season), and two switches are two places for that to drift.
 *
 * 'case', 'area' and 'year' are absent on purpose: they partition by
 * something that is not in a calendar entry, and `computeBoxes` handles each
 * itself.
 */
const BOX_DIMS: Partial<
  Record<BoxDim, { keys: { key: number; label: string }[]; of: (entry: number) => number }>
> = {
  month: { keys: MONTH_NAMES.map((label, i) => ({ key: i + 1, label })), of: getMonth },
  hourOfDay: {
    keys: Array.from({ length: 24 }, (_, i) => ({ key: i + 1, label: String(i + 1) })),
    of: getHourOfDay,
  },
  dayOfWeek: { keys: DAY_NAMES.map((label, i) => ({ key: i, label })), of: getDayOfWeek },
  season: { keys: SEASON_NAMES.map((label, i) => ({ key: i, label })), of: getSeason },
};

/**
 * The year a series is partitioned by when nothing states one -- a series with
 * no `caseId`, or a case none of whose tables carries a year.
 *
 * Not any year will do: it decides whether the slot's Feb 29 is a real day.
 * 2029 is not a leap year, so its Feb 29 is phantom and holds no hours, and
 * its Jan 1 is a Monday as in 2024, so weekdays match 2024's through Feb 28.
 * Beyond that it only picks the weekdays, which such a series has none of in
 * truth, so it is one constant for every caller to share: the box plot and
 * the interval pane would otherwise disagree about a Monday. Changing it
 * moves the weekday of every series with no stated year.
 */
export const NO_YEAR = 2029;

/**
 * Boxes partition a series rather than duplicating it, so K boxes cost
 * sum(n_i log n_i) <= N log N -- strictly less than the duration curve's
 * single sort of the same points. No dimension needs a precompute.
 *
 * `scratchOf(hours)` hands back one reused buffer of at least that many
 * values, not one per box: a box is consumed into `quantiles` before the next
 * is gathered. Allocating inside this loop is how a cheap interaction gets
 * multiplied for no reason. It is asked once, for the longest drawn line, so
 * a multi-year line never gathers past its end.
 */
export function computeBoxes(
  series: readonly CaseSeries[],
  dim: BoxDim,
  spanOf: (caseId: string) => YearSpan,
  scratchOf: (hours: number) => Float32Array,
): BoxGroup[] {
  const drawable = series.filter((entry) => entry.values !== null);
  if (drawable.length === 0) return [];

  const partition = BOX_DIMS[dim];
  if (dim !== 'year' && !partition) {
    return drawable.map((entry) => ({
      label: entry.name,
      boxes: [
        { color: entry.color, name: entry.name, unit: entry.unit, quantiles: entry.quantiles },
      ],
    }));
  }

  // One calendar per span, built on first use: two cases of the same years
  // share theirs, and cases of other years each get their own rather than one
  // applied to the other's hours. A line is walked over its whole span, so a
  // calendar dimension pools every year it holds.
  const calendars = new Map<string, Uint32Array>();
  const spanOfLine = (entry: CaseSeries): YearSpan =>
    entry.spec?.caseId ? spanOf(entry.spec.caseId) : { firstYear: NO_YEAR, numYears: 1 };
  const calendarOf = ({ firstYear, numYears }: YearSpan): Uint32Array => {
    const key = `${firstYear}:${numYears}`;
    let calendar = calendars.get(key);
    if (!calendar) {
      calendar = buildCalendar(firstYear, numYears);
      calendars.set(key, calendar);
    }
    return calendar;
  };

  let longest = 0;
  for (const entry of drawable) longest = Math.max(longest, entry.values?.length ?? 0);
  const scratch = scratchOf(longest);

  // By year, a category is one year and a line's hours are its slot for that
  // year. A line with no stated year has no box here rather than one under
  // `NO_YEAR`, which must never print.
  const statedSpan = (entry: CaseSeries): YearSpan | null => {
    const span = spanOfLine(entry);
    return span.firstYear === NO_YEAR ? null : span;
  };
  const categories: { key: number; label: string }[] = [];
  if (dim === 'year') {
    const years = new Set<number>();
    for (const entry of drawable) {
      const span = statedSpan(entry);
      if (!span) continue;
      const { firstYear, numYears } = span;
      for (let year = firstYear; year < firstYear + numYears; year++) years.add(year);
    }
    for (const year of [...years].sort((a, b) => a - b)) {
      categories.push({ key: year, label: String(year) });
    }
  } else if (partition) categories.push(...partition.keys);

  const groups: BoxGroup[] = [];
  for (const category of categories) {
    const boxes: { color: string; name: string; unit: string; quantiles: Quantiles }[] = [];
    for (const entry of drawable) {
      const values = entry.values;
      if (!values) continue;
      let from = 0;
      let to = values.length;
      let calendar: Uint32Array | null = null;
      if (dim === 'year') {
        const span = statedSpan(entry);
        if (!span) continue;
        const offset = category.key - span.firstYear;
        if (offset < 0 || offset >= span.numYears) continue;
        from = offset * YEAR_SLOT_HOURS;
        to = Math.min(values.length, from + YEAR_SLOT_HOURS);
      } else {
        calendar = calendarOf(spanOfLine(entry));
        to = Math.min(values.length, calendar.length);
      }
      let n = 0;
      for (let hour = from; hour < to; hour++) {
        const value = values[hour];
        if (Number.isNaN(value)) continue;
        if (calendar && partition && partition.of(calendar[hour]) !== category.key) continue;
        scratch[n++] = value;
      }
      if (n > 0) {
        boxes.push({
          color: entry.color,
          name: entry.name,
          unit: entry.unit,
          quantiles: quantiles(scratch, n),
        });
      }
    }
    groups.push({ label: category.label, boxes });
  }
  return groups;
}
