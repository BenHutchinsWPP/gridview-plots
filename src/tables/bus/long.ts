// src/tables/bus/long.ts
//
// Bus's half of long-shape detection and ingest. A long export has no title
// line, so its key columns are the only evidence of kind, and they are
// declared here for `src/detect.ts`.

import type { CaseAccumulator, CasePlan, Finalize, LongKind } from '../long/kind';
import type { LongSignature } from '../long/signature';
import { coverageWarnings, planesByMetric } from '../long/slice';
import type { BusTable } from './types';

/** Key columns after `Date, Hour, TOU`, matched TRIMMED (exports pad some). */
const BUS_LONG_KEYS = ['BusID', 'BusName', 'Area'] as const;

/** The identity column: `BusID`, never `BusName` (names repeat). */
const BUS_LONG_ENTITY_COL = 3;

/** One signature object for both detection and the header parse, so they
 * cannot disagree. */
export const BUS_LONG: LongSignature = {
  keys: BUS_LONG_KEYS,
  entityCol: BUS_LONG_ENTITY_COL,
  noun: 'bus',
};

// ------------------------------------------------------------------- ingest

/**
 * A long Bus export carries many metrics, but a `BusTable` holds ONE quantity
 * (its slot variant), so one file becomes one table per retained metric. A
 * metric axis on `BusTable` would change every bus kernel, envelope and slot
 * key; slicing the cube instead yields exactly what the wide reader would.
 */
export type BusLongResult = BusTable[];

/** Slice an accumulator into one `BusTable` per metric. Names are left empty
 * on purpose: labels come from BusList (the browse tab falls back to it), so
 * the parser need not carry `BusName`. */
export const finalizeBusLong: Finalize<BusLongResult> = (
  accumulator: CaseAccumulator,
  plan: CasePlan,
  axis: string[],
) => {
  const bad = axis.find((id) => !Number.isInteger(Number(id)));
  if (bad !== undefined) {
    throw new Error(
      `${plan.file.name}: BusID ${JSON.stringify(bad)} is not an integer bus number. The bus ` +
        `axis is the id, so this cannot be guessed.`,
    );
  }
  const buses = Int32Array.from(axis, (id) => Number(id));
  const names = axis.map(() => '');

  const data = planesByMetric(accumulator, axis.length).map((plane) => ({
    cube: plane.cube,
    buses,
    names,
    presence: plane.presence,
    tou: accumulator.tou,
    hoursPresent: accumulator.hourSeen,
    sourceColumns: Array.from(buses),
    year: plan.year,
    quantity: plane.quantity,
  }));

  return { data, warnings: coverageWarnings(accumulator, plan.label, plan.year) };
};

/** Bus as a long-shape kind. No `retention` note: bus quantities combine by
 * unit rules that need no dropped column. */
export const BUS_LONG_KIND: LongKind<BusLongResult> = {
  sig: BUS_LONG,
  finalize: finalizeBusLong,
};
