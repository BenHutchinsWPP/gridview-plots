// src/tables/interface/types.ts
//
// The Interface table type, unit vocabulary, and save-envelope half. Unit
// meaning is in `rules.ts`; drawing is in `series.ts`.

import { savedHoursOnSlot, YEAR_SLOT_HOURS } from '../../model/calendar';
import type { HoursPresent, TouCodes } from '../../model/types';

/** How a quantity behaves when hours are combined. Mirrors
 * data/interface/quantity-rules.json exactly -- never re-derive it. */
export type QuantityClass = 'EXTENSIVE' | 'INTENSIVE' | 'RATE';
export type TemporalRule = 'SUM' | 'MEAN';

/** One entry of data/interface/quantity-rules.json's `units` array. */
export interface UnitRule {
  readonly unit: string;
  readonly class: QuantityClass;
  /** How HOURS combine: SUM means a period total is meaningful ($); MEAN
   * means it is not (MW summed over hours is neither MW nor, for a filtered
   * selection, MWh). */
  readonly temporal: TemporalRule;
  /** Shown next to the total in the stats table. */
  readonly note?: string;
}

/** One interface export file; the Case owns its name. `cube[iface * 8784 +
 * hour]`, with `iface` indexing `interfaces`. */
export interface InterfaceTable {
  cube: Float32Array;
  /** The cube's interface axis: the retained columns, in cube-index order. */
  interfaces: string[];
  /** One byte per interface: 1 = carried by this file, 0 = NaN-filled. Check
   * it before reading the cube. */
  presence: Uint8Array;
  tou: TouCodes;
  hoursPresent?: HoursPresent;
  /** Every interface the source CSV carried, retained or not -- lets Save/Load
   * and the picker distinguish "never monitored in this run" from "monitored
   * but not kept". */
  sourceColumns: string[];
  /** Calendar year this case's hours belong to; it decides whether the
   * slot's Feb 29 is real. */
  year: number;
  /** What this file measures, verbatim from its title line, e.g.
   * `Power Flow (MW)`. Empty when the title line could not be read. */
  quantity: string;
  /** The parenthesised unit of `quantity`, e.g. `MW`. Empty when unknown. */
  unit: string;
}

// ------------------------------------------------------ save / load
//
// Reached only through the registry. `quantity` and `unit` are saved because
// the slot variant derives from them: without them two Interface tables in
// one Case would be indistinguishable.

export function serializeInterfaceTable(table: InterfaceTable): {
  fields: Record<string, unknown>;
  cube: Float32Array;
} {
  return {
    fields: {
      year: table.year,
      firstYear: table.year,
      numYears: 1,
      interfaces: table.interfaces,
      sourceColumns: table.sourceColumns,
      quantity: table.quantity,
      unit: table.unit,
      presence: table.presence,
      tou: table.tou,
      hoursPresent: table.hoursPresent,
    },
    cube: table.cube,
  };
}

export function deserializeInterfaceTable(
  fields: Record<string, unknown>,
  cube: ArrayBuffer,
): InterfaceTable {
  const entry = fields as {
    year: number;
    numYears?: number;
    interfaces: string[];
    sourceColumns: string[];
    quantity: string;
    unit: string;
    presence: Uint8Array;
    tou: TouCodes;
    hoursPresent?: HoursPresent;
  };

  const slot = savedHoursOnSlot(entry, new Float32Array(cube), entry.interfaces.length);
  const values = slot.cube;
  const expected = entry.interfaces.length * YEAR_SLOT_HOURS;
  if (values.length !== expected) {
    throw new Error(
      `saved Interface cube is ${values.length} values, expected ${expected} ` +
        `(${entry.interfaces.length} interfaces × ${YEAR_SLOT_HOURS} h)`,
    );
  }
  // The bitmap every kernel consults before reading the cube: one byte
  // per interface. A wrong length here means the plane-to-byte mapping is
  // off, which reads as real data where there is none.
  if (entry.presence.length !== entry.interfaces.length) {
    throw new Error(
      `saved Interface presence bitmap is ${entry.presence.length} bytes, expected ` +
        `${entry.interfaces.length} (one per interface)`,
    );
  }

  return {
    cube: values,
    interfaces: entry.interfaces.slice(),
    presence: entry.presence,
    tou: slot.tou,
    hoursPresent: slot.hoursPresent,
    sourceColumns: entry.sourceColumns.slice(),
    year: entry.year,
    quantity: entry.quantity,
    unit: entry.unit,
  };
}
