// src/tables/area/axis.ts
//
// The Area axis math, lifted out of main.ts unchanged. Both functions
// are pure -- they depend on nothing but the table handed in and its span
// -- which is what makes them testable in plain Node with no Worker, no
// fetch and no DOM (tests/test_axis.mjs).
//
// The area axis is BATCH-COUPLED and shared by every Area table: it is the
// union of every file in a drop plus the axis already loaded, it
// lives in module-global pool state, and growing it means every already-loaded
// cube has to be rebuilt at the new indices. That rebuild is `reindexCase`,
// and getting it wrong is silent: a cube whose planes moved but whose values
// did not is a chart of plausible, wrong numbers.

import { YEAR_SLOT_HOURS } from '../../model/calendar';
import type { AreaTable } from './types';

/** Two axes are the same axis only if they agree on ORDER as well as
 * membership -- the cube indexes areas positionally, so a reordered axis of
 * the same names is a different cube layout. */
export function sameAxis(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

/**
 * Rebuild one table's cube onto `axis`, moving every (area, metric) plane to
 * its new index and NaN-filling (presence 0) the planes for areas this table
 * never carried.
 *
 * Returns the table unchanged when the axis already matches, so the common
 * "the drop introduced no new area" path allocates nothing.
 *
 * The presence bitmap moves with the plane: a plane that was absent stays
 * absent, and a plane that did not exist at all lands as absent rather than as
 * a plane of zeros (every kernel reads presence before the cube, and
 * NaN, not zero, is what "no data" has to be underneath it).
 */
export function reindexCase(data: AreaTable, axis: readonly string[]): AreaTable {
  if (sameAxis(data.areas, axis)) return data;

  const numMetrics = data.metrics.length;
  // A plane is every year of the span, so the whole span moves with it.
  const hours = data.numYears * YEAR_SLOT_HOURS;
  const cube = new Float32Array(axis.length * numMetrics * hours);
  cube.fill(NaN);
  const presence = new Uint8Array(axis.length * numMetrics);
  const destByArea = new Map<string, number>();
  axis.forEach((area, index) => destByArea.set(area, index));

  for (let oldArea = 0; oldArea < data.areas.length; oldArea++) {
    const nextArea = destByArea.get(data.areas[oldArea]);
    if (nextArea === undefined) continue;
    for (let metric = 0; metric < numMetrics; metric++) {
      const oldPlane = (oldArea * numMetrics + metric) * hours;
      const nextPlane = (nextArea * numMetrics + metric) * hours;
      cube.set(data.cube.subarray(oldPlane, oldPlane + hours), nextPlane);
      presence[nextArea * numMetrics + metric] = data.presence[oldArea * numMetrics + metric];
    }
  }

  return { ...data, areas: axis.slice(), cube, presence };
}
