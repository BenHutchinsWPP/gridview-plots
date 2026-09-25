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

import { HOURS_PER_YEAR } from '../../model/calendar';
import type { CaseAccumulator } from './kind';

/** Cut out of the accumulator's cube. */
export interface MetricPlane {
  /** The metric's canonical column name -- the quantity, and the slot variant
   * for the kinds keyed on one. */
  quantity: string;
  /** `cube[entity * 8760 + hour]`, the shape a one-quantity table wants. */
  cube: Float32Array;
  /** One byte per entity, the same bitmap the wide reader produces. */
  presence: Uint8Array;
}

/**
 * Slice every RETAINED-and-present metric out of a finished accumulator.
 *
 * The reader's layout is `(entity * numMetrics + metric) * 8760 + hour`, so one
 * metric's plane is a strided copy -- and the result is what the wide reader
 * would have produced from the same numbers, which is the point: downstream
 * cannot tell which shape a table was read from.
 *
 * A metric the picker retained but this file does not carry is skipped rather
 * than emitted as an all-NaN table: a table nothing wrote is a slot that would
 * read as a real, empty export.
 */
export function planesByMetric(accumulator: CaseAccumulator, entityCount: number): MetricPlane[] {
  const { plan, cube, entitySeen } = accumulator;
  const numMetrics = plan.metrics.length;
  const out: MetricPlane[] = [];
  for (let metric = 0; metric < numMetrics; metric++) {
    if (!plan.presence[metric]) continue;
    const values = new Float32Array(entityCount * HOURS_PER_YEAR);
    const presence = new Uint8Array(entityCount);
    for (let entity = 0; entity < entityCount; entity++) {
      const from = (entity * numMetrics + metric) * HOURS_PER_YEAR;
      values.set(cube.subarray(from, from + HOURS_PER_YEAR), entity * HOURS_PER_YEAR);
      presence[entity] = entitySeen[entity] ? 1 : 0;
    }
    out.push({ quantity: plan.metrics[metric], cube: values, presence });
  }
  return out;
}

/**
 * What one long-shape file earned the user a note about: retained columns it
 * does not carry, hours it does not cover, and the dropped Feb 29.
 *
 * Said ONCE per file, not once per table -- one file becomes many tables here,
 * and the same sentence repeated eight times reads as eight problems.
 */
export function coverageWarnings(
  accumulator: CaseAccumulator,
  label: string,
  year: number,
): string[] {
  const warnings: string[] = [];
  const { plan } = accumulator;
  const absent = plan.metrics.filter((_, i) => !plan.presence[i]);
  if (absent.length > 0) {
    warnings.push(
      `${label}: ${absent.length} retained column(s) are not in this export ` +
        `(${absent.slice(0, 3).join(', ')}${absent.length > 3 ? ', …' : ''}).`,
    );
  }
  let covered = 0;
  for (let h = 0; h < HOURS_PER_YEAR; h++) covered += accumulator.hourSeen[h];
  if (covered < HOURS_PER_YEAR) {
    warnings.push(
      `${label}: covers ${covered.toLocaleString()} of ${HOURS_PER_YEAR.toLocaleString()} ` +
        `hours; the rest read as no-data.`,
    );
  }
  // A leap year is stated rather than silent.
  if ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0) {
    warnings.push(`${label}: ${year} is a leap year — Feb 29 was dropped at ingest.`);
  }
  return warnings;
}
