// src/app/boxes.ts
//
// How a drawn series becomes the box-plot pane's groups.
//
// The whole of it is a partition of values the render path has already built,
// so nothing here reads a cube, a case or a table. It takes the series, the
// dimension to cut them by, a way to ask which calendar year a case was
// exported for, and one scratch buffer.

import {
  buildCalendar,
  DAY_NAMES,
  getDayOfWeek,
  getHourOfDay,
  getMonth,
  getSeason,
  HOURS_PER_YEAR,
  MONTH_NAMES,
  SEASON_NAMES,
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
 * 'case' and 'area' are absent on purpose: they partition by something that
 * is not in the calendar, and `computeBoxes` handles each before it gets here.
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
 * A NON-LEAP year, and that is the whole reason a constant exists for it rather
 * than a literal at the call site: every cube is exactly 8,760 hours because
 * Feb 29 is dropped at ingest, so a leap calendar here would map the back half
 * of the year one day out and put June's hours in a May box.
 */
export const NO_YEAR = 2024;

/**
 * Boxes partition a series rather than duplicating it, so K boxes cost
 * sum(n_i log n_i) <= N log N -- strictly less than the duration curve's
 * single sort of the same points. No dimension needs a precompute.
 *
 * `scratch` is one reused 8,760-value buffer, not one per box: a box is
 * consumed into `quantiles` before the next is gathered. Allocating inside
 * this loop is how a cheap interaction gets multiplied for no reason.
 */
export function computeBoxes(
  series: readonly CaseSeries[],
  dim: BoxDim,
  yearOf: (caseId: string) => number,
  scratch: Float32Array,
): BoxGroup[] {
  const drawable = series.filter((entry) => entry.values !== null);
  if (drawable.length === 0) return [];

  const partition = BOX_DIMS[dim];
  if (!partition) {
    return drawable.map((entry) => ({
      label: entry.name,
      boxes: [
        { color: entry.color, name: entry.name, unit: entry.unit, quantiles: entry.quantiles },
      ],
    }));
  }

  // One calendar per year, built on first use: two cases of the same study
  // year share theirs, and a study spanning two years gets both rather than
  // one of them applied to the other's hours.
  const calendars = new Map<number, Uint32Array>();
  const groups: BoxGroup[] = [];
  for (const category of partition.keys) {
    const boxes: { color: string; name: string; unit: string; quantiles: Quantiles }[] = [];
    for (const entry of drawable) {
      if (!entry.values) continue;
      const year = entry.spec?.caseId ? yearOf(entry.spec.caseId) : NO_YEAR;
      let calendar = calendars.get(year);
      if (!calendar) {
        calendar = buildCalendar(year);
        calendars.set(year, calendar);
      }
      let n = 0;
      for (let hour = 0; hour < HOURS_PER_YEAR; hour++) {
        const value = entry.values[hour];
        if (Number.isNaN(value)) continue;
        if (partition.of(calendar[hour]) !== category.key) continue;
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
