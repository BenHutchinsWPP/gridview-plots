// src/tables/bus/types.ts
//
// The Bus table type and its half of the v3 save envelope. A bus export
// carries an id row above the header:
//
// BusNumber,10001,10002,...
//   Date, Hour, TOU,HAWTHORNE,ASPENDALE,...
//
// so a column's identity is the `Int32` bus number; the name is a label that
// need not be unique.

import { HOURS_PER_YEAR } from '../../model/calendar';
import type { HoursPresent, TouCodes } from '../../model/types';

/** One wide Bus export: `cube[bus * 8760 + hour]`, `bus` indexing `buses`. */
export interface BusTable {
  cube: Float32Array;
  /** The cube's bus axis: BusNumber ids in cube-index order. The IDENTITY. */
  buses: Int32Array;
  /** The label for each id, same order and length. Not an identity: two buses
   * may legitimately share a name, which is exactly why the id row exists. */
  names: string[];
  presence: Uint8Array;
  tou: TouCodes;
  hoursPresent?: HoursPresent;
  /** Every bus id the source CSV carried, retained or not. */
  sourceColumns: number[];
  year: number;
  quantity: string;
}

/** Mirrors data/bus/quantity-rules.json; never re-derive it. Per kind, so
 * one kind can change its vocabulary without asking the others. */
export type QuantityClass = 'EXTENSIVE' | 'INTENSIVE' | 'RATE';
export type TemporalRule = 'SUM' | 'MEAN';

/** One entry of data/bus/quantity-rules.json's `units` array. */
export interface UnitRule {
  readonly unit: string;
  readonly class: QuantityClass;
  /** How to combine HOURS into a period figure. src/tables/interface/types.ts
   * spells out what SUM and MEAN each mean for a stats table. */
  readonly temporal: TemporalRule;
  /** Shown next to the total in the stats table. */
  readonly note?: string;
}

export function serializeBusTable(table: BusTable): {
  fields: Record<string, unknown>;
  cube: Float32Array;
} {
  return {
    fields: {
      year: table.year,
      // A plain number array, not the Int32Array: `storage.ts` base64s
      // `Uint8Array` values and JSON-encodes everything else, so an Int32Array
      // would go out as an object with numeric keys and come back as one.
      buses: Array.from(table.buses),
      names: table.names,
      sourceColumns: table.sourceColumns,
      quantity: table.quantity,
      presence: table.presence,
      tou: table.tou,
      hoursPresent: table.hoursPresent,
    },
    cube: table.cube,
  };
}

export function deserializeBusTable(fields: Record<string, unknown>, cube: ArrayBuffer): BusTable {
  const entry = fields as {
    year: number;
    buses: number[];
    names: string[];
    sourceColumns: number[];
    quantity: string;
    presence: Uint8Array;
    tou: TouCodes;
    hoursPresent?: HoursPresent;
  };
  const values = new Float32Array(cube);
  const expected = entry.buses.length * HOURS_PER_YEAR;
  if (values.length !== expected) {
    throw new Error(
      `saved Bus cube is ${values.length} values, expected ${expected} ` +
        `(${entry.buses.length} buses × ${HOURS_PER_YEAR} h)`,
    );
  }
  if (entry.presence.length !== entry.buses.length) {
    throw new Error(
      `saved Bus presence bitmap is ${entry.presence.length} bytes, expected ` +
        `${entry.buses.length} (one per bus)`,
    );
  }
  if (entry.names.length !== entry.buses.length) {
    throw new Error(
      `saved Bus table has ${entry.names.length} names for ${entry.buses.length} ids; ` +
        `the two axes are written together and must come back the same length`,
    );
  }
  return {
    cube: values,
    buses: Int32Array.from(entry.buses),
    names: entry.names.slice(),
    presence: entry.presence,
    tou: entry.tou,
    hoursPresent: entry.hoursPresent,
    sourceColumns: entry.sourceColumns.slice(),
    year: entry.year,
    quantity: entry.quantity,
  };
}
