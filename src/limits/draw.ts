// src/limits/draw.ts
//
// Twelve monthly limits become the dashed line beside one interface, and the
// hourly divisors of its "% of range" line. A boundary's lines are drawn from
// the hourly limits its kind summed, by the same masking.
//
//   * Expanded to 8,760 hours so the limit inherits the series' hour filter
//     by copying its NaN mask, rather than reimplementing the calendar mask.
//   * A STEP function: a limit is a schedule, so nothing is interpolated
//     between months.
//   * Unit-gated: a Case can hold MW and $ tables on different y scales, so a
//     series in another unit gets no limit rather than a mis-scaled one.

import { buildCalendar, getMonth, HOURS_PER_YEAR } from '../model/calendar';
import type { LimitsStore } from './store';
import type { InterfaceLimit, LimitSide } from './types';
import { sideAt, type RangeLimits, type RangeSide } from '../series/range';

/** The unit a limit is drawn against. The export's MVA ratings are compared
 * directly with MW flows (the data owner's decision), so this must stay 'MW':
 * 'MVA' would match no drawn series and silently remove every limit line. */
export const LIMIT_UNIT = 'MW';

/** One drawn line's limits, structurally the panes' `DrawnLimit`, declared
 * here so this module loads in Node. */
export interface LimitLine {
  name: string;
  color: string;
  unit: string;
  values: Float32Array;
  /** A boundary's members' limits summed: a best case, never one rating. */
  summed?: boolean;
}

/** One drawn series, as much of it as this module reads. */
export interface LimitSubject {
  caseId: string;
  /** The entity on the interface axis -- the name the limits file is joined
   * on, trimmed at the join rather than here. */
  interfaceName: string;
  /** The series' legend label, which the limit's own label extends. */
  label: string;
  color: string;
  unit: string;
  /** The Case's own calendar year: which hours fall in which month is a
   * property of the year the run covers, never of a year shared app-wide. */
  year: number;
  /** The series' own hours. Read ONLY for its NaNs -- see the masking note in
   * this file's header. */
  values: Float32Array | null;
}

/** The limit lines for one series: none, one or both sides. A path with no
 * published limit gets none, silently; `matchReport` counts it per file. */
export function limitLinesFor(store: LimitsStore, subject: LimitSubject): LimitLine[] {
  const limit = store.limitFor(subject.caseId, subject.interfaceName);
  if (limit === undefined) return [];
  const { upper, lower } = rangeLimitsOf(limit, subject.year);
  return linesOf({ max: upper, min: lower }, subject, '');
}

/**
 * A boundary's limit lines, from the hourly limits its kind summed
 * (`src/tables/interface/limits.ts`). The same unit gate, masking and
 * step as a path's; only the names differ, so a sum never reads as one
 * published rating.
 */
export function summedLimitLines(
  limits: RangeLimits,
  subject: Omit<LimitSubject, 'caseId' | 'interfaceName' | 'year'>,
): LimitLine[] {
  return linesOf({ max: limits.upper, min: limits.lower }, subject, 'summed ');
}

function linesOf(
  sides: Readonly<Record<LimitSide, RangeSide | undefined>>,
  subject: Pick<LimitSubject, 'label' | 'color' | 'unit' | 'values'>,
  sidePrefix: string,
): LimitLine[] {
  const series = subject.values;
  if (series === null || subject.unit !== LIMIT_UNIT) return [];
  const lines: LimitLine[] = [];
  for (const side of ['max', 'min'] as const) {
    const hourly = sides[side];
    if (hourly === undefined) continue;
    const values = new Float32Array(HOURS_PER_YEAR);
    let any = false;
    for (let hour = 0; hour < HOURS_PER_YEAR; hour++) {
      // The series' NaN is the filter, this month's NaN is "no limit set".
      // Both come out as NaN, because both mean "draw nothing here" -- the
      // pane does not have to tell them apart and must not try.
      const kept = Number.isNaN(series[hour]) ? NaN : sideAt(hourly, hour);
      values[hour] = kept;
      if (!Number.isNaN(kept)) any = true;
    }
    // A side that is sentinel in every month of the filtered range is not a
    // line; adding it would put an empty entry in the hover readout and an
    // extra scale on the axis.
    if (any)
      lines.push({
        name: `${subject.label} (${sidePrefix}${side})`,
        color: subject.color,
        unit: subject.unit,
        values,
        ...(sidePrefix ? { summed: true } : {}),
      });
  }
  return lines;
}

/**
 * One interface's limits as hourly "% of range" divisors: MAX is the upper
 * side, MIN the lower, each hour taking its own month's value in the Case's
 * calendar year. A month with no limit is NaN, which the normalizer fills
 * with the series' peak for that month's hours alone. No row: no limits.
 */
export function rangeLimitsOf(limit: InterfaceLimit | undefined, year: number): RangeLimits {
  if (limit === undefined) return {};
  const calendar = buildCalendar(year);
  const hourly = (months: Float32Array | undefined): Float32Array | undefined => {
    if (months === undefined) return undefined;
    const values = new Float32Array(HOURS_PER_YEAR);
    for (let hour = 0; hour < HOURS_PER_YEAR; hour++) {
      values[hour] = months[getMonth(calendar[hour]) - 1];
    }
    return values;
  };
  const upper = hourly(limit.max);
  const lower = hourly(limit.min);
  return { ...(upper ? { upper } : {}), ...(lower ? { lower } : {}) };
}
