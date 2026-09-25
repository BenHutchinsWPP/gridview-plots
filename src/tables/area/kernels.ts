// src/tables/area/kernels.ts
//
// Two rules run through every function in here, beyond f32 storage, f64
// arithmetic (see src/kernels.ts):
//
//   1. **The presence bitmap is consulted before the cube, always.** A
//      metric a case never exported is NaN in memory, and NaN poisons
//      Welford, makes every min/max comparison false, and sorts to one end
//      of a duration curve as a cliff of apparent extremes.
//   2. **The series is built before it is filtered.** A grouping is
//      collapsed to one 8,760-point series first, so every sort is over
//      <= 8,760 points rather than 376,680.
//
// Sorting, not filtering, is the interaction cost, so gathers and sorts go
// through a caller-owned scratch buffer that is allocated once and reused.

import { HOURS_PER_YEAR } from '../../model/calendar';
import {
  applyMask,
  createScratch,
  isAllZero,
  quantiles,
  sortAsc,
  stats,
  type Quantiles,
} from '../../kernels';
import { ruleFor } from './rules';
import type { AreaTable, ColumnRule } from './types';

export { applyMask, createScratch, isAllZero, quantiles, sortAsc, stats };
export type { Quantiles };

export interface SeriesResult {
  /** The per-hour series, or null when the request was refused. */
  values: Float32Array | null;
  rule: ColumnRule | null;
  /** Set when values is null: what to show in the pane instead of a chart,
   * rendered inline rather than as a toast. */
  refusal?: string;
  /** For WEIGHTED_MEAN: the weight column actually used, and its per-hour
   * sum over the selected areas. The stats table needs the weights to
   * recompute a pooled average -- the mean of a weighted-mean series is not
   * the weighted mean. */
  weightColumn?: string;
  weights?: Float32Array;
  /** Non-fatal notes for the pane header. */
  warnings: string[];
}

function refuse(reason: string, rule: ColumnRule | null = null): SeriesResult {
  return { values: null, rule, refusal: reason, warnings: [] };
}

/** 1 = this case has real data for the pair; 0 = the plane is NaN. */
export function hasData(data: AreaTable, areaIndex: number, metricIndex: number): boolean {
  return data.presence[areaIndex * data.metrics.length + metricIndex] === 1;
}

/** Area indices that both exist in this case and carry the metric. */
function resolveAreas(data: AreaTable, areas: string[], metricIndex: number): number[] {
  const out: number[] = [];
  for (const name of areas) {
    const index = data.areas.indexOf(name);
    if (index >= 0 && hasData(data, index, metricIndex)) out.push(index);
  }
  return out;
}

function planeStart(data: AreaTable, areaIndex: number, metricIndex: number): number {
  return (areaIndex * data.metrics.length + metricIndex) * HOURS_PER_YEAR;
}

/**
 * Build one 8,760-point series for `areas` x `metric`, dispatching on the
 * rule table's `series` enum. `data/area/aggregation-rules.json` is imported, not
 * re-derived -- summing a $/MWh column across areas is physically
 * meaningless and the chart would still render.
 */
export function buildSeries(
  data: AreaTable,
  metric: string,
  areas: string[],
  out: Float32Array,
  /** Caller-owned buffer for the per-hour weight sum. Required for
   * WEIGHTED_MEAN columns; allocating one here would put a 35 KB allocation
   * in the render path, per case, on every interaction. */
  weightsOut?: Float32Array,
  /** What to call this table in a REFUSAL message, and nothing else. An
   * `AreaTable` carries no name of its own: the Case owns the name, so
   * the caller -- which resolved the table out of the `CaseStore` -- is the
   * only thing that can say whose data this is. Nothing branches on it. */
  caseLabel = 'this case',
): SeriesResult {
  const rule = ruleFor(metric);
  if (!rule) {
    return refuse(`No aggregation rule for "${metric}". Refusing rather than guessing one.`);
  }

  const metricIndex = data.metrics.indexOf(metric);
  if (metricIndex < 0) {
    const everExported = data.sourceColumns.some((c) => c.trim() === metric);
    return refuse(
      everExported
        ? `"${metric}" is in ${caseLabel} but was not retained at load. Re-ingest to plot it.`
        : `"${metric}" is not in ${caseLabel}.`,
      rule,
    );
  }

  const areaIndices = resolveAreas(data, areas, metricIndex);
  if (areaIndices.length === 0) {
    return refuse(`${caseLabel} has no data for "${metric}" in the selected area(s).`, rule);
  }

  const warnings: string[] = [];

  // A single area needs no aggregation at all: the stored plane IS the
  // series. Worth special-casing because the weighted-mean path would
  // otherwise turn a perfectly good value into NaN in every hour where the
  // weight happens to be zero.
  if (areaIndices.length === 1) {
    const start = planeStart(data, areaIndices[0], metricIndex);
    out.set(data.cube.subarray(start, start + HOURS_PER_YEAR));
    return { values: out, rule, warnings };
  }

  if (rule.intraGroupHazard) {
    warnings.push(
      `"${metric}" double-counts when summed across areas that trade with each other; ` +
        `read the grouping total with that in mind.`,
    );
  }

  if (rule.series === 'SUM' || rule.series === 'MEAN') {
    combineAreas(data, areaIndices, metricIndex, out, rule.series === 'MEAN');
    return { values: out, rule, warnings };
  }

  // WEIGHTED_MEAN. The declared weight column is used when it is there.
  //
  // WHEN IT IS NOT, THE WEIGHT IS 1 -- a plain mean across the selected areas,
  // with a warning saying so. Refusing is the rejected alternative: a WIDE
  // Area export carries exactly ONE metric, so its intensive column never has
  // its weight in the same table and could never be aggregated at all.
  //
  // The trade is stated rather than hidden: an unweighted mean of a
  // load-weighted price reads HIGH, because the cheap hours are the
  // light-load hours. That is what the warning is for, and it is why
  // `weightColumn` is left undefined on this path -- the stats table keys its
  // "pooled weighted mean" row off that field, so an unweighted series never
  // claims to be a weighted one.
  const candidates = [rule.weight, rule.fallbackWeight].filter(
    (name): name is string => typeof name === 'string',
  );
  for (const weightName of candidates) {
    const weightIndex = data.metrics.indexOf(weightName);
    if (weightIndex < 0) continue;
    const weightAreas = resolveAreas(data, areas, weightIndex);
    if (weightAreas.length === 0) continue;

    const weights = weightsOut ?? new Float32Array(HOURS_PER_YEAR);
    const zeroHours = weightedMeanAreas(data, areaIndices, metricIndex, weightIndex, out, weights);
    if (zeroHours === HOURS_PER_YEAR) continue; // weight is identically zero; try the fallback
    if (zeroHours > 0) {
      warnings.push(
        `${zeroHours.toLocaleString()} hour(s) have a total "${weightName}" of zero, so those ` +
          `hours are a plain mean of the selected areas rather than a weighted one.`,
      );
    }
    return { values: out, rule, weightColumn: weightName, weights, warnings };
  }

  // No usable weight column: weight 1. `combineAreas(..., divide = true)` is
  // the plain mean, which is what a weight of 1 in every area reduces to.
  const named = candidates.length > 0 ? candidates.join('" or "') : '(none declared)';
  combineAreas(data, areaIndices, metricIndex, out, true);
  // Filled so a caller that passed one does not read a stale or zero buffer
  // and compute a pooled figure from it -- every area weighs 1, and there are
  // `areaIndices.length` of them in each hour.
  weightsOut?.fill(areaIndices.length);
  warnings.push(
    `"${metric}" should be weighted by "${named}", which ${caseLabel} does not carry, so every ` +
      `area is weighted equally (weight 1). A plain mean of a ${named}-weighted quantity reads ` +
      `HIGH: the light-${named.toLowerCase().includes('load') ? 'load' : 'weight'} hours count ` +
      `for as much as the heavy ones.`,
  );
  return { values: out, rule, warnings };
}

/**
 * SUM and MEAN across areas: the same accumulation, differing only in whether
 * the hour's total is divided by the areas that contributed. `divide` is
 * loop-invariant, so this is one predictable branch per hour rather than two
 * near-identical kernels.
 *
 * No contributing area is NaN, never 0 -- an hour no area reported is absent,
 * not zero, and every kernel downstream refuses NaN rather than averaging it
 * in.
 */
function combineAreas(
  data: AreaTable,
  areaIndices: number[],
  metricIndex: number,
  out: Float32Array,
  divide: boolean,
): void {
  const { cube } = data;
  for (let hour = 0; hour < HOURS_PER_YEAR; hour++) {
    let total = 0;
    let seen = 0;
    for (let a = 0; a < areaIndices.length; a++) {
      const value = cube[planeStart(data, areaIndices[a], metricIndex) + hour];
      if (Number.isNaN(value)) continue;
      total += value;
      seen++;
    }
    out[hour] = seen === 0 ? NaN : divide ? total / seen : total;
  }
}

/** Returns the number of hours whose weight sum was zero -- those hours fall
 * back to a plain mean of the selected areas (weight 1), the same rule the
 * missing-column path above uses, so a degenerate weight and an absent one
 * behave alike. */
function weightedMeanAreas(
  data: AreaTable,
  areaIndices: number[],
  metricIndex: number,
  weightIndex: number,
  out: Float32Array,
  weightsOut: Float32Array,
): number {
  const { cube } = data;
  let zeroHours = 0;
  for (let hour = 0; hour < HOURS_PER_YEAR; hour++) {
    let weighted = 0;
    let weight = 0;
    for (let a = 0; a < areaIndices.length; a++) {
      const area = areaIndices[a];
      const value = cube[planeStart(data, area, metricIndex) + hour];
      const w = cube[planeStart(data, area, weightIndex) + hour];
      if (Number.isNaN(value) || Number.isNaN(w)) continue;
      weighted += value * w;
      weight += w;
    }
    weightsOut[hour] = weight;
    if (weight === 0) {
      // Zero total weight carries no information to weight BY, the same
      // situation as a missing weight column, so it gets the same answer:
      // weight 1, the plain mean of the areas that had a value. Still
      // counted and warned about, since a plain-mean hour inside a weighted
      // series is worth saying out loud.
      let total = 0;
      let seen = 0;
      for (let a = 0; a < areaIndices.length; a++) {
        const value = cube[planeStart(data, areaIndices[a], metricIndex) + hour];
        if (Number.isNaN(value)) continue;
        total += value;
        seen++;
      }
      out[hour] = seen === 0 ? NaN : total / seen;
      zeroHours++;
    } else {
      out[hour] = weighted / weight;
    }
  }
  return zeroHours;
}

/**
 * The pooled weighted average over the selected cells:
 * `sum(value x weight) / sum(weight)`.
 *
 * This is NOT the mean of the plotted per-hour weighted-mean series, and the
 * two disagree visibly because high-price hours are high-load hours. Both
 * are correct; the stats table must label which is which next to the number
 * itself (and the "Average paradox").
 */
export function pooledWeightedMean(
  series: Float32Array,
  weights: Float32Array,
  mask: Uint8Array,
): number {
  let weighted = 0;
  let total = 0;
  for (let hour = 0; hour < HOURS_PER_YEAR; hour++) {
    if (mask[hour] === 0) continue;
    const value = series[hour];
    const weight = weights[hour];
    if (Number.isNaN(value) || Number.isNaN(weight)) continue;
    weighted += value * weight;
    total += weight;
  }
  return total === 0 ? NaN : weighted / total;
}
