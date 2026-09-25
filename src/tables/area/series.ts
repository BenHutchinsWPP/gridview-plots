// src/tables/area/series.ts
//
// Area's half of the series model: one `SeriesSpec` in, one drawn
// `CaseSeries` out, using this kind's axis and this kind's rules. This is the
// ONE place an area line is built.
//
// What is this kind's own, and not Generator's or Bus's:
//
//   * **The subject may be an area entity or a grouping.** `areasIn(name)`
//     resolves a grouping to its member areas, and `buildSeries` in
//     `kernels.ts` performs the weighted or unweighted area reduction
//     according to the aggregation rules.
//   * **"% of range" divides by the line's own peak/trough**, in any unit: an
//     area has no limit. A grouping is divided after it is combined, so the
//     divisor is the peak of the sum or weighted mean, not of its members.
//   * **Weighted mean pooled value.** If `buildSeries` returns weights, the
//     pooled weighted mean across the kept hours is computed and attached.

import { HOURS_PER_YEAR, buildCalendar, buildMask } from '../../model/calendar';
import {
  refusedSeries,
  type ResolveOptions,
  type SeriesBuffers,
  type SeriesSpec,
} from '../../series/model';
import type { Filters } from '../../model/types';
import type { CaseSeries } from '../../ui/charts';
import { areasIn } from './groupings';
import { applyMask, buildSeries, isAllZero, pooledWeightedMean, quantiles, stats } from './kernels';
import { ruleFor } from './rules';
import type { AreaTable } from './types';
import { PERCENT, normalizeToRange, rangeLabel } from '../../series/range';

/** What this kind's group members are called when counted (`14 areas`). */
export const MEMBER_NOUN = { one: 'area', many: 'areas' };

export function resolveAreaSeries(
  spec: SeriesSpec,
  table: unknown,
  filters: Filters,
  buffers: SeriesBuffers,
  options: ResolveOptions,
): CaseSeries {
  const data = table as AreaTable;
  const metric = spec.source.quantity;
  const rule = ruleFor(metric);
  const unit = rule?.unit ?? '';

  let areas: string[];
  if ('entity' in spec.subject) {
    areas = [String(spec.subject.entity)];
  } else if (spec.subject.groupBy === 'grouping' || spec.subject.groupBy === 'Group') {
    // A frozen member set is drawn as itself: the grouping file's CURRENT
    // membership is only the fallback for subjects that never froze one. A
    // pin ticked under a filter or scope outlives both, and re-deriving its
    // membership would draw a different set than the label froze.
    areas = spec.subject.members ? spec.subject.members.map(String) : areasIn(spec.subject.value);
    if (areas.length === 0) {
      return refusedSeries(
        options,
        metric,
        `Grouping "${spec.subject.value}" contains no areas to combine.`,
        buffers,
        unit,
      );
    }
  } else {
    return refusedSeries(
      options,
      metric,
      `Grouping areas by "${spec.subject.groupBy}" is not supported. Use a defined Grouping instead.`,
      buffers,
      unit,
    );
  }

  // Caller-owned or buffer-attached weights buffer for weighted mean
  const weightsOut =
    (buffers as { weights?: Float32Array }).weights ??
    ((buffers as { weights?: Float32Array }).weights = new Float32Array(HOURS_PER_YEAR));

  const built = buildSeries(data, metric, areas, buffers.series, weightsOut, options.tableLabel);
  if (built.values === null) {
    const refused = refusedSeries(options, metric, built.refusal ?? '', buffers, unit);
    return { ...refused, metric, warnings: built.warnings };
  }

  buildMask(filters, buildCalendar(data.year), data.tou, buffers.mask);
  const rangeText = spec.perUnit
    ? rangeLabel(normalizeToRange(built.values, {}, PERCENT, buffers.mask))
    : undefined;

  for (let hour = 0; hour < HOURS_PER_YEAR; hour++) {
    buffers.display[hour] = buffers.mask[hour] === 1 ? built.values[hour] : NaN;
  }

  const n = applyMask(built.values, buffers.mask, buffers.gathered);
  const summary = stats(buffers.gathered, n);
  const allZero = isAllZero(buffers.gathered, n);
  const spread = quantiles(buffers.gathered, n);
  const pooled =
    built.weights !== undefined
      ? pooledWeightedMean(built.values, built.weights, buffers.mask)
      : null;

  return {
    name: options.name,
    detail: options.detail,
    color: options.color,
    dashed: options.dashed,
    unit: rangeText ? '%' : unit,
    metric,
    quantity: metric,
    values: buffers.display,
    warnings: built.warnings,
    weightColumn: built.weightColumn,
    sorted: buffers.gathered,
    n,
    stats: summary,
    quantiles: spread,
    pooled,
    allZero,
    ...('entity' in spec.subject ? {} : { summed: areas }),
    ...(rangeText ? { rangeLabel: rangeText } : {}),
  };
}
