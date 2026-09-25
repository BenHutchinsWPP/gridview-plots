// src/tables/area/long.ts
//
// Area's half of long-shape ingest: its calculated columns, finalizer and
// table. **The calculated columns are Area's alone**: `applyDerived` is sound
// only because area-axis reduction commutes with the subtraction (AGENTS.md),
// and another kind offered them would list metrics nothing fills.

import { HOURS_PER_YEAR } from '../../model/calendar';
import { derivedFor, requiredInputs, ruleFor } from './rules';
import type { AreaTable } from './types';
import { unionSchema } from '../long/header';
import type { LongSignature } from '../long/signature';

/**
 * `Date, Hour, TOU, Name` -- Area's long layout.
 *
 * A KIND's fact, so it lives here rather than as the reader's default: a
 * default would let a batch that forgot its kind parse a bus export as area,
 * silently, with the wrong entity column. Every caller names its signature.
 */
export const AREA_LONG: LongSignature = { keys: ['Name'], entityCol: 3, noun: 'area' };
import type { CaseAccumulator, CasePlan, Finalize, LongKind } from '../long/kind';

export function unionOf(plans: CasePlan[]): string[] {
  const columns = unionSchema(plans.map((p) => p.header));
  // Calculated columns are in no header, so they are appended here.
  return [...columns, ...derivedFor(columns)];
}

/**
 * Fill each CALCULATED column's plane after the last block. NaN propagates,
 * so an hour either operand lacks stays absent. A per-area ratio (`div`) is a
 * per-area answer; groups use the WEIGHTED_MEAN rule (kernels.ts). Returns
 * warnings about operand SIGN and zero denominators.
 */
export function applyDerived(accumulator: CaseAccumulator): string[] {
  const { plan, cube } = accumulator;
  const numMetrics = plan.metrics.length;
  const warnings: string[] = [];

  for (let metric = 0; metric < numMetrics; metric++) {
    const derived = ruleFor(plan.metrics[metric])?.derived;
    if (!derived) continue;
    const left = plan.metrics.indexOf(derived.minuend);
    const right = plan.metrics.indexOf(derived.subtrahend);
    if (left < 0 || right < 0 || !plan.presence[left] || !plan.presence[right]) continue;

    // A subtraction means what its NAME claims only for unsigned operands:
    // `Export - Import` stops being net exports if flows ship negative. So
    // the sign is checked, not assumed.
    let negativeLeft = 0;
    let negativeRight = 0;
    let zeroDenominator = 0;
    let live = 0;
    const divide = derived.op === 'div';

    for (let area = 0; area < accumulator.entityCount; area++) {
      const out = (area * numMetrics + metric) * HOURS_PER_YEAR;
      const a = (area * numMetrics + left) * HOURS_PER_YEAR;
      const b = (area * numMetrics + right) * HOURS_PER_YEAR;
      for (let hour = 0; hour < HOURS_PER_YEAR; hour++) {
        const x = cube[a + hour];
        const y = cube[b + hour];
        // x/0 is absent (NaN), not Infinity, which no NaN guard would catch.
        cube[out + hour] = divide ? (y === 0 ? NaN : x / y) : x - y;
        if (Number.isNaN(x) || Number.isNaN(y)) continue;
        live++;
        if (x < 0) negativeLeft++;
        if (y < 0) negativeRight++;
        if (y === 0) zeroDenominator++;
      }
    }
    plan.presence[metric] = 1;

    if (divide) {
      if (zeroDenominator > 0) {
        warnings.push(
          `"${plan.metrics[metric]}" has ${zeroDenominator.toLocaleString()} area-hour(s) where ` +
            `${derived.subtrahend} is zero; those read as no-data rather than as a ratio.`,
        );
      }
      // For a ratio the equivalent guard is the weight pairing, asserted in
      // tests/test_kernels_area.mjs.
      continue;
    }

    // A tenth: a few negatives are ordinary noise; a signed column is not.
    const threshold = live / 10;
    const signed = [
      negativeLeft > threshold ? derived.minuend : null,
      negativeRight > threshold ? derived.subtrahend : null,
    ].filter((name): name is string => name !== null);
    if (signed.length > 0) {
      warnings.push(
        `"${plan.metrics[metric]}" subtracts ${derived.subtrahend} from ${derived.minuend}, ` +
          `but ${signed.join(' and ')} ${signed.length === 1 ? 'carries' : 'carry'} negative ` +
          `values in this export — so the result is not the net figure the name implies. ` +
          `Check the export's sign convention before reading it.`,
      );
    }
  }
  return warnings;
}

/** Turn one finished accumulator into an `AreaTable`. `label` is for warnings
 * only; tables have no name. */
export function finalizeCase(
  accumulator: CaseAccumulator,
  label: string,
  sourceColumns: string[],
  year: number,
  areas: string[],
): { data: AreaTable; warnings: string[] } {
  const { plan, cube } = accumulator;
  const numMetrics = plan.metrics.length;
  const presence = new Uint8Array(accumulator.entityCount * numMetrics);
  for (let area = 0; area < accumulator.entityCount; area++) {
    if (!accumulator.entitySeen[area]) continue;
    for (let metric = 0; metric < numMetrics; metric++) {
      presence[area * numMetrics + metric] = plan.presence[metric];
    }
  }

  const warnings: string[] = [];
  const absentMetrics = plan.metrics.filter((_, i) => !plan.presence[i]);
  if (absentMetrics.length > 0) {
    warnings.push(
      `${label}: ${absentMetrics.length} retained column(s) are not in this export ` +
        `(${absentMetrics.slice(0, 3).join(', ')}${absentMetrics.length > 3 ? ', …' : ''}).`,
    );
  }
  const missingAreas = areas.filter((_, i) => !accumulator.entitySeen[i]);
  if (missingAreas.length > 0) {
    warnings.push(
      `${label}: no rows for ${missingAreas.length} area(s): ${missingAreas.join(', ')}.`,
    );
  }
  let covered = 0;
  for (let h = 0; h < HOURS_PER_YEAR; h++) covered += accumulator.hourSeen[h];
  if (covered < HOURS_PER_YEAR) {
    warnings.push(
      `${label}: covers ${covered.toLocaleString()} of ${HOURS_PER_YEAR.toLocaleString()} hours; ` +
        `the rest read as no-data.`,
    );
  }
  // Feb 29 is dropped at ingest; a leap year says so.
  if ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0) {
    warnings.push(`${label}: ${year} is a leap year — Feb 29 was dropped at ingest.`);
  }

  return {
    data: {
      cube,
      areas,
      metrics: plan.metrics,
      presence,
      tou: accumulator.tou,
      hoursPresent: accumulator.hourSeen,
      sourceColumns,
      year,
    },
    warnings,
  };
}

/** Area's finalizer: the calculated columns, then the table. */
const finalizeArea: Finalize<AreaTable> = (accumulator, plan, axis) => {
  // After every block (operands must be complete) and before presence is
  // turned into the per-(area, metric) bitmap.
  const warnings = applyDerived(accumulator);
  const finalized = finalizeCase(accumulator, plan.label, plan.header.metricNames, plan.year, axis);
  return { data: finalized.data, warnings: [...warnings, ...finalized.warnings] };
};

/** Area as a long-shape kind: its layout and its table. */
export const AREA_KIND: LongKind<AreaTable> = {
  sig: AREA_LONG,
  retention: (metrics) => {
    // Exactly the columns picked. A needed weight that was not picked is
    // reported, not added; the series draws as a plain mean and says so
    // (see `buildSeries` in kernels.ts).
    const kept = new Set(metrics);
    const out: string[] = [];
    for (const name of requiredInputs(metrics)) {
      if (kept.has(name)) continue;
      out.push(
        `"${name}" was not retained. Columns weighted by it can only be plotted for a single ` +
          `area, and calculated columns that subtract it cannot be built at all. Re-ingest ` +
          `with it kept.`,
      );
    }
    return out;
  },
  finalize: finalizeArea,
};
