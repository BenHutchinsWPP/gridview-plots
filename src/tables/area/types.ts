// src/tables/area/types.ts
//
// Area model types. `AreaQuery` is the frozen object the UI renders from:
// build a new one per interaction and never mutate it.

import { HOURS_PER_YEAR } from '../../model/calendar';
import { allAreas } from './groupings';
import type { Filters, HoursPresent, TouCodes } from '../../model/types';

export type BoxDim = 'case' | 'month' | 'hourOfDay' | 'dayOfWeek' | 'season' | 'area';

export interface AreaQuery {
  /** `Case.id`s, never filenames or names, so a rename rewrites nothing. */
  readonly cases: readonly string[];
  readonly filters: Filters;
  readonly boxDim: BoxDim;
}

/** Mirrors data/area/aggregation-rules.json; see its `contract`. Branch on
 * `series`/`temporal`/`weight`, never re-derive. */
export type ColumnClass = 'EXTENSIVE' | 'INTENSIVE' | 'CAPACITY';
export type SeriesRule = 'SUM' | 'WEIGHTED_MEAN' | 'MEAN';

/** One entry of data/area/aggregation-rules.json's `columns` array. */
export interface ColumnRule {
  readonly header: string;
  readonly canonical: string;
  readonly unit: string;
  readonly class: ColumnClass;
  /** How to combine areas into a group's per-hour series. */
  readonly series: SeriesRule;
  /** How to combine hours: SUM means a period total is meaningful (MWh);
   * MEAN means it is not (MW). */
  readonly temporal: SeriesRule;
  /** For WEIGHTED_MEAN, e.g. 'Load (MWh)'. */
  readonly weight?: string;
  /** Tried when sum(weight) === 0 over the filtered hours. */
  readonly fallbackWeight?: string;
  /** A column another column is weighted by. */
  readonly isWeight?: boolean;
  /**
   * A CALCULATED column, filled at ingest per area from two operands, present
   * only when both are. `sub` is sound because both operands are same-unit
   * EXTENSIVE (`Σ(x-y) = Σx - Σy`). `div` does NOT commute with the area
   * collapse, so it MUST carry `series: 'WEIGHTED_MEAN'` weighted by the
   * DENOMINATOR, which restores `Σa/Σb`. tests/test_kernels_area.mjs asserts
   * the pairing.
   */
  readonly derived?: {
    readonly minuend: string;
    readonly subtrahend: string;
    readonly op?: 'sub' | 'div';
  };
  /** Inferred from the name and unit, not confirmed against GridView's
   * definition; marks rows to re-check. Nothing branches on it. */
  readonly provisional?: boolean;
  /** All-zero in every case seen: valid data, not a load error. */
  readonly degenerate?: boolean;
  /** Mostly zero/absent. */
  readonly sparse?: boolean;
  /** Summing across areas double-counts (a flow shared by both sides). */
  readonly intraGroupHazard?: boolean;
}

/**
 * One case's Area table. `cube` is indexed
 * `(area * numMetrics + metric) * 8760 + hour`. It carries NO name: the Case
 * owns identity and label (src/model/case-model.ts).
 */
export interface AreaTable {
  cube: Float32Array;
  areas: string[];
  metrics: string[];
  /** One byte per (area, metric) at `area * numMetrics + metric`: 1 = real
   * data, 0 = NaN-filled (column absent). Every kernel checks it first. */
  presence: Uint8Array;
  tou: TouCodes;
  hoursPresent?: HoursPresent;
  /** Every column the source carried, retained or not, so "never existed"
   * and "not kept" stay distinguishable. */
  sourceColumns: string[];
  /** The case's calendar year, which selects `buildCalendar(year)`. */
  year: number;
}

// An `AreaTable`'s half of the save envelope, reached through the registry.
// The cube rides in the binary section; the bitmaps are returned as
// `Uint8Array`s for the envelope to encode.

export function serializeAreaTable(table: AreaTable): {
  fields: Record<string, unknown>;
  cube: Float32Array;
} {
  return {
    fields: {
      year: table.year,
      metrics: table.metrics,
      sourceColumns: table.sourceColumns,
      areas: table.areas,
      presence: table.presence,
      tou: table.tou,
      hoursPresent: table.hoursPresent,
    },
    cube: table.cube,
  };
}

export function deserializeAreaTable(
  fields: Record<string, unknown>,
  cube: ArrayBuffer,
): AreaTable {
  const entry = fields as {
    year: number;
    metrics: string[];
    sourceColumns: string[];
    areas: string[];
    presence: Uint8Array;
    tou: TouCodes;
    hoursPresent?: HoursPresent;
  };

  // An empty area list (older bundles) falls back to the global axis,
  // resolved BEFORE the cube is measured so the fallback is validated.
  const areas = entry.areas.length > 0 ? entry.areas.slice() : allAreas();
  const values = new Float32Array(cube);
  const expected = areas.length * entry.metrics.length * HOURS_PER_YEAR;
  if (values.length !== expected) {
    throw new Error(
      `saved Area cube is ${values.length} values, expected ${expected} ` +
        `(${areas.length} areas × ${entry.metrics.length} metrics × ${HOURS_PER_YEAR} h)`,
    );
  }
  if (entry.presence.length !== areas.length * entry.metrics.length) {
    throw new Error(
      `saved Area presence bitmap is ${entry.presence.length} bytes, expected ` +
        `${areas.length * entry.metrics.length} (one per area × metric plane)`,
    );
  }

  return {
    cube: values,
    areas,
    metrics: entry.metrics.slice(),
    presence: entry.presence,
    tou: entry.tou,
    hoursPresent: entry.hoursPresent,
    sourceColumns: entry.sourceColumns.slice(),
    year: entry.year,
  };
}
