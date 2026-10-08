// src/tables/long/slice.ts
//
// Cutting one long-shape cube into one plane per metric, and the notes any
// long-shape file earns about what it covered.
//
// This is SHAPE work, not a kind's: a long export carries many metrics, and a
// kind whose table carries ONE quantity -- Bus, Generator -- becomes one table
// per metric. What the planes MEAN, and what table type they go into, stays in
// `src/tables/<kind>/long.ts`. Nothing here names a kind, reads a rule or
// looks at an axis value.

import { realHours, realHoursSeen, YEAR_SLOT_HOURS } from '../../model/calendar';
import type { CaseAccumulator } from './kind';

/** Cut out of the accumulator's cube. */
export interface MetricPlane {
  /** The metric's canonical column name -- the quantity, and the slot variant
   * for the kinds keyed on one. */
  quantity: string;
  /** `cube[(entity * numYears + yearOffset) * 8784 + slotHour]`, the shape a
   * one-quantity table wants. */
  cube: Float32Array;
  /** One byte per entity, the same bitmap the wide reader produces. */
  presence: Uint8Array;
}

/**
 * Slice every RETAINED-and-present metric out of a finished accumulator.
 *
 * The reader's layout is `((entity * numMetrics + metric) * numYears +
 * yearOffset) * 8784 + slotHour`, so one (entity, metric) plane's span is
 * contiguous and one metric's cube is a strided copy -- and the result is what the wide
 * reader would have produced from the same numbers, which is the point:
 * downstream cannot tell which shape a table was read from.
 *
 * A metric the picker retained but this file does not carry is skipped rather
 * than emitted as an all-NaN table: a table nothing wrote is a slot that would
 * read as a real, empty export.
 */
export function planesByMetric(accumulator: CaseAccumulator, entityCount: number): MetricPlane[] {
  const { plan, cube, entitySeen } = accumulator;
  const numMetrics = plan.metrics.length;
  const span = accumulator.numYears * YEAR_SLOT_HOURS;
  const out: MetricPlane[] = [];
  for (let metric = 0; metric < numMetrics; metric++) {
    if (!plan.presence[metric]) continue;
    const values = new Float32Array(entityCount * span);
    const presence = new Uint8Array(entityCount);
    for (let entity = 0; entity < entityCount; entity++) {
      const from = (entity * numMetrics + metric) * span;
      values.set(cube.subarray(from, from + span), entity * span);
      presence[entity] = entitySeen[entity] ? 1 : 0;
    }
    out.push({ quantity: plan.metrics[metric], cube: values, presence });
  }
  return out;
}

/**
 * What one long-shape file earned the user a note about: retained columns it
 * does not carry and real hours it does not cover.
 *
 * Said ONCE per file, not once per table -- one file becomes many tables here,
 * and the same sentence repeated eight times reads as eight problems.
 */
export function coverageWarnings(accumulator: CaseAccumulator, label: string): string[] {
  const warnings: string[] = [];
  const { plan } = accumulator;
  const absent = plan.metrics.filter((_, i) => !plan.presence[i]);
  if (absent.length > 0) {
    warnings.push(
      `${label}: ${absent.length} retained column(s) are not in this export ` +
        `(${absent.slice(0, 3).join(', ')}${absent.length > 3 ? ', …' : ''}).`,
    );
  }
  const { firstYear, numYears } = accumulator;
  const covered = realHoursSeen(accumulator.hourSeen, firstYear, numYears);
  const real = realHours(firstYear, numYears);
  if (covered < real) {
    warnings.push(
      `${label}: covers ${covered.toLocaleString()} of ${real.toLocaleString()} ` +
        `hours; the rest read as no-data.`,
    );
  }
  return warnings;
}
