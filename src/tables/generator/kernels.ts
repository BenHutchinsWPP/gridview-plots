// src/tables/generator/kernels.ts
//
// f32 storage, f64 arithmetic: see src/kernels.ts.
//
//   1. **The presence bitmap is consulted before the cube, always.** A
//      generator a case never carried is NaN in memory, and NaN does not
//      announce itself: it poisons Welford, defeats every min/max comparison,
//      and sorts to one end of a duration curve as a cliff of apparent
//      extremes. Absent pairs are refused up front.
//   2. **`buildSeries` here copies one stored plane, no more.** The lookup
//      join that sums a fleet by group lives in `series.ts`
//      (`reduceSingleBucket`), not here: this file stays plane-only.
//   3. **The axis is the name**, confirmed unique by the domain owner, and a
//      duplicate name in a wide header is refused at ingest. So there is no
//      id row and no disambiguation path -- the opposite of the Bus kind,
//      deliberately.

import { HOURS_PER_YEAR } from '../../model/calendar';
import { applyMask, createScratch, isAllZero, quantiles, sortAsc, stats } from '../../kernels';
import type { GeneratorTable } from './types';

export { applyMask, createScratch, isAllZero, quantiles, sortAsc, stats };

import type { SeriesResult } from '../../model/types';
export type { SeriesResult };

function refuse(reason: string): SeriesResult {
  return { values: null, refusal: reason, warnings: [] };
}

/** 1 = this case has real data for the generator; 0 = the plane is NaN. */
export function hasData(data: GeneratorTable, generatorIndex: number): boolean {
  return data.presence[generatorIndex] === 1;
}

/** Where a generator's 8,760-point plane starts in the cube. */
export function planeStart(generatorIndex: number): number {
  return generatorIndex * HOURS_PER_YEAR;
}

/**
 * Copy one generator's 8,760-point plane into `out`.
 *
 * The stored plane IS the series in this build (rule 3), so the only outcomes
 * are the plane or a refusal that names why it is not there -- not carried by
 * this run, or carried but not retained at load, which are different problems
 * with different fixes.
 */
export function buildSeries(
  data: GeneratorTable,
  name: string,
  out: Float32Array,
  /** What to call this table in a REFUSAL message, and nothing else. A
   * GeneratorTable carries no name of its own: the Case (and its slot)
   * owns the name, so the caller is the only thing that can say whose data
   * this is. Nothing branches on it. */
  caseLabel = 'this case',
): SeriesResult {
  const index = data.generators.indexOf(name);
  if (index < 0) {
    const everExported = data.sourceColumns.some((column) => column.trim() === name);
    return refuse(
      everExported
        ? `"${name}" is in ${caseLabel} but was not retained at load. Re-ingest to plot it.`
        : `${caseLabel} does not carry "${name}".`,
    );
  }
  if (!hasData(data, index)) {
    return refuse(`${caseLabel} has no data for "${name}".`);
  }

  const start = planeStart(index);
  out.set(data.cube.subarray(start, start + HOURS_PER_YEAR));
  return { values: out, warnings: [] };
}
