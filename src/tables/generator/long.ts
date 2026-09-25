// src/tables/generator/long.ts
//
// The Generator kind's half of long-shape (L) detection and ingest.
// See `src/tables/bus/long.ts` for why a kind owns its own signature.

import type { CaseAccumulator, CasePlan, Finalize, LongKind } from '../long/kind';
import type { LongSignature } from '../long/signature';
import { coverageWarnings, planesByMetric } from '../long/slice';
import type { GeneratorTable } from './types';

/**
 * The key columns a long Generator export carries after `Date, Hour, TOU`.
 * Everything past them is a metric column. Matched on TRIMMED names.
 */
const GENERATOR_LONG_KEYS = ['UnitName', 'BusID', 'UnitID'] as const;

/**
 * Which column carries the unit's IDENTITY, as an absolute source index.
 *
 * `UnitName`, which this kind may key on where Bus may not: a generator name
 * is unique by domain rule and ingest enforces it. `BusID` is a foreign key
 * into `BusList` and `UnitID` is a two-character text field -- both are
 * attributes of the row, not axis keys.
 */
const GENERATOR_LONG_ENTITY_COL = 3;

/** The signature as the long reader's header parse takes it. See
 * `src/tables/bus/long.ts` for why it is one object. */
export const GENERATOR_LONG: LongSignature = {
  keys: GENERATOR_LONG_KEYS,
  entityCol: GENERATOR_LONG_ENTITY_COL,
  noun: 'unit',
};

// ------------------------------------------------------------------- ingest

/**
 * A long Generator export carries MANY metrics and a `GeneratorTable` carries
 * ONE quantity, so one file becomes one table per retained metric -- see
 * `src/tables/bus/long.ts` for why the cube is sliced rather than the table
 * type widened.
 */
export type GeneratorLongResult = GeneratorTable[];

/**
 * Slice one finished accumulator into one `GeneratorTable` per metric.
 *
 * The axis is the unit NAME, which is this kind's identity by domain rule, so
 * there is no id to resolve and no label to leave empty: what the scan read is
 * what the table is keyed on. `BusID` and `UnitID` are attributes the row
 * carries; the session-wide `GeneratorList` is where a unit's other properties
 * come from (`src/lookups/`).
 */
export const finalizeGeneratorLong: Finalize<GeneratorLongResult> = (
  accumulator: CaseAccumulator,
  plan: CasePlan,
  axis: string[],
) => {
  const generators = axis.slice();
  const data = planesByMetric(accumulator, axis.length).map((plane) => ({
    cube: plane.cube,
    generators,
    presence: plane.presence,
    tou: accumulator.tou,
    hoursPresent: accumulator.hourSeen,
    sourceColumns: generators,
    year: plan.year,
    quantity: plane.quantity,
  }));
  return { data, warnings: coverageWarnings(accumulator, plan.label, plan.year) };
};

/** Generator, as the long reader takes it. No `retention` note: nothing in
 * this kind's rules depends on a column the picker dropped. */
export const GENERATOR_LONG_KIND: LongKind<GeneratorLongResult> = {
  sig: GENERATOR_LONG,
  finalize: finalizeGeneratorLong,
};
