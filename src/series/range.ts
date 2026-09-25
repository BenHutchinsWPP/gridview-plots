// src/series/range.ts
//
// "% of range": one hourly series divided by its range, the one copy of that
// arithmetic. A kind supplies only its limits, as numbers; this module
// imports no kind.
//
//   * **A value ≥ 0 divides by the upper side; a negative one by the lower
//     side, and only when that side is < 0.** A thermal unit's 60 MW minimum
//     is a floor, not a negative range, so its −2 MW auxiliary hour divides
//     by the maximum.
//   * **A missing side is the series' own peak or trough over EVERY hour it
//     has**, never the filtered ones: the hour filter chooses which hours are
//     shown, and a divisor that moved with it would rescale the line. The
//     LABEL is the other way round: it names the divisors the shown hours
//     used, so a month filter never reads "else peak" for a peak it hid.
//   * A limit may vary by hour (an interface's monthly limit), with NaN for
//     "no limit this hour"; the fallback then applies to that hour alone.

import { HOURS_PER_YEAR } from '../model/calendar';

/** A side's divisor: one number for the year, or one per hour. NaN means no
 * limit (that hour, or at all). */
export type RangeSide = number | ArrayLike<number>;

export interface RangeLimits {
  /** Must be > 0 to count as a limit. */
  readonly upper?: RangeSide;
  /** A limit only when < 0; a value ≥ 0 sends negatives to `upper`. */
  readonly lower?: RangeSide;
}

/** Which divisor a side used over the hours it divided. `null`: the side
 * divided no hour (a series with no negative values has no lower side). */
export type RangeSource = 'limit' | 'peak' | 'mixed' | null;

export interface RangeUse {
  readonly upper: RangeSource;
  readonly lower: RangeSource;
}

/** The drawn line's scale: a divisor of the range reads as 100. */
export const PERCENT = 100;

/** One side's divisor at `hour`; NaN for none. */
export function sideAt(side: RangeSide | undefined, hour: number): number {
  if (side === undefined) return NaN;
  return typeof side === 'number' ? side : side[hour];
}

function merge(source: RangeSource, used: 'limit' | 'peak'): RangeSource {
  return source === null || source === used ? used : 'mixed';
}

/**
 * Divide `series` in place by its range, times `scale` (1 for a ratio,
 * `PERCENT` for a drawn line). NaN hours stay NaN. Returns which divisor
 * each side used over the `shown` hours (mask 1; every hour when omitted),
 * which is what the label names.
 */
export function normalizeToRange(
  series: Float32Array,
  limits: RangeLimits = {},
  scale = 1,
  shown?: ArrayLike<number>,
): RangeUse {
  const hours = Math.min(series.length, HOURS_PER_YEAR);
  let peak = 0;
  let trough = 0;
  for (let hour = 0; hour < hours; hour++) {
    const value = series[hour];
    if (value > peak) peak = value;
    if (value < trough) trough = value;
  }

  let upperUse: RangeSource = null;
  let lowerUse: RangeSource = null;
  for (let hour = 0; hour < hours; hour++) {
    const value = series[hour];
    if (Number.isNaN(value)) continue;
    const counted = shown === undefined || shown[hour] === 1;
    const upperLimit = sideAt(limits.upper, hour);
    const upperIsLimit = upperLimit > 0;
    const upper = upperIsLimit ? upperLimit : peak;

    if (value < 0) {
      const lowerLimit = sideAt(limits.lower, hour);
      // A lower limit ≥ 0 is a floor: the negative hour belongs to the upper
      // side. With none stated, the trough is < 0 because this value is.
      const lowerIsLimit = !Number.isNaN(lowerLimit);
      if (lowerIsLimit && lowerLimit < 0) {
        series[hour] = -Math.abs(value / lowerLimit) * scale;
        if (counted) lowerUse = merge(lowerUse, 'limit');
        continue;
      }
      if (!lowerIsLimit || upper <= 0) {
        series[hour] = -Math.abs(value / trough) * scale;
        if (counted) lowerUse = merge(lowerUse, 'peak');
        continue;
      }
    }
    // A value ≥ 0 with no positive divisor is 0 (the peak is 0).
    series[hour] = upper > 0 ? (value / upper) * scale : 0;
    if (counted) upperUse = merge(upperUse, upperIsLimit ? 'limit' : 'peak');
  }
  return { upper: upperUse, lower: lowerUse };
}

function sideWord(source: RangeSource, limit: string): string {
  if (source === 'mixed') return `${limit}, else peak`;
  return source === 'limit' ? limit : 'peak';
}

/** `% of limit`, `% of peak`, or each side named when they differ. `limit`
 * names a divisor that is not one published limit (`summed limits`). */
export function rangeLabel(use: RangeUse, limit = 'limit'): string {
  const upper = use.upper ?? use.lower;
  const lower = use.lower ?? use.upper;
  if (upper === lower) return `% of ${sideWord(upper, limit)}`;
  return `% of ${sideWord(upper, limit)} (+) / ${sideWord(lower, limit)} (−)`;
}

/** `normalizeToRange` on a copy, for a browse tab ranking a cube plane or a
 * bucket it must not overwrite. Returns `out`. */
export function normalizedCopy(
  series: Float32Array,
  limits: RangeLimits,
  out: Float32Array,
): Float32Array {
  out.set(series.subarray(0, HOURS_PER_YEAR));
  normalizeToRange(out, limits);
  return out;
}

/** The label before a line is resolved, or when it was refused. */
export const RANGE_LABEL = '% of range';
