// src/tables/interface/kernels.ts
//
// Beyond f32 storage, f64 arithmetic (see src/kernels.ts), two rules run
// through every function in here -- and see src/tables/area/kernels.ts for
// why gathers and sorts go through a caller-owned scratch buffer instead of
// allocating one per call:
//
//   1. **The presence bitmap is consulted before the cube, always.** An
//      interface a case never monitored is NaN in memory, and NaN does not
//      announce itself: it poisons Welford, makes every min/max comparison
//      false, and sorts to one end of a duration curve as a cliff of
//      apparent extremes. Absent pairs are refused up front.
//   2. **A combination is a SIGNED reduce over the shared kernels, never a
//      path through here.** An arbitrary set of interfaces is still not a
//      flow across anything -- two paths sharing a corridor double-count, two
//      measured in opposite directions cancel -- so what combines is a
//      hand-authored group, each member carrying the direction it counts in,
//      through `reduceSignedMembers`. `buildSeries` below answers for ONE
//      stored plane and nothing else, which is what keeps the presence rule
//      above true of every number it returns.

import { HOURS_PER_YEAR } from '../../model/calendar';
import { applyMask, createScratch, isAllZero, quantiles, sortAsc, stats } from '../../kernels';
import type { InterfaceTable } from './types';

export { applyMask, createScratch, isAllZero, quantiles, sortAsc, stats };

import type { SeriesResult } from '../../model/types';
export type { SeriesResult };

function refuse(reason: string): SeriesResult {
  return { values: null, refusal: reason, warnings: [] };
}

/** 1 = this case has real data for the interface; 0 = the plane is NaN. */
export function hasData(data: InterfaceTable, interfaceIndex: number): boolean {
  return data.presence[interfaceIndex] === 1;
}

function planeStart(interfaceIndex: number): number {
  return interfaceIndex * HOURS_PER_YEAR;
}

/**
 * Copy one interface's 8,760-point plane into `out`.
 *
 * There is no aggregation step: the stored plane IS the series (rule 3
 * above), so the only outcomes are the plane or a refusal that names why it
 * is not there -- not monitored in this run, or monitored but not retained at
 * load, which are different problems with different fixes.
 */
export function buildSeries(
  data: InterfaceTable,
  name: string,
  out: Float32Array,
  /** What to call this table in a REFUSAL message, and nothing else. An
   * `InterfaceTable` carries no name of its own: the Case (and its
   * slot) owns the name, so the caller -- which resolved the table out of
   * the `CaseStore` -- is the only thing that can say whose data this is.
   * Nothing branches on it. */
  caseLabel = 'this case',
): SeriesResult {
  const index = data.interfaces.indexOf(name);
  if (index < 0) {
    const everExported = data.sourceColumns.some((column) => column.trim() === name);
    return refuse(
      everExported
        ? `"${name}" is in ${caseLabel} but was not retained at load. Re-ingest to plot it.`
        : `${caseLabel} does not monitor "${name}".`,
    );
  }
  if (!hasData(data, index)) {
    return refuse(`${caseLabel} has no data for "${name}".`);
  }

  const start = planeStart(index);
  out.set(data.cube.subarray(start, start + HOURS_PER_YEAR));
  return { values: out, warnings: [] };
}
