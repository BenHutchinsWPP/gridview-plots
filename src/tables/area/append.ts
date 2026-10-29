// src/tables/area/append.ts
//
// An Area table joined by a later drop: the metrics of two tables over the
// loaded axis. The axis is the global one, so the output keeps `old.areas`
// as is and a fresh area is found by name, never by position.

import { fewNames, type CubeFactor } from '../../ingest';
import { mergePlanes, unionColumns, unionSpan, type Appended } from '../append';
import { derivedFor } from './rules';
import type { AreaTable } from './types';

export function areaAppendSize(
  old: AreaTable,
  fresh: AreaTable,
): { factors: CubeFactor[]; numYears: number } {
  return {
    factors: [
      { count: unionColumns(old.metrics, fresh.metrics).length, one: 'metric', many: 'metrics' },
      { count: old.areas.length, one: 'area', many: 'areas' },
    ],
    numYears: unionSpan(old, fresh).span.numYears,
  };
}

/** Calculated columns the joined metrics could offer that neither drop could
 * alone: their operands arrived apart, so they are not filled. */
function apartDerived(old: AreaTable, fresh: AreaTable, metrics: string[]): string[] {
  const alone = new Set([...derivedFor(old.metrics), ...derivedFor(fresh.metrics)]);
  return derivedFor(metrics).filter((m) => !alone.has(m) && !metrics.includes(m));
}

export function appendAreaTable(old: AreaTable, fresh: AreaTable): Appended<AreaTable> {
  const known = new Map(old.areas.map((a, i) => [a, i]));
  const outside = fresh.areas.filter((a) => !known.has(a));
  if (outside.length > 0) {
    throw new Error(
      `This file has ${outside.length} area(s) outside the loaded axis (${fewNames(outside)}).`,
    );
  }
  const metrics = unionColumns(old.metrics, fresh.metrics);
  const oldM = old.metrics.length;
  const freshM = fresh.metrics.length;
  const outM = metrics.length;
  const freshArea = new Map(fresh.areas.map((a, i) => [a, i]));
  const freshMetric = new Map(fresh.metrics.map((m, i) => [m, i]));

  const planes = old.areas.length * outM;
  const oldAt = new Int32Array(planes).fill(-1);
  const freshAt = new Int32Array(planes).fill(-1);
  old.areas.forEach((area, a) => {
    const fa = freshArea.get(area);
    metrics.forEach((metric, m) => {
      if (m < oldM) oldAt[a * outM + m] = a * oldM + m;
      const fm = freshMetric.get(metric);
      if (fa !== undefined && fm !== undefined) freshAt[a * outM + m] = fa * freshM + fm;
    });
  });

  const merged = mergePlanes(old, fresh, planes, oldAt, freshAt);
  const added = metrics.slice(oldM);
  const overlapping = metrics.filter((_, m) =>
    old.areas.some((_a, a) => merged.overlapped[a * outM + m]),
  );
  const sourceColumns = unionColumns(old.sourceColumns, fresh.sourceColumns);

  return {
    table: {
      cube: merged.cube,
      cellCoverage: merged.cellCoverage,
      areas: old.areas.slice(),
      metrics,
      presence: merged.presence,
      tou: merged.tou,
      hoursPresent: merged.hoursPresent,
      sourceColumns,
      firstYear: merged.firstYear,
      numYears: merged.numYears,
    },
    noun: 'metric',
    added,
    overlapping,
    wrote: merged.wrote,
    from: { firstYear: old.firstYear, numYears: old.numYears },
    to: { firstYear: merged.firstYear, numYears: merged.numYears },
    apart: apartDerived(old, fresh, metrics),
  };
}
