// src/tables/generator/resolve.ts
//
// The membership-key resolver: a groupings file's two ways of naming a unit
// become the one key the app uses, the GeneratorList `Name`. Resolving once,
// here, is where the two rules that silently lose units live:
//
//   * `Unit ID` is text, but `01` and `1` are one unit: a named normalisation
//     applied to BOTH sides of the join.
//   * `Bus ID` arrives as text; a cell that is not an integer is refused, not
//     parsed to NaN (which would read as a missing unit).
//
// A (Bus ID, Unit ID) pair is not unique in a list; a pair on two rows is
// refused with both names. A key naming a unit the study lacks is not a
// failure: it comes back unresolved for the caller to keep and flag.
//
// Analysts say "bus number"; the file says `Bus ID`. Code uses the file's
// word, messages the analyst's.

import { cellValue } from '../../lookups/merge';
import { GENERATOR_LIST } from '../../lookups/schema';
import type { LookupTable } from '../../lookups/types';

/** The GeneratorList columns the secondary key reads. */
export const BUS_ID_COLUMN = 'Bus ID';
export const UNIT_ID_COLUMN = 'Unit ID';

/** A `Unit ID` as an analyst reads it: trimmed, upper-case, leading zeros off
 * (`01` = `1`, `g1` = `G1`), with a lone `0` kept. */
export function normaliseUnitId(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/^0+(?=.)/, '');
}

/** A `Bus ID` cell as a number, or null. A trailing `.0` (spreadsheet
 * integer) is accepted; anything else is refused, since a prefix parse or NaN
 * would match nothing and look like a missing unit. */
export function busIdOf(raw: string): number | null {
  return /^[+-]?\d+(?:\.0+)?$/.test(raw.trim()) ? Number(raw.trim()) : null;
}

/**
 * The (bus, unit) side of one loaded GeneratorList, normalised like the
 * membership cells. A pair two rows share maps to BOTH, so the refusal can
 * name them. `undefined` (no list) is fine for a `Name`-keyed file; a list
 * missing both columns throws, rather than leaving every row unresolved.
 */
export interface GeneratorKeyIndex {
  readonly list: LookupTable;
  /** `${bus}|${unit}` -> rows; the bus half is digits, so keys are unique. */
  readonly byBusUnit: ReadonlyMap<string, readonly number[]>;
}

export function generatorKeyIndex(list: LookupTable): GeneratorKeyIndex {
  const busColumn = list.byName.get(BUS_ID_COLUMN);
  const unitColumn = list.byName.get(UNIT_ID_COLUMN);
  if (busColumn === undefined || unitColumn === undefined) {
    const missing = [BUS_ID_COLUMN, UNIT_ID_COLUMN].filter((name) => !list.byName.has(name));
    throw new Error(
      `This GeneratorList.csv carries no ${missing.map((n) => `"${n}"`).join(' or ')} column, ` +
        `so a bus number and unit ID cannot be resolved against it.`,
    );
  }

  const byBusUnit = new Map<string, number[]>();
  for (let row = 0; row < list.rowCount; row++) {
    const bus = cellValue(list.columns[busColumn], row);
    const unit = cellValue(list.columns[unitColumn], row);
    // A blank half can never be matched (blank cells are refused), so skip it.
    if (typeof bus !== 'number' || typeof unit !== 'string' || unit === '') continue;
    const key = `${bus}|${normaliseUnitId(unit)}`;
    const held = byBusUnit.get(key);
    if (held) held.push(row);
    else byBusUnit.set(key, [row]);
  }
  return { list, byBusUnit };
}

/** The two ways a membership file may name a unit, as the file's own text. */
export type MembershipKey =
  /** `GENERATOR_LIST.keyColumn`, the app's own key. */
  { by: 'name'; name: string } | { by: 'bus-unit'; busId: string; unitId: string };

/** What one key resolved to. `unresolved` is not a failure (the study lacks
 * the unit; keep and flag it). `refused` is: a bad bus number or a shared
 * pair, where resolving would pick a wrong unit quietly. */
export type MembershipResolution =
  | { status: 'resolved'; name: string }
  | { status: 'unresolved'; reason: string }
  | { status: 'refused'; reason: string };

function nameOf(list: LookupTable, row: number): string {
  const column = list.columns[list.byName.get(GENERATOR_LIST.keyColumn) ?? -1];
  return column === undefined ? '' : String(cellValue(column, row) ?? '');
}

/**
 * Resolve one membership key; `index` is undefined with no list. A `Name`
 * passes through trimmed and otherwise EXACT: names are how an analyst keeps
 * two units apart on purpose.
 */
export function resolveMembershipKey(
  index: GeneratorKeyIndex | undefined,
  key: MembershipKey,
): MembershipResolution {
  if (key.by === 'name') {
    const name = key.name.trim();
    if (name === '') {
      return { status: 'refused', reason: 'The Name cell is blank, so it names no unit.' };
    }
    if (index === undefined || index.list.index.has(name)) {
      return { status: 'resolved', name };
    }
    return {
      status: 'unresolved',
      reason: `"${name}" is not in GeneratorList.csv; this study does not carry it.`,
    };
  }

  if (index === undefined) {
    return {
      status: 'refused',
      reason:
        'Resolving a bus number and unit ID needs GeneratorList.csv to be loaded. A file keyed ' +
        'by Name does not.',
    };
  }
  const bus = busIdOf(key.busId);
  if (bus === null) {
    return {
      status: 'refused',
      reason: `The Bus ID cell "${key.busId.trim()}" is not a bus number.`,
    };
  }
  const unit = normaliseUnitId(key.unitId);
  if (unit === '') {
    return {
      status: 'refused',
      reason: `The Unit ID cell beside bus number ${bus} is blank, so it names no unit.`,
    };
  }
  const rows = index.byBusUnit.get(`${bus}|${unit}`);
  if (rows === undefined) {
    return {
      status: 'unresolved',
      reason:
        `No generator in GeneratorList.csv carries bus number ${bus}, unit ID ${unit}; this ` +
        `study does not carry it.`,
    };
  }
  const names = rows.map((row) => nameOf(index.list, row));
  if (names.length > 1) {
    return {
      status: 'refused',
      reason:
        `Bus number ${bus}, unit ID ${unit} names ${names.length} generators in ` +
        `GeneratorList.csv (${names.map((n) => `"${n}"`).join(', ')}); a bus number and unit ` +
        `ID cannot pick between them.`,
    };
  }
  return { status: 'resolved', name: names[0] };
}
