// src/lookups/schema.ts
//
// The two lists' column types, declared (the column sets are fixed by the
// domain owner), so no type inference or thresholds are needed. TypeScript,
// not data JSON: these are code, and a const gets exhaustiveness checks.
// Columns still match BY NAME, and an undeclared column is carried by
// `classifyUnknown` rather than refused; only a missing KEY column refuses.

import type { LookupEntity } from './types';

export type DeclaredKind = 'int' | 'float' | 'bool' | 'date' | 'text' | 'enum';

export interface DeclaredColumn {
  readonly name: string;
  readonly kind: DeclaredKind;
  /** The file spells unknown as 0 (Latitude/Longitude 0,0 would otherwise
   * put buses in the Gulf of Guinea). */
  readonly zeroIsNull?: boolean;
}

export interface ListSchema {
  readonly entity: LookupEntity;
  /** The list's name as the user knows it. */
  readonly label: string;
  /** The banner word on line 1 that identifies the file. */
  readonly banner: string;
  /** The one column whose absence is a refusal. */
  readonly keyColumn: string;
  readonly columns: readonly DeclaredColumn[];
  /** What loading this list makes possible, one line: the Contents panel's
   * tooltip, which is how a blank row answers "why can't I …?". */
  readonly enables: string;
}

/** BusList. `BaseKV` 0 is legitimate, so no numeric blank is 0. `Name` is
 * not unique (hence the hourly export's id row). */
export const BUS_LIST: ListSchema = {
  entity: 'bus',
  label: 'BusList',
  banner: 'BUS_GENERAL',
  keyColumn: 'BusID',
  enables: 'Bus names; group-by on list attributes such as LoadArea or PSSEZone',
  columns: [
    { name: 'BusID', kind: 'int' },
    { name: 'Name', kind: 'text' },
    { name: 'BaseKV', kind: 'float' },
    { name: 'Type', kind: 'int' },
    { name: 'VM', kind: 'float' },
    { name: 'VA', kind: 'float' },
    { name: 'Latitude', kind: 'float', zeroIsNull: true },
    { name: 'Longitude', kind: 'float', zeroIsNull: true },
    { name: 'Monitored', kind: 'bool' },
    { name: 'LoadArea', kind: 'enum' },
    { name: 'PSSEArea', kind: 'enum' },
    { name: 'PSSEZone', kind: 'enum' },
  ],
};

/**
 * GeneratorList. Types come from the header and one sample row (not a full
 * profile). `Name` is the unique key. `Bus ID` is the foreign key into
 * `BusList.BusID`, so both are `int` and must normalise identically, or the
 * join silently matches nothing.
 */
export const GENERATOR_LIST: ListSchema = {
  entity: 'generator',
  label: 'GeneratorList',
  banner: 'GENERATORLIST',
  keyColumn: 'Name',
  enables: 'Generator group % of range; group-by on list attributes',
  columns: [
    { name: 'GeneratorKey', kind: 'int' },
    { name: 'Name', kind: 'text' },
    { name: 'Bus ID', kind: 'int' },
    { name: 'Bus Name', kind: 'text' },
    { name: 'Bus KV', kind: 'float' },
    { name: 'Unit ID', kind: 'text' },
    { name: 'Generator TypeID', kind: 'enum' },
    { name: 'SubType', kind: 'enum' },
    { name: 'Long ID', kind: 'text' },
    { name: 'Long Name', kind: 'text' },
    { name: 'ServiceStatus', kind: 'bool' },
    { name: 'Commission Date', kind: 'date' },
    { name: 'Retirement Date', kind: 'date' },
    { name: 'DevStatus', kind: 'enum' },
    { name: 'Area Name', kind: 'enum' },
    { name: 'Region Name', kind: 'enum' },
    { name: 'PSSEMinCap(MW)', kind: 'float' },
    { name: 'PSSEMaxCap(MW)', kind: 'float' },
    { name: 'InitialDispatch(MW)', kind: 'float' },
    { name: 'Save To Binary', kind: 'bool' },
    { name: 'State', kind: 'enum' },
    { name: 'County', kind: 'enum' },
    { name: 'City', kind: 'enum' },
    { name: 'Zipcode', kind: 'text' },
    { name: 'FuelType', kind: 'enum' },
    { name: 'Technology', kind: 'enum' },
    { name: 'BTM', kind: 'bool' },
    { name: 'InternalID', kind: 'int' },
    { name: 'EconomicPMin', kind: 'float' },
    { name: 'EconomicPMax', kind: 'float' },
  ],
};

export const LIST_SCHEMAS: readonly ListSchema[] = [BUS_LIST, GENERATOR_LIST];

/** The schema whose banner word this line opens with, or undefined. The word
 * is compared case-insensitively and trimmed; a banner no schema claims is
 * refused BY NAME by the caller, never guessed at. */
export function schemaForBanner(bannerWord: string): ListSchema | undefined {
  const word = bannerWord.trim().toLowerCase();
  return LIST_SCHEMAS.find((schema) => schema.banner.toLowerCase() === word);
}

export function schemaFor(entity: LookupEntity): ListSchema {
  return entity === 'bus' ? BUS_LIST : GENERATOR_LIST;
}

/** The type for an undeclared column: `enum` at ≤256 distinct values and
 * ≤1 per eight rows, else `text`. Never a number: a misread id would break
 * every join. */
const ENUM_MAX_DISTINCT = 256;
const ENUM_MAX_RATIO = 8;

export function classifyUnknown(distinct: number, rowCount: number): 'enum' | 'text' {
  if (distinct > ENUM_MAX_DISTINCT) return 'text';
  return distinct * ENUM_MAX_RATIO <= rowCount ? 'enum' : 'text';
}
