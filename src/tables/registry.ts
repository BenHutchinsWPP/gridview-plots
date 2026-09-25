// src/tables/registry.ts
//
// The registry every `TableKind` registers into: how it is saved, how a picked
// row is drawn, how a drop picks columns, what a file must say to BE this
// kind, its Import Dialog tint, and what loading it makes possible. Callers ask here and never branch on kind
// inline, so a new kind is one entry plus its implementations (no envelope
// change).
//
// Kind literals outside this file are limited to the list
// `tests/test_rot_guards.mjs` asserts, each for a stated reason (the
// `TableKind` union, `DetectKind`, legacy formats, the composition root).
//
// **A kind is registered here, never imported by a sibling.** This module may
// import all four kinds; no kind imports another, or this file.

import type { TableKind } from '../model/case-model';
import type { SeriesResolver } from '../series/model';
import type { RetainGate } from '../ui/retain-gate';
import { CASE_COLORS } from '../ui/palette';
import type { LongSignature } from './long/signature';
import { AREA_ENTITY } from './area/wide';
import { INTERFACE_ENTITY } from './interface/header';
import { BUS_ENTITY } from './bus/wide';
import { GENERATOR_ENTITY } from './generator/wide';
import { BUS_LONG } from './bus/long';
import { GENERATOR_LONG } from './generator/long';
import { EDITOR_CSV_HEADERS as AREA_EDITOR_CSV } from './area/groupings';
import { EDITOR_CSV_HEADERS as INTERFACE_EDITOR_CSV } from './interface/groups';
import { EDITOR_CSV_HEADERS as BUS_EDITOR_CSV } from './bus/groups';
import { EDITOR_CSV_HEADERS as GENERATOR_EDITOR_CSV } from './generator/groups';
import { resolveAreaSeries } from './area/series';
import { createAreaRetainGate } from './area/ui/retain';
import { resolveInterfaceSeries } from './interface/series';
import { createInterfaceRetainGate } from './interface/ui/retain';
import { resolveBusSeries } from './bus/series';
import { createBusRetainGate } from './bus/ui/retain';
import { resolveGeneratorSeries } from './generator/series';
import { createGeneratorRetainGate } from './generator/ui/retain';
import { deserializeAreaTable, serializeAreaTable, type AreaTable } from './area/types';
import {
  deserializeInterfaceTable,
  serializeInterfaceTable,
  type InterfaceTable,
} from './interface/types';
import { deserializeBusTable, serializeBusTable, type BusTable } from './bus/types';
import {
  deserializeGeneratorTable,
  serializeGeneratorTable,
  type GeneratorTable,
} from './generator/types';

/** What a table says of the file it was read from: how many of what that
 * file offered it kept. The Contents inventory's count, for a table whose
 * file was never recorded (a bundle saved before the inventory existed). */
export interface TableCounts {
  of: 'metrics' | 'entities';
  kept: number;
  inSource: number;
}

/** How many of `offered` (trimmed, distinct) the table's axis kept. */
function keptOf(
  offered: readonly (string | number)[],
  axis: ArrayLike<string | number>,
  of: TableCounts['of'],
): TableCounts {
  const kept = new Set(Array.from(axis, (name) => String(name).trim()));
  const names = new Set(offered.map((name) => String(name).trim()).filter((name) => name !== ''));
  let count = 0;
  for (const name of names) if (kept.has(name)) count++;
  return { of, kept: count, inSource: names.size };
}

/** A table's manifest fields: JSON-safe, except `Uint8Array` bitmaps, which the
 * envelope base64-encodes so no kind writes an encoder. */
export type TableFields = Record<string, unknown>;

export interface SerializedTable {
  fields: TableFields;
  /** The flat cube. It rides in the bundle's binary section, never the JSON. */
  cube: Float32Array;
}

export interface TableStorage {
  serialize(table: unknown): SerializedTable;
  deserialize(fields: TableFields, cube: ArrayBuffer): unknown;
}

/**
 * One kind's entry. `retain` is a FACTORY: a gate holds session state, which
 * does not belong at module scope.
 *
 * Browse tab builders are not registered: their signatures differ. Each kind
 * declares its tabs in its own `ui/browse.ts` (`declareAreaTabs` and
 * siblings), and `src/app/browse-tabs.ts` assembles them.
 */
interface KindAdapter {
  storage: TableStorage;
  resolve: SeriesResolver;
  retain(): RetainGate;
  /** The entity noun a WIDE title line carries for this kind; `detect.ts`
   * refuses a noun no kind claims. */
  wideEntity: string;
  /** The key columns of this kind's LONG export. Absent for Area, whose long
   * export `detect.ts` recognises by its `Name` header check. */
  longSignature?: LongSignature;
  /** Every header this kind's group editor writes, so a saved file drops back
   * in. Two kinds may share one (`Name,Grouping`), so a match asks rather
   * than routes. */
  membershipHeaders: readonly (readonly string[])[];
  /**
   * The Import Dialog tint, from the categorical palette. A cue, never the
   * only channel (the kind is also named in text). Generator skips red, the
   * app's refusal colour.
   */
  tint: string;
  /** What loading this kind makes possible, one line: the Contents panel's
   * column tooltip, which is how a blank column teaches what the app takes. */
  enables: string;
  /** What this kind's group file makes possible: the Contents panel's
   * groups-row tooltip. */
  groupsEnables: string;
  /** The bundle manifest field this kind's group map is saved under. */
  groupsField: string;
  /** The table's counts, read off its own fields: the axis it kept against
   * every column its source carried. Axis widening can add planes the file
   * never had, so this is the kept axis, not the file's alone. */
  counts(table: unknown): TableCounts;
}

// The casts are safe: a slot's `kind` selects the entry, and only that kind's
// table is ever stored at its slot (CaseStore.attachTable).
const REGISTRY: Record<TableKind, KindAdapter> = {
  area: {
    storage: {
      serialize: (table) => serializeAreaTable(table as AreaTable),
      deserialize: (fields, cube) => deserializeAreaTable(fields, cube),
    },
    resolve: resolveAreaSeries,
    retain: createAreaRetainGate,
    wideEntity: AREA_ENTITY,
    membershipHeaders: AREA_EDITOR_CSV,
    tint: CASE_COLORS[0],
    enables: 'Hourly area metrics per Case; area groups sum or weight them.',
    groupsEnables: 'Area groups: sums and weighted means across the areas each group names',
    groupsField: 'groupings',
    counts: (table) => {
      const { sourceColumns, metrics } = table as AreaTable;
      return keptOf(sourceColumns, metrics, 'metrics');
    },
  },
  interface: {
    storage: {
      serialize: (table) => serializeInterfaceTable(table as InterfaceTable),
      deserialize: (fields, cube) => deserializeInterfaceTable(fields, cube),
    },
    resolve: resolveInterfaceSeries,
    retain: createInterfaceRetainGate,
    wideEntity: INTERFACE_ENTITY,
    membershipHeaders: INTERFACE_EDITOR_CSV,
    tint: CASE_COLORS[1],
    enables: 'Hourly interface quantities per Case; with limits, % of range and limit lines.',
    groupsEnables: 'Interface boundaries: members summed in their directions, with summed limits',
    groupsField: 'interfaceGroups',
    counts: (table) => {
      const { sourceColumns, interfaces } = table as InterfaceTable;
      return keptOf(sourceColumns, interfaces, 'entities');
    },
  },
  bus: {
    storage: {
      serialize: (table) => serializeBusTable(table as BusTable),
      deserialize: (fields, cube) => deserializeBusTable(fields, cube),
    },
    resolve: resolveBusSeries,
    retain: createBusRetainGate,
    wideEntity: BUS_ENTITY,
    membershipHeaders: BUS_EDITOR_CSV,
    longSignature: BUS_LONG,
    tint: CASE_COLORS[2],
    enables: 'Hourly bus metrics per Case, such as LMP; bus groups sum the summable ones.',
    groupsEnables: 'Bus groups: sums across the buses each group names',
    groupsField: 'busGroups',
    counts: (table) => {
      const { sourceColumns, buses } = table as BusTable;
      return keptOf(sourceColumns, buses, 'entities');
    },
  },
  generator: {
    storage: {
      serialize: (table) => serializeGeneratorTable(table as GeneratorTable),
      deserialize: (fields, cube) => deserializeGeneratorTable(fields, cube),
    },
    resolve: resolveGeneratorSeries,
    retain: createGeneratorRetainGate,
    wideEntity: GENERATOR_ENTITY,
    membershipHeaders: GENERATOR_EDITOR_CSV,
    longSignature: GENERATOR_LONG,
    tint: CASE_COLORS[4],
    enables: 'Hourly unit metrics per Case; generator groups sum them.',
    groupsEnables: 'Generator groups: sums across the units each group names',
    groupsField: 'generatorGroups',
    counts: (table) => {
      const { sourceColumns, generators } = table as GeneratorTable;
      return keptOf(sourceColumns, generators, 'entities');
    },
  },
};

/** The resolver map `resolveSeries` dispatches on, derived from the registry. */
export const SERIES_RESOLVERS = Object.fromEntries(
  Object.entries(REGISTRY).map(([kind, adapter]) => [kind, adapter.resolve]),
) as Readonly<Record<TableKind, SeriesResolver>>;

/** One retain gate per kind, built once for the session. */
export function createRetainGates(): Readonly<Record<TableKind, RetainGate>> {
  return Object.fromEntries(
    Object.entries(REGISTRY).map(([kind, adapter]) => [kind, adapter.retain()]),
  ) as Readonly<Record<TableKind, RetainGate>>;
}

/** The serializer for a kind name read off disk, or `undefined`. Takes a
 * `string`: a bundle key from another build must not be narrowed by guess. */
export function tableKindEntry(kind: string): TableStorage | undefined {
  return REGISTRY[kind as TableKind]?.storage;
}

/** Wide title-line entity words and their kinds, for `detect.ts`. */
export const WIDE_ENTITIES: readonly { entity: string; kind: TableKind }[] = Object.entries(
  REGISTRY,
).map(([kind, adapter]) => ({ entity: adapter.wideEntity, kind: kind as TableKind }));

/** Kinds with a long-shape key signature; `detect.ts` decides match order. */
export const LONG_SIGNATURES: readonly { kind: TableKind; sig: LongSignature }[] = Object.entries(
  REGISTRY,
)
  .filter(([, adapter]) => adapter.longSignature !== undefined)
  .map(([kind, adapter]) => ({
    kind: kind as TableKind,
    sig: adapter.longSignature as LongSignature,
  }));

/** Every editor header and its kind. One header may map to two kinds; the
 * classifier reports all matches and picks none. */
export const MEMBERSHIP_HEADERS: readonly { kind: TableKind; columns: readonly string[] }[] =
  Object.entries(REGISTRY).flatMap(([kind, adapter]) =>
    adapter.membershipHeaders.map((columns) => ({ kind: kind as TableKind, columns })),
  );

/** Every registered kind as a value; a kind must be registered to compile. */
export const TABLE_KINDS: readonly TableKind[] = Object.keys(REGISTRY) as TableKind[];

/** The per-kind tint, derived so a kind cannot be registered without one. */
export const KIND_COLORS = Object.fromEntries(
  Object.entries(REGISTRY).map(([kind, adapter]) => [kind, adapter.tint]),
) as Readonly<Record<TableKind, string>>;

/** Each kind's "what it enables" line, derived so none can be registered
 * without one. */
export const KIND_ENABLES = Object.fromEntries(
  Object.entries(REGISTRY).map(([kind, adapter]) => [kind, adapter.enables]),
) as Readonly<Record<TableKind, string>>;

/** Each kind's group-file line, derived the same way. */
export const GROUPS_ENABLES = Object.fromEntries(
  Object.entries(REGISTRY).map(([kind, adapter]) => [kind, adapter.groupsEnables]),
) as Readonly<Record<TableKind, string>>;

/** Each kind's group-map manifest field, derived the same way. */
export const GROUPS_FIELDS = Object.fromEntries(
  Object.entries(REGISTRY).map(([kind, adapter]) => [kind, adapter.groupsField]),
) as Readonly<Record<TableKind, string>>;

/** A restored table's counts, or null for a kind this build has no entry for. */
export function tableCounts(kind: string, table: unknown): TableCounts | null {
  return REGISTRY[kind as TableKind]?.counts(table) ?? null;
}
