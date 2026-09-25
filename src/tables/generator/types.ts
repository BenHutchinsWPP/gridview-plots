// src/tables/generator/types.ts
//
// The Generator table type and its half of the v3 save envelope.
//
// The section that draws these tables is `src/tables/generator/ui/`, what turns
// one `SeriesSpec` into one drawn line is `src/tables/generator/series.ts`, and
// the rules that say what a unit means are `src/tables/generator/rules.ts`.
//
// What is NOT here is anything that decides how generators COMBINE. They do
// combine -- generation by fuel type, by area -- but every such grouping is a
// join against the GeneratorList lookup, done in `ui/browse.ts`, not here.

import { HOURS_PER_YEAR } from '../../model/calendar';
import type { HoursPresent, TouCodes } from '../../model/types';

/**
 * The box plot's kind-specific dimension for this section. A copy of the other
 * kinds' rather than a shared union: the four differ in exactly that member,
 * so the kinds' chart logic stays apart.
 */
/**
 * One wide Generator export. `cube` is indexed
 *
 *   cube[generator * 8760 + hour]
 *
 * -- one metric (the title's quantity) for every generator the file lists,
 * exactly as an Interface table is one quantity per interface. Case identity
 * lives outside this table, in `src/model/case-model.ts`.
 */
export interface GeneratorTable {
  cube: Float32Array;
  /** In cube-index order. */
  generators: string[];
  /** One byte per generator: 1 = this export carried it, 0 = the plane is
   * NaN-filled. Every reader must consult this before the cube. */
  presence: Uint8Array;
  tou: TouCodes;
  hoursPresent?: HoursPresent;
  /** Every generator the source CSV carried, retained or not. */
  sourceColumns: string[];
  year: number;
  /** What this file measures, verbatim from its title line. */
  quantity: string;
}

/** Mirrors data/generator/quantity-rules.json exactly -- never re-derive it.
 * See src/tables/bus/types.ts for why this is redeclared per kind rather
 * than shared. */
export type QuantityClass = 'EXTENSIVE' | 'INTENSIVE' | 'RATE';
export type TemporalRule = 'SUM' | 'MEAN';

/** One entry of data/generator/quantity-rules.json's `units` array. */
export interface UnitRule {
  readonly unit: string;
  readonly class: QuantityClass;
  /** How to combine HOURS into a period figure -- see
   * src/tables/interface/types.ts for what SUM and MEAN each mean here. */
  readonly temporal: TemporalRule;
  /** Shown next to the total in the stats table. */
  readonly note?: string;
}

export function serializeGeneratorTable(table: GeneratorTable): {
  fields: Record<string, unknown>;
  cube: Float32Array;
} {
  return {
    fields: {
      year: table.year,
      generators: table.generators,
      sourceColumns: table.sourceColumns,
      quantity: table.quantity,
      presence: table.presence,
      tou: table.tou,
      hoursPresent: table.hoursPresent,
    },
    cube: table.cube,
  };
}

export function deserializeGeneratorTable(
  fields: Record<string, unknown>,
  cube: ArrayBuffer,
): GeneratorTable {
  const entry = fields as {
    year: number;
    generators: string[];
    sourceColumns: string[];
    quantity: string;
    presence: Uint8Array;
    tou: TouCodes;
    hoursPresent?: HoursPresent;
  };
  const values = new Float32Array(cube);
  const expected = entry.generators.length * HOURS_PER_YEAR;
  if (values.length !== expected) {
    throw new Error(
      `saved Generator cube is ${values.length} values, expected ${expected} ` +
        `(${entry.generators.length} generators × ${HOURS_PER_YEAR} h)`,
    );
  }
  if (entry.presence.length !== entry.generators.length) {
    throw new Error(
      `saved Generator presence bitmap is ${entry.presence.length} bytes, expected ` +
        `${entry.generators.length} (one per generator)`,
    );
  }
  return {
    cube: values,
    generators: entry.generators.slice(),
    presence: entry.presence,
    tou: entry.tou,
    hoursPresent: entry.hoursPresent,
    sourceColumns: entry.sourceColumns.slice(),
    year: entry.year,
    quantity: entry.quantity,
  };
}
