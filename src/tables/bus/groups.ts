// src/tables/bus/groups.ts
//
// The session-wide bus group map: group -> bus NUMBER keys. What it shares
// with `src/tables/generator/groups.ts` is stated there; this states what the
// key changes.
//
// THE KEY IS A NUMBER, and must not be "tidied" into a name. Two buses may
// share a name, so the stored key is the `BusID` the cube axis uses, and a
// name-keyed file is resolved to ids at load. A name two BusList rows carry
// resolves to NEITHER and is kept beside the map with both ids in its reason.
//
// The key type is why this is a separate map from the area and generator
// ones: merging them would make every reader dispatch on the key's type. It
// also decides the unresolved cases: an id this study lacks stays IN the map
// (it is already the stored form), while an unresolved name is kept BESIDE it.
// There is no `resolve.ts` here: one integer parse against a unique column
// does not need a module.

import { cellValue } from '../../lookups/merge';
import { splitCsvLine } from '../../lookups/parse';
import { BUS_LIST } from '../../lookups/schema';
import type { LookupTable } from '../../lookups/types';

/** The `groupBy` marker of a bus-GROUP subject. Spelled with a space and a
 * capital so it can never be mistaken for a BusList column. */
export const BUS_GROUP_BY = 'Bus Group';

/** The BusList column a name-keyed membership file resolves through. */
const NAME_COLUMN = 'Name';

/** What the editor's "Save CSV…" writes: reloading it reproduces the map, and
 * it is the provenance of a hand-built one. */
export const EDITOR_MAPPING: BusGroupMapping = {
  key: { by: 'id', idColumn: BUS_LIST.keyColumn },
  groupColumn: 'Grouping',
};

/** Every header the editor may write, spelled from `EDITOR_MAPPING`, for the
 * drop classifier. */
export const EDITOR_CSV_HEADERS: readonly (readonly string[])[] = [
  [EDITOR_MAPPING.key.by === 'id' ? EDITOR_MAPPING.key.idColumn : '', EDITOR_MAPPING.groupColumn],
];

/** Which column names a bus. Cells stay the file's own text; parsing is this
 * module's job. */
export type BusMembershipColumns =
  /** A `BusID` column: the app's key, resolvable with no list. */
  | { by: 'id'; idColumn: string }
  /** A bus `Name` column: needs a loaded BusList, and a unique name in it. */
  | { by: 'name'; nameColumn: string };

/** Which column is the group and which names a bus, saved with the map (see
 * `GeneratorGroupMapping`). */
export interface BusGroupMapping {
  key: BusMembershipColumns;
  groupColumn: string;
}

/** A name row that resolved to no single id, kept with its cell so the group
 * does not silently shrink. */
export interface UnresolvedNameRow {
  group: string;
  name: string;
  reason: string;
}

// ------------------------------------------------------------- the map

/** group -> member bus ids, insertion order. Members need not be in any list.
 * Empty until a file or bundle fills it; a utility's grouping is never built
 * in. */
let groupToBuses = new Map<string, number[]>();
/** Rows kept beside the map, in file order. */
let unresolvedNameRows: readonly UnresolvedNameRow[] = [];
let chosenMapping: BusGroupMapping | undefined;

export function hasBusGroups(): boolean {
  return groupToBuses.size > 0;
}

export function busGroupNames(): string[] {
  return Array.from(groupToBuses.keys());
}

export function busesInGroup(group: string): number[] {
  return (groupToBuses.get(group.trim()) ?? []).slice();
}

export function unresolvedBusMembershipRows(): readonly UnresolvedNameRow[] {
  return unresolvedNameRows;
}

export function chosenBusGroupMapping(): BusGroupMapping | undefined {
  return chosenMapping;
}

// ------------------------------------------------------------- resolve

/**
 * The BusList as this module joins against it: id -> row for off-list flags,
 * and name -> ALL ids carrying it, so an ambiguous name is visible rather than
 * silently resolved to the first row.
 */
export interface BusKeyIndex {
  list: LookupTable;
  ids: ReadonlySet<number>;
  byName: ReadonlyMap<string, number[]>;
}

export function busKeyIndex(list: LookupTable): BusKeyIndex {
  const keyIndex = list.byName.get(BUS_LIST.keyColumn);
  if (keyIndex === undefined) {
    throw new Error(
      `${BUS_LIST.banner} carries no "${BUS_LIST.keyColumn}" column, so a bus membership file ` +
        'has nothing to resolve against.',
    );
  }
  const keyColumn = list.columns[keyIndex];
  const nameIndex = list.byName.get(NAME_COLUMN);
  const nameColumn = nameIndex === undefined ? undefined : list.columns[nameIndex];

  const ids = new Set<number>();
  const byName = new Map<string, number[]>();
  for (let row = 0; row < list.rowCount; row++) {
    const id = cellValue(keyColumn, row);
    if (typeof id !== 'number') continue;
    ids.add(id);
    if (!nameColumn) continue;
    const name = cellValue(nameColumn, row);
    if (typeof name !== 'string') continue;
    const key = name.trim().toUpperCase();
    if (key === '') continue;
    const held = byName.get(key);
    if (held) {
      if (!held.includes(id)) held.push(id);
    } else byName.set(key, [id]);
  }
  return { list, ids, byName };
}

/** A membership file's key cell, as the file wrote it. */
export type BusMembershipKey = { by: 'id'; id: string } | { by: 'name'; name: string };

export type BusResolution =
  /** A bus id the map can be keyed on. */
  | { status: 'resolved'; id: number }
  /** No id: the caller keeps the row beside the map and flags it. */
  | { status: 'unresolved'; reason: string }
  /** The cell is not a key at all; the row is counted and dropped. */
  | { status: 'refused'; reason: string };

/**
 * One membership key as a bus id. A non-integer id cell is REFUSED (a NaN key
 * would read as a missing bus). A name with no list, or on two rows, comes
 * back unresolved: worth keeping, not worth guessing.
 */
export function resolveBusMembershipKey(
  index: BusKeyIndex | undefined,
  key: BusMembershipKey,
): BusResolution {
  if (key.by === 'id') {
    const text = key.id.trim();
    if (text === '') return { status: 'refused', reason: 'A row has a blank bus number cell.' };
    const id = Number(text);
    if (!Number.isInteger(id)) {
      return { status: 'refused', reason: `"${text}" is not a bus number.` };
    }
    return { status: 'resolved', id };
  }

  const name = key.name.trim();
  if (name === '') return { status: 'refused', reason: 'A row has a blank bus name cell.' };
  if (index === undefined) {
    return {
      status: 'refused',
      reason:
        `A name-keyed bus membership file needs ${BUS_LIST.banner} loaded: a bus name is a ` +
        'label and only the list can say which bus number it is.',
    };
  }
  const ids = index.byName.get(name.toUpperCase());
  if (ids === undefined || ids.length === 0) {
    return { status: 'unresolved', reason: `${BUS_LIST.banner} carries no bus named "${name}".` };
  }
  if (ids.length > 1) {
    return {
      status: 'unresolved',
      reason:
        `"${name}" names ${ids.length} buses in ${BUS_LIST.banner} (${ids.join(', ')}), so the ` +
        'row names no single bus. Key the file on bus number instead.',
    };
  }
  return { status: 'resolved', id: ids[0] };
}

// ------------------------------------------------------------- summary

export interface BusGroupsSummary {
  groups: number;
  /** Distinct member ids the given bus set carries. */
  mapped: number;
  /** Member ids the given set lacks: kept and flagged. */
  offList: number[];
  /** Buses no group names. They are still plottable on their own. */
  unmapped: number[];
}

/**
 * Coverage against a bus set the CALLER supplies (never cached; a new
 * BusList replaces it). `undefined` reports no coverage rather than flagging
 * every id against an empty set.
 */
export function summarizeBusGroups(buses: readonly number[] | undefined): BusGroupsSummary {
  const named = new Set<number>();
  for (const ids of groupToBuses.values()) for (const id of ids) named.add(id);
  if (buses === undefined) {
    return { groups: groupToBuses.size, mapped: 0, offList: [], unmapped: [] };
  }
  const carried = new Set(buses);
  return {
    groups: groupToBuses.size,
    mapped: [...named].filter((id) => carried.has(id)).length,
    offList: [...named].filter((id) => !carried.has(id)),
    unmapped: buses.filter((id) => !named.has(id)),
  };
}

// ------------------------------------------------------------- ingest

/** One refusal reason and how many rows it refused. */
export interface RefusalCount {
  reason: string;
  rows: number;
}

/** A file resolved into membership, kept rows and refusal counts, before any
 * state moves (see `GeneratorGroupsPlan`). */
export interface BusGroupsPlan {
  /** group -> member bus ids, insertion order. */
  members: Map<string, number[]>;
  /** Name rows kept beside the map, in file order. */
  kept: UnresolvedNameRow[];
  /** Distinct (bus, group) pairs: never a bus count. */
  memberships: number;
  /** Rows kept unresolved beside the map. */
  unresolved: number;
  /** Refused rows by reason: counted so a group never shrinks silently. */
  refusals: RefusalCount[];
}

function countRefusal(refusals: RefusalCount[], reason: string): void {
  const held = refusals.find((entry) => entry.reason === reason);
  if (held) held.rows++;
  else refusals.push({ reason, rows: 1 });
}

function addMember(map: Map<string, number[]>, id: number, group: string): void {
  const members = map.get(group);
  if (!members) map.set(group, [id]);
  else if (!members.includes(id)) members.push(id);
}

/** The list index a mapping needs. A list without `Name` still resolves ids;
 * a name mapping with no list is undefined, which `planBusGroups` refuses
 * once for the file. */
export function indexForBusMapping(list: LookupTable | undefined): BusKeyIndex | undefined {
  if (list === undefined) return undefined;
  return busKeyIndex(list);
}

/** Resolve a membership CSV WITHOUT touching the loaded map: the editor's
 * "Load CSV…" path. */
export function planBusGroups(
  csv: string,
  mapping: BusGroupMapping,
  index: BusKeyIndex | undefined,
): BusGroupsPlan {
  if (mapping.key.by === 'name' && index === undefined) {
    // One file-level refusal, in the resolver's words.
    const refusal = resolveBusMembershipKey(undefined, { by: 'name', name: 'x' });
    if (refusal.status === 'refused') throw new Error(refusal.reason);
  }

  const lines = csv.split(/\r?\n/).filter((line) => line.trim() !== '');
  const header = splitCsvLine(lines[0] ?? '').map((cell) => cell.trim());
  const columnOf = (name: string): number => {
    const at = header.indexOf(name);
    if (at < 0) {
      throw new Error(
        `The mapping names a "${name}" column this file does not carry. Its columns read: ` +
          `${header.length === 0 ? '(none)' : header.join(', ')}.`,
      );
    }
    return at;
  };

  const groupAt = columnOf(mapping.groupColumn);
  const keyAt =
    mapping.key.by === 'id'
      ? { by: 'id' as const, at: columnOf(mapping.key.idColumn) }
      : { by: 'name' as const, at: columnOf(mapping.key.nameColumn) };

  const members = new Map<string, number[]>();
  const kept: UnresolvedNameRow[] = [];
  const refusals: RefusalCount[] = [];
  let unresolved = 0;

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const group = (cells[groupAt] ?? '').trim();
    if (group === '') {
      countRefusal(refusals, 'A row has a blank group cell, so it names no group.');
      continue;
    }
    const cell = cells[keyAt.at] ?? '';
    const key: BusMembershipKey =
      keyAt.by === 'id' ? { by: 'id', id: cell } : { by: 'name', name: cell };
    const resolution = resolveBusMembershipKey(index, key);
    if (resolution.status === 'refused') {
      countRefusal(refusals, resolution.reason);
      continue;
    }
    if (resolution.status === 'unresolved') {
      unresolved++;
      kept.push({ group, name: cell.trim(), reason: resolution.reason });
      continue;
    }
    addMember(members, resolution.id, group);
  }

  if (members.size === 0) {
    const why = refusals.map((entry) => `${entry.reason} (${entry.rows} row(s))`).join(' ');
    throw new Error(
      'That file produced no group membership — the mapping was left unchanged.' +
        (why === '' ? '' : ` ${why}`),
    );
  }

  let memberships = 0;
  for (const ids of members.values()) memberships += ids.length;

  return { members, kept, memberships, unresolved, refusals };
}

/** What a successful load says, beside the plan it committed. */
export interface BusGroupsLoad extends BusGroupsPlan {
  summary: BusGroupsSummary;
}

/** Replace the map from a membership CSV through the caller's mapping; key
 * and group files look alike, so shape cannot decide. */
export function loadBusGroups(
  csv: string,
  mapping: BusGroupMapping,
  index: BusKeyIndex | undefined,
): BusGroupsLoad {
  const plan = planBusGroups(csv, mapping, index);
  groupToBuses = plan.members;
  unresolvedNameRows = plan.kept;
  chosenMapping = mapping;
  return { ...plan, summary: summarizeBusGroups(index && [...index.ids]) };
}

/** Replace the map from the editor; kept name rows ride along and the
 * provenance is kept (see `setGeneratorMembership`). */
export function setBusMembership(
  members: ReadonlyMap<string, readonly number[]>,
  unresolved: readonly UnresolvedNameRow[] = [],
): void {
  if (members.size === 0) {
    throw new Error('That leaves no groups — the mapping was left unchanged.');
  }
  groupToBuses = new Map([...members].map(([group, ids]) => [group, [...ids]]));
  unresolvedNameRows = unresolved.map((row) => ({ ...row }));
  if (chosenMapping === undefined) chosenMapping = EDITOR_MAPPING;
}

// ---------------------------------------------------------- persistence

/** The bundle shape: as `SavedGeneratorGroups`, but with ids and name rows. */
export interface SavedBusGroups {
  mapping: BusGroupMapping;
  /** group -> member bus ids, as pair arrays so order survives JSON. */
  members: [string, number[]][];
  unresolved: UnresolvedNameRow[];
}

export function exportBusGroups(): SavedBusGroups | null {
  if (groupToBuses.size === 0) return null;
  if (chosenMapping === undefined) {
    // A wiring bug, not a user state.
    throw new Error('Bus groups are loaded with no column mapping recorded for them.');
  }
  return {
    mapping: chosenMapping,
    members: Array.from(groupToBuses, ([group, ids]) => [group, ids.slice()]),
    unresolved: unresolvedNameRows.map((row) => ({ ...row })),
  };
}

function readString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`the saved ${what} is not text.`);
  return value;
}

function readId(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`the saved ${what} is not a bus number.`);
  }
  return value;
}

/** Validate and copy a saved map, strictly. */
export function readSavedBusGroups(raw: unknown): SavedBusGroups {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('the saved bus group membership is not an object.');
  }
  const record = raw as Record<string, unknown>;

  const rawMapping = record.mapping;
  if (rawMapping === null || typeof rawMapping !== 'object' || Array.isArray(rawMapping)) {
    throw new Error('the saved column mapping is not an object.');
  }
  const mappingRecord = rawMapping as Record<string, unknown>;
  const rawKey = mappingRecord.key;
  if (rawKey === null || typeof rawKey !== 'object' || Array.isArray(rawKey)) {
    throw new Error('the saved column mapping has no key column.');
  }
  const keyRecord = rawKey as Record<string, unknown>;
  const by = readString(keyRecord.by, 'key form');
  let mapping: BusGroupMapping;
  if (by === 'id') {
    mapping = {
      key: { by: 'id', idColumn: readString(keyRecord.idColumn, 'bus number column') },
      groupColumn: readString(mappingRecord.groupColumn, 'group column'),
    };
  } else if (by === 'name') {
    mapping = {
      key: { by: 'name', nameColumn: readString(keyRecord.nameColumn, 'bus name column') },
      groupColumn: readString(mappingRecord.groupColumn, 'group column'),
    };
  } else {
    throw new Error(`the saved key form "${by}" is neither "id" nor "name".`);
  }

  if (!Array.isArray(record.members)) {
    throw new Error('the saved membership list is not a list.');
  }
  const members: [string, number[]][] = record.members.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2 || !Array.isArray(entry[1])) {
      throw new Error('a saved membership entry is not a group with its member list.');
    }
    return [readString(entry[0], 'group name'), entry[1].map((id) => readId(id, 'member bus'))];
  });

  if (!Array.isArray(record.unresolved)) {
    throw new Error('the saved kept-unresolved row list is not a list.');
  }
  const unresolved: UnresolvedNameRow[] = record.unresolved.map((row) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('a saved kept-unresolved row is not an object.');
    }
    const fields = row as Record<string, unknown>;
    return {
      group: readString(fields.group, 'kept row group'),
      name: readString(fields.name, 'kept row bus name cell'),
      reason: readString(fields.reason, 'kept row reason'),
    };
  });

  return { mapping, members, unresolved };
}

/** Restore the map from a bundle, replacing (not merging) the session's. */
export function adoptBusGroups(raw: unknown): void {
  const saved = readSavedBusGroups(raw);
  groupToBuses = new Map(saved.members.map(([group, ids]) => [group, ids.slice()]));
  unresolvedNameRows = saved.unresolved.map((row) => ({ ...row }));
  chosenMapping = saved.mapping;
}

/** Tests only. */
export function clearBusGroups(): void {
  groupToBuses = new Map();
  unresolvedNameRows = [];
  chosenMapping = undefined;
}
