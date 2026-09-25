// src/tables/generator/derived.ts
//
// Generator attributes COMPUTED from the GeneratorList rather than read from
// it. One registry, asked BY NAME, instead of a branch per attribute in each
// of the four places that answer for one (tab column, grouped build, series
// reduce, line colour), which would disagree the moment one gained a value.
// `labelOf` takes a column READER, not a lookup, so this stays testable in
// plain Node. Adding one here is the whole change.

import {
  cleanFuel,
  cleanFuelColor,
  fuelGroupColor,
  fuelGroupOf,
  CLEAN_FUELS,
  FUEL_GROUPS,
} from './fuel';

/** Reads one GeneratorList column for the generator being labelled. A missing
 * column, an unlisted generator and an empty cell are all allowed to come back
 * blank-ish; the classifier decides what blank means. */
export type AttributeReader = (column: string) => string | number | null | undefined;

export interface DerivedAttribute {
  /** The column key's suffix, and the spelling a saved view may carry. */
  readonly key: string;
  /** The column header, and the name a group-by states. */
  readonly label: string;
  /** Every value this attribute can take, so a grouped tab seeds its rows in
   * a fixed order rather than in whatever order the fleet happens to list. */
  readonly values: readonly string[];
  readonly labelOf: (read: AttributeReader) => string;
  readonly color: (value: string) => string | undefined;
}

export const GENERATOR_DERIVED: readonly DerivedAttribute[] = [
  {
    key: 'fuelClean',
    label: 'Fuel Type (Cleaned)',
    values: CLEAN_FUELS,
    labelOf: (read) => cleanFuel(read),
    color: cleanFuelColor,
  },
  {
    key: 'fuelGroup',
    label: 'Fuel Group',
    values: FUEL_GROUPS,
    labelOf: (read) => fuelGroupOf(cleanFuel(read)),
    color: fuelGroupColor,
  },
];

/** A RETIRED attribute key in a saved view -> its replacement. A retired
 * group VALUE is not mapped: it comes back refused, not silently different. */
const RETIRED_ATTRIBUTES: ReadonlyMap<string, string> = new Map([
  ['Fuel Category', 'fuelClean'],
  ['fuelCategory', 'fuelClean'],
  ['FuelCategory', 'fuelClean'],
]);

/** Both the label ("Fuel Category") and the key ("fuelCategory") resolve:
 * saved views name one and the drawer the other, and a miss silently
 * ungroups the tab. */
export function derivedAttribute(name: string): DerivedAttribute | undefined {
  const held = GENERATOR_DERIVED.find(
    (attribute) => attribute.label === name || attribute.key === name,
  );
  if (held) return held;
  const successor = RETIRED_ATTRIBUTES.get(name);
  return successor === undefined
    ? undefined
    : GENERATOR_DERIVED.find((attribute) => attribute.key === successor);
}
