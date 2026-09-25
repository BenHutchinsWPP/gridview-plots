// src/tables/bus/kernels.ts
//
// f32 storage, f64 arithmetic (see src/kernels.ts), plus:
//
//   1. **Presence before the cube, always.** An uncarried bus is NaN, which
//      poisons Welford and min/max silently; absent pairs are refused.
//   2. **A combination is a reduce, not a path through here.**
//      `src/lookups/reduce.ts` sums over this axis; `buildSeries` answers for
//      ONE stored plane only, which keeps rule 1 true of every number.
//   3. **The axis is the ID, not the name.** Names may repeat; ids resolve
//      through a Map built once per table, never `indexOf` or a name lookup.

import { HOURS_PER_YEAR } from '../../model/calendar';
import { applyMask, createScratch, isAllZero, quantiles, sortAsc, stats } from '../../kernels';
import { busLabel } from './rules';
import type { BusTable } from './types';

export { applyMask, createScratch, isAllZero, quantiles, sortAsc, stats };

import type { SeriesResult } from '../../model/types';
export type { SeriesResult };

function refuse(reason: string): SeriesResult {
  return { values: null, refusal: reason, warnings: [] };
}

/** Bus id -> cube index. Ingest refuses duplicate ids, so the map is exactly
 * as long as the axis. */
export function busIndex(data: BusTable): Map<number, number> {
  const index = new Map<number, number>();
  for (let i = 0; i < data.buses.length; i++) {
    if (!index.has(data.buses[i])) index.set(data.buses[i], i);
  }
  return index;
}

/** 1 = this case has real data for the bus; 0 = the plane is NaN. */
export function hasData(data: BusTable, busIdx: number): boolean {
  return data.presence[busIdx] === 1;
}

/** Where a bus's 8,760-point plane starts in the cube. */
export function planeStart(busIdx: number): number {
  return busIdx * HOURS_PER_YEAR;
}

/**
 * Copy one bus's plane into `out`, or refuse, distinguishing "not carried by
 * this run" from "not retained at load" (different fixes). Refusals name the
 * bus as `name (id)`: an id is unreadable and a name is ambiguous.
 */
export function buildSeries(
  data: BusTable,
  busId: number,
  /** From `busIndex(data)`, built once when the table is attached. */
  index: Map<number, number>,
  out: Float32Array,
  /** Names this table in a refusal only; the Case owns the name. */
  caseLabel = 'this case',
): SeriesResult {
  const busIdx = index.get(busId);
  if (busIdx === undefined) {
    const everExported = data.sourceColumns.includes(busId);
    return refuse(
      everExported
        ? `Bus ${busId} is in ${caseLabel} but was not retained at load. Re-ingest to plot it.`
        : `${caseLabel} does not carry bus ${busId}.`,
    );
  }
  if (!hasData(data, busIdx)) {
    return refuse(`${caseLabel} has no data for ${busLabel(data.names[busIdx], busId)}.`);
  }

  const start = planeStart(busIdx);
  out.set(data.cube.subarray(start, start + HOURS_PER_YEAR));
  return { values: out, warnings: [] };
}
