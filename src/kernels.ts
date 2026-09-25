// src/kernels.ts
//
// The arithmetic that is the same for every table kind: scratch buffers, the
// mask gather, the one sort call site, quantiles, stats, the all-zero test,
// and the ranked pass the browse table sorts on. Each kind's `kernels.ts`
// re-exports the draw-path ones and keeps only what differs (Area's
// weighting, for example).
//
//   1. **f32 is storage, f64 is arithmetic.** Values are read from a
//      Float32Array and accumulated in plain JS numbers.
//   2. **NaN never reaches a kernel.** `applyMask` drops it on the way through.

import { HOURS_PER_YEAR } from './model/calendar';

/** One 8,760-point buffer, allocated once per drawn line and reused. Never
 * allocate one inside a render path. */
export function createScratch(): Float32Array {
  return new Float32Array(HOURS_PER_YEAR);
}

/** Gather the hours the mask keeps into `out`, dropping NaN. Returns the
 * count written. */
export function applyMask(series: Float32Array, mask: Uint8Array, out: Float32Array): number {
  let n = 0;
  for (let hour = 0; hour < HOURS_PER_YEAR; hour++) {
    if (mask[hour] === 0) continue;
    const value = series[hour];
    if (Number.isNaN(value)) continue;
    out[n++] = value;
  }
  return n;
}

/**
 * The single sort call site in the app, and the only real cost in an
 * interaction. Sorts `buffer[0, n)` ascending, in place. A radix sort is the
 * rejected alternative: the builtin measured fast enough for the worst case
 * (the ten-case duration curve). Keeping every sort here makes swapping it a
 * one-function change if a browser measurement ever says otherwise.
 */
export function sortAsc(buffer: Float32Array, n: number): Float32Array {
  const view = buffer.subarray(0, n);
  view.sort();
  return view;
}

/**
 * p25 and p75 by SELECTION, in linear time. The browse table ranks every
 * scoped row of every Case, and a full sort per row just to read two order
 * statistics dominated ranking. The draw path keeps `quantiles`, which needs
 * the order itself. Reorders `buffer[0, n)` in place.
 */
export function quartiles(buffer: Float32Array, n: number): { p25: number; p75: number } {
  if (n === 0) return { p25: NaN, p75: NaN };
  const p25 = selectPercentile(buffer, n, 0.25, 0);
  // Everything at or below p25's rank is now left of it, so p75's search
  // starts past it.
  const lower25 = Math.floor(0.25 * (n - 1));
  const p75 = selectPercentile(buffer, n, 0.75, lower25);
  return { p25, p75 };
}

/** `percentile` over `buffer[0, n)` as if sorted, without sorting it. Ranks
 * below `from` must already hold the smallest values, in any order. */
function selectPercentile(buffer: Float32Array, n: number, q: number, from: number): number {
  const position = q * (n - 1);
  const lower = Math.floor(position);
  selectRank(buffer, Math.min(from, lower), n - 1, lower);
  const low = buffer[lower];
  if (position === lower) return low;
  // The next rank up is the smallest value right of `lower`.
  let high = Infinity;
  for (let i = lower + 1; i < n; i++) if (buffer[i] < high) high = buffer[i];
  return low + (position - lower) * (high - low);
}

/**
 * Move the value of rank `k` to `buffer[k]` (Hoare selection, three-way
 * partition). Three-way because a path that never binds is zero all year and
 * a two-way partition goes quadratic on equal runs. A range that does not
 * converge is handed to the sort, so nothing is ever quadratic.
 */
function selectRank(buffer: Float32Array, left: number, right: number, k: number): void {
  let passes = 0;
  while (right > left) {
    if (++passes > 64) {
      sortAsc(buffer.subarray(left, right + 1), right - left + 1);
      return;
    }
    const a = buffer[left];
    const b = buffer[(left + right) >> 1];
    const c = buffer[right];
    const pivot = a < b ? (b < c ? b : a < c ? c : a) : a < c ? a : b < c ? c : b;
    let lt = left;
    let i = left;
    let gt = right;
    while (i <= gt) {
      const value = buffer[i];
      if (value < pivot) {
        buffer[i++] = buffer[lt];
        buffer[lt++] = value;
      } else if (value > pivot) {
        buffer[i] = buffer[gt];
        buffer[gt--] = value;
      } else i++;
    }
    if (k < lt) right = lt - 1;
    else if (k > gt) left = gt + 1;
    else return;
  }
}

export interface Quantiles {
  n: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
  /** Tukey fences: the furthest values still within 1.5 x IQR. */
  lowerWhisker: number;
  upperWhisker: number;
  outliers: number;
  /** p25 = median = p75, as an all-zero column or never-binding path gives:
   * correct, but reads as a broken chart. */
  degenerate: boolean;
}

function percentile(sorted: Float32Array, q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const position = q * (n - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (position - lower) * (sorted[upper] - sorted[lower]);
}

/**
 * Sorts once and reads every quantile off the result, serving both the
 * duration curve and the box plot. Sorts `buffer` IN PLACE.
 */
export function quantiles(buffer: Float32Array, n: number): Quantiles {
  const sorted = sortAsc(buffer, n);
  if (n === 0) {
    return {
      n: 0,
      min: NaN,
      p25: NaN,
      median: NaN,
      p75: NaN,
      max: NaN,
      lowerWhisker: NaN,
      upperWhisker: NaN,
      outliers: 0,
      degenerate: false,
    };
  }

  const p25 = percentile(sorted, 0.25);
  const median = percentile(sorted, 0.5);
  const p75 = percentile(sorted, 0.75);
  const fence = 1.5 * (p75 - p25);

  // Walk in from both ends: the whiskers are the first values inside the
  // fences.
  let low = 0;
  while (low < n && sorted[low] < p25 - fence) low++;
  let high = n - 1;
  while (high >= 0 && sorted[high] > p75 + fence) high--;

  return {
    n,
    min: sorted[0],
    p25,
    median,
    p75,
    max: sorted[n - 1],
    lowerWhisker: low < n ? sorted[low] : sorted[0],
    upperWhisker: high >= 0 ? sorted[high] : sorted[n - 1],
    outliers: low + (n - 1 - high),
    degenerate: p25 === median && median === p75,
  };
}

export interface Stats {
  n: number;
  mean: number;
  min: number;
  max: number;
  /** Sample standard deviation (n-1), NaN for n < 2. */
  sd: number;
  /** Total over the kept hours, always computed. Whether it means anything
   * (temporal rule SUM) is the kind's stats table's decision. */
  sum: number;
}

/**
 * Welford in f64, plus a Neumaier-compensated total. Never `sum(x^2)`: it
 * cancels catastrophically when the mean is large relative to the spread,
 * which is exactly the shape of MW, k$ and flow columns.
 */
export function stats(values: Float32Array, n: number): Stats {
  let count = 0;
  let mean = 0;
  let m2 = 0;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let compensation = 0;
  for (let i = 0; i < n; i++) {
    const value = values[i];
    if (Number.isNaN(value)) continue; // belt and braces; applyMask already drops these
    count++;
    const delta = value - mean;
    mean += delta / count;
    m2 += delta * (value - mean);
    if (value < min) min = value;
    if (value > max) max = value;
    const t = sum + value;
    compensation += Math.abs(sum) >= Math.abs(value) ? sum - t + value : value - t + sum;
    sum = t;
  }
  if (count === 0) return { n: 0, mean: NaN, min: NaN, max: NaN, sd: NaN, sum: NaN };
  return {
    n: count,
    mean,
    min,
    max,
    sd: count < 2 ? NaN : Math.sqrt(m2 / (count - 1)),
    sum: sum + compensation,
  };
}

/** True when every kept hour is exactly zero. That is valid data (a path
 * that never binds), but a flat zero line looks like a load failure, so the
 * pane says so. */
export function isAllZero(values: Float32Array, n: number): boolean {
  if (n === 0) return false;
  for (let i = 0; i < n; i++) {
    if (values[i] !== 0) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Ranked stats: the browse table's one pass
// ---------------------------------------------------------------------------
//
// "Which of these 5,901 buses is worth looking at" is answered by one masked
// pass per (table, variable, filters, scoped rows), not by the draw path per
// row.
//
//   1. **The caller passes only the rows the scope KEEPS.** Narrowing before
//      ranking is what makes bus width affordable.
//   2. **A plane start of -1 means "no plane here"**: `n = 0` and blank
//      columns, never a NaN row among real ones.
//   3. **Kind-neutral because it is fed offsets, not tables.**
//
// Output is one flat Float64Array; the table sorts by permuting an index
// array, not by moving rows.

/** Fields per row in a ranked-stats result, in slot order. */
export const RANKED_FIELDS = 8;

/** Slot offsets within one row of a ranked-stats result. */
export const RANKED = {
  n: 0,
  mean: 1,
  min: 2,
  max: 3,
  sd: 4,
  p25: 5,
  p75: 6,
  /** Total over the kept hours; meaningful only where the rule is SUM. */
  sum: 7,
} as const;

export interface RankedRow extends Stats {
  p25: number;
  p75: number;
}

/**
 * What `rankedStats` has already answered, per cube. A committed cube is
 * never written again (a reindex builds a new one), so an answer keyed on the
 * cube OBJECT plus its mask and plane starts still holds, and a new drop
 * ranks only its own rows. Held weakly, so a removed Case frees its entries.
 * Owned by the caller, like the scratch buffer.
 */
export interface RankMemo {
  readonly byCube: WeakMap<
    Float32Array,
    { mask: Uint8Array; starts: Int32Array; ranked: Float64Array }[]
  >;
}

export function createRankMemo(): RankMemo {
  return { byCube: new WeakMap() };
}

/** Answers kept per cube (an entity tab, its variables, a filter toggled
 * back). */
const MEMO_PER_CUBE = 4;

function sameBytes(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Stats for every scoped row, one pass per row's plane. `planeStarts[i]` is
 * where row `i` begins in `cube`, or -1 when the case lacks it. Results are
 * `RANKED_FIELDS` numbers per row in `out` (read with `rankedRow`). `scratch`
 * is reused across rows, so nothing is allocated per interaction.
 */
export function rankedStats(
  cube: Float32Array,
  planeStarts: Int32Array,
  mask: Uint8Array,
  scratch: Float32Array = createScratch(),
  out?: Float64Array,
  memo?: RankMemo,
): Float64Array {
  const rows = planeStarts.length;
  const result = out ?? new Float64Array(rows * RANKED_FIELDS);
  const held = memo?.byCube.get(cube);
  const hit = held?.find(
    (entry) => sameBytes(entry.mask, mask) && sameBytes(entry.starts, planeStarts),
  );
  if (hit) {
    result.set(hit.ranked);
    return result;
  }
  for (let row = 0; row < rows; row++) {
    const base = row * RANKED_FIELDS;
    const start = planeStarts[row];
    if (start < 0) {
      result.fill(NaN, base, base + RANKED_FIELDS);
      result[base + RANKED.n] = 0;
      continue;
    }
    const plane = cube.subarray(start, start + HOURS_PER_YEAR);
    const n = applyMask(plane, mask, scratch);
    const summary = stats(scratch, n);
    // `stats` first: `quartiles` reorders `scratch` in place.
    const spread = quartiles(scratch, n);
    result[base + RANKED.n] = summary.n;
    result[base + RANKED.mean] = summary.mean;
    result[base + RANKED.min] = summary.min;
    result[base + RANKED.max] = summary.max;
    result[base + RANKED.sd] = summary.sd;
    result[base + RANKED.p25] = spread.p25;
    result[base + RANKED.p75] = spread.p75;
    result[base + RANKED.sum] = summary.sum;
  }
  if (memo) {
    const entries = held ?? [];
    // Copies: the caller may reuse its mask and starts, and may rewrite
    // `result`.
    entries.unshift({ mask: mask.slice(), starts: planeStarts.slice(), ranked: result.slice() });
    entries.length = Math.min(entries.length, MEMO_PER_CUBE);
    memo.byCube.set(cube, entries);
  }
  return result;
}

/** One row of a `rankedStats` result as a record. */
export function rankedRow(result: Float64Array, row: number): RankedRow {
  const base = row * RANKED_FIELDS;
  return {
    n: result[base + RANKED.n],
    mean: result[base + RANKED.mean],
    min: result[base + RANKED.min],
    max: result[base + RANKED.max],
    sd: result[base + RANKED.sd],
    p25: result[base + RANKED.p25],
    p75: result[base + RANKED.p75],
    sum: result[base + RANKED.sum],
  };
}
