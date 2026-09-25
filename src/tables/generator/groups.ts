// src/tables/generator/groups.ts
//
// The session-wide generator group map (group -> unit NAME keys), loaded from
// a membership CSV through an explicit column mapping, and its bundle shape.
//
// Separate from src/lookups/groupings.ts because the key set differs: area
// membership keys on the cube's own axis, while generator membership keys on
// GeneratorList's `Name`, which is replaced wholesale when another list is
// dropped, and (bus, unit) rows must be resolved to names first. So no view
// of the key set is cached here; every list-relative question takes the names
// as an argument.
//
// Rows naming units this study lacks are KEPT AND FLAGGED, never dropped: a
// grouping written for a bigger study is worth keeping. A (bus, unit) row that
// resolves to no name is kept beside the map with its reason.
//
// Membership is many-to-many, so summing group sizes double-counts the fleet;
// nothing here reports a summed membership.

import { splitCsvLine } from '../../lookups/parse';
import type { LookupTable } from '../../lookups/types';
import {
  BUS_ID_COLUMN,
  UNIT_ID_COLUMN,
  generatorKeyIndex,
  resolveMembershipKey,
  type GeneratorKeyIndex,
  type MembershipKey,
} from './resolve';

/**
 * The `groupBy` marker of a generator-GROUP subject. Spelled with a space and
 * a capital so it can never be mistaken for a GeneratorList column.
 */
export const GENERATOR_GROUP_BY = 'Injection Group';

/**
 * The mapping the editor's own file shape implies: provenance for hand-built
 * groups, since a bundle must say where its membership came from. It names
 * only the key and group; the optional `Bus ID`/`Unit ID` columns the editor
 * may write are not read by it (see `editorCsvShape`).
 */
export const EDITOR_MAPPING: GeneratorGroupMapping = {
  key: { by: 'name', nameColumn: 'Name' },
  groupColumn: 'Grouping',
};

/** One unit's `Bus ID` and `Unit ID` as the loaded list spells them. A missing
 * half is '' (reads back as absent), never a placeholder that reads as an id. */
export interface UnitIdentifiers {
  bus: string;
  unit: string;
}

/** The editor's "Save CSV…" header and rows, from one call so they agree. */
export interface EditorCsvShape {
  columns: string[];
  row(name: string, identifiers: UnitIdentifiers | undefined, group: string): string[];
  /** A kept (bus, unit) row with no name. Only asked for in the shape that
   * carries the pair; the other shape refuses instead. */
  keptRow(busId: string, unitId: string, group: string): string[];
}

/**
 * The editor file's shape. With a GeneratorList loaded it carries `Bus ID`
 * and `Unit ID` beside the name, so the grouping can be re-keyed against a
 * study that spells names differently. Without one it is `Name,Grouping`:
 * blank id columns would promise an identity the session cannot supply.
 */
export function editorCsvShape(withIdentifiers: boolean): EditorCsvShape {
  const nameColumn = EDITOR_MAPPING.key.by === 'name' ? EDITOR_MAPPING.key.nameColumn : '';
  if (!withIdentifiers) {
    return {
      columns: [nameColumn, EDITOR_MAPPING.groupColumn],
      row: (name, _identifiers, group) => [name, group],
      keptRow: () => {
        throw new Error(
          'A kept bus number and unit ID cannot be written to a file with no columns for them.',
        );
      },
    };
  }
  return {
    columns: [nameColumn, BUS_ID_COLUMN, UNIT_ID_COLUMN, EDITOR_MAPPING.groupColumn],
    row: (name, identifiers, group) => [
      name,
      identifiers?.bus ?? '',
      identifiers?.unit ?? '',
      group,
    ],
    keptRow: (busId, unitId, group) => ['', busId, unitId, group],
  };
}

/** Both headers `editorCsvShape` may write, for the drop classifier. */
export const EDITOR_CSV_HEADERS: readonly (readonly string[])[] = [
  editorCsvShape(false).columns,
  editorCsvShape(true).columns,
];

/** Which columns name a unit, one form per resolver input. Cells stay the
 * file's own text; normalising is the resolver's job. */
export type MembershipColumns =
  /** The GeneratorList `Name` column, the app's own key. */
  | { by: 'name'; nameColumn: string }
  /** `Bus ID` and `Unit ID`: resolvable only against a loaded GeneratorList. */
  | { by: 'bus-unit'; busColumn: string; unitColumn: string };

/** Which column is the group and which name a unit: the user's one free
 * choice, saved with the map so a reload can say where membership came from. */
export interface GeneratorGroupMapping {
  key: MembershipColumns;
  groupColumn: string;
}

/** A (bus, unit) row that resolved to no name, kept with its cells so the
 * group it named does not silently shrink. */
export interface UnresolvedPairRow {
  group: string;
  busId: string;
  unitId: string;
  reason: string;
}

// ------------------------------------------------------------- the map

/** group -> member name keys, insertion order. Members need not be in any
 * loaded list. Empty until a file or bundle fills it: a utility's grouping is
 * the user's own analysis and is never built in. */
let groupToUnits = new Map<string, string[]>();
/** Rows kept beside the map, in file order. */
let unresolvedPairRows: readonly UnresolvedPairRow[] = [];
let chosenMapping: GeneratorGroupMapping | undefined;

export function hasGeneratorGroups(): boolean {
  return groupToUnits.size > 0;
}

export function generatorGroupNames(): string[] {
  return Array.from(groupToUnits.keys());
}

export function unitsInGroup(group: string): string[] {
  return (groupToUnits.get(group.trim()) ?? []).slice();
}

export function unresolvedMembershipRows(): readonly UnresolvedPairRow[] {
  return unresolvedPairRows;
}

export function chosenGroupMapping(): GeneratorGroupMapping | undefined {
  return chosenMapping;
}

// ------------------------------------------------------------- summary

export interface GeneratorGroupsSummary {
  groups: number;
  /** Distinct member names the given units carry. */
  mapped: number;
  /** Member names the given units lack: kept and flagged. */
  offList: string[];
  /** Units no group names. They are still plottable on their own. */
  unmapped: string[];
}

/**
 * What the loaded membership covers, against a unit set the CALLER supplies
 * (never cached, since a new list replaces it). `undefined` reports no
 * coverage rather than flagging every name against an empty set.
 */
export function summarizeGeneratorGroups(
  units: readonly string[] | undefined,
): GeneratorGroupsSummary {
  const named = new Set<string>();
  for (const names of groupToUnits.values()) for (const name of names) named.add(name);
  if (units === undefined) {
    return { groups: groupToUnits.size, mapped: 0, offList: [], unmapped: [] };
  }
  const carried = new Set(units);
  return {
    groups: groupToUnits.size,
    mapped: [...named].filter((name) => carried.has(name)).length,
    offList: [...named].filter((name) => !carried.has(name)),
    unmapped: units.filter((unit) => !named.has(unit)),
  };
}

// ------------------------------------------------------------- ingest

/** One refusal reason and how many rows it refused. */
export interface RefusalCount {
  reason: string;
  rows: number;
}

/** A file resolved into membership, kept rows and refusal counts, before any
 * state moves. Applying it is the caller's decision. */
export interface GeneratorGroupsPlan {
  /** group -> member name keys, insertion order. */
  members: Map<string, string[]>;
  /** (bus, unit) rows kept beside the map, in file order. */
  kept: UnresolvedPairRow[];
  /** Distinct (unit, group) pairs: never a unit count. */
  memberships: number;
  /** Rows kept unresolved: flagged names in the map, and (bus, unit) rows
   * beside it. */
  unresolved: number;
  /** Refused rows by reason. Counted, because a silently vanished row is a
   * silently shrunk group. */
  refusals: RefusalCount[];
}

function countRefusal(refusals: RefusalCount[], reason: string): void {
  const held = refusals.find((entry) => entry.reason === reason);
  if (held) held.rows++;
  else refusals.push({ reason, rows: 1 });
}

function addMember(map: Map<string, string[]>, name: string, group: string): void {
  const members = map.get(group);
  if (!members) map.set(group, [name]);
  else if (!members.includes(name)) members.push(name);
}

function unitNamesOf(index: GeneratorKeyIndex | undefined): string[] | undefined {
  return index === undefined ? undefined : Array.from(index.list.index.keys(), String);
}

/**
 * The list index a mapping needs. A list without `Bus ID`/`Unit ID` still
 * resolves NAMES, so a name mapping gets undefined; a (bus, unit) mapping
 * rethrows the index's refusal so the caller names the missing columns.
 * No list loaded is undefined either way.
 */
export function indexForMapping(
  list: LookupTable | undefined,
  mapping: GeneratorGroupMapping,
): GeneratorKeyIndex | undefined {
  if (list === undefined) return undefined;
  try {
    return generatorKeyIndex(list);
  } catch (error) {
    if (mapping.key.by === 'bus-unit') throw error;
    return undefined;
  }
}

/**
 * Resolve a groupings CSV through a column mapping WITHOUT touching the
 * loaded map: the editor's "Load CSV…" path. `index` is the loaded list, or
 * undefined (legal for a name-keyed file). Refuses the whole file when a
 * mapped column is missing, a pair mapping has no list, or no row resolved.
 */
export function planGeneratorGroups(
  csv: string,
  mapping: GeneratorGroupMapping,
  index: GeneratorKeyIndex | undefined,
): GeneratorGroupsPlan {
  if (mapping.key.by === 'bus-unit' && index === undefined) {
    // With no list, refuse the file once, in the resolver's own words, rather
    // than row by row.
    const refusal = resolveMembershipKey(undefined, { by: 'bus-unit', busId: '', unitId: '' });
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
    mapping.key.by === 'name'
      ? { by: 'name' as const, at: columnOf(mapping.key.nameColumn) }
      : {
          by: 'bus-unit' as const,
          busAt: columnOf(mapping.key.busColumn),
          unitAt: columnOf(mapping.key.unitColumn),
        };

  const members = new Map<string, string[]>();
  const kept: UnresolvedPairRow[] = [];
  const refusals: RefusalCount[] = [];
  let unresolved = 0;

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const group = (cells[groupAt] ?? '').trim();
    if (group === '') {
      countRefusal(refusals, 'A row has a blank group cell, so it names no group.');
      continue;
    }
    const key: MembershipKey =
      keyAt.by === 'name'
        ? { by: 'name', name: cells[keyAt.at] ?? '' }
        : { by: 'bus-unit', busId: cells[keyAt.busAt] ?? '', unitId: cells[keyAt.unitAt] ?? '' };
    const resolution = resolveMembershipKey(index, key);
    if (resolution.status === 'refused') {
      countRefusal(refusals, resolution.reason);
      continue;
    }
    if (resolution.status === 'unresolved') {
      unresolved++;
      if (key.by === 'name') {
        // Kept in the map; flagging it is a question about the current list.
        addMember(members, key.name.trim(), group);
      } else {
        kept.push({ group, busId: key.busId, unitId: key.unitId, reason: resolution.reason });
      }
      continue;
    }
    addMember(members, resolution.name, group);
  }

  if (members.size === 0) {
    const why = refusals.map((entry) => `${entry.reason} (${entry.rows} row(s))`).join(' ');
    throw new Error(
      'That file produced no group membership — the mapping was left unchanged.' +
        (why === '' ? '' : ` ${why}`),
    );
  }

  let memberships = 0;
  for (const names of members.values()) memberships += names.length;

  return { members, kept, memberships, unresolved, refusals };
}

/** What a successful load says, beside the plan it committed. */
export interface GeneratorGroupsLoad extends GeneratorGroupsPlan {
  summary: GeneratorGroupsSummary;
}

/**
 * Replace the map from a groupings CSV. The mapping is the caller's: a
 * generator membership file and an area Groupings.csv look alike, so shape
 * cannot decide.
 */
export function loadGeneratorGroups(
  csv: string,
  mapping: GeneratorGroupMapping,
  index: GeneratorKeyIndex | undefined,
): GeneratorGroupsLoad {
  const plan = planGeneratorGroups(csv, mapping, index);
  groupToUnits = plan.members;
  unresolvedPairRows = plan.kept;
  chosenMapping = mapping;
  return { ...plan, summary: summarizeGeneratorGroups(unitNamesOf(index)) };
}

/**
 * Replace the map from the editor. Kept (bus, unit) rows ride along, and the
 * provenance stays the source mapping, or the editor's shape if none.
 */
export function setGeneratorMembership(
  members: ReadonlyMap<string, readonly string[]>,
  unresolved: readonly UnresolvedPairRow[] = [],
): void {
  if (members.size === 0) {
    throw new Error('That leaves no groups — the mapping was left unchanged.');
  }
  groupToUnits = new Map([...members].map(([group, names]) => [group, [...names]]));
  unresolvedPairRows = unresolved.map((row) => ({ ...row }));
  if (chosenMapping === undefined) chosenMapping = EDITOR_MAPPING;
}

// ---------------------------------------------------------- persistence

/** The bundle shape: membership, kept rows, and the mapping that made them. */
export interface SavedGeneratorGroups {
  mapping: GeneratorGroupMapping;
  /** group -> member names, as pair arrays so order survives JSON. */
  members: [string, string[]][];
  unresolved: UnresolvedPairRow[];
}

export function exportGeneratorGroups(): SavedGeneratorGroups | null {
  if (groupToUnits.size === 0) return null;
  if (chosenMapping === undefined) {
    // Load and adopt both record a mapping, so this is a wiring bug.
    throw new Error('Generator groups are loaded with no column mapping recorded for them.');
  }
  return {
    mapping: chosenMapping,
    members: Array.from(groupToUnits, ([group, names]) => [group, names.slice()]),
    unresolved: unresolvedPairRows.map((row) => ({ ...row })),
  };
}

function readString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`the saved ${what} is not text.`);
  return value;
}

/** Validate and copy a saved map, strictly: a half-read membership is a
 * silently shrunk fleet, worse than refusing the field. */
export function readSavedGeneratorGroups(raw: unknown): SavedGeneratorGroups {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('the saved generator group membership is not an object.');
  }
  const record = raw as Record<string, unknown>;

  const rawMapping = record.mapping;
  if (rawMapping === null || typeof rawMapping !== 'object' || Array.isArray(rawMapping)) {
    throw new Error('the saved column mapping is not an object.');
  }
  const mappingRecord = rawMapping as Record<string, unknown>;
  const rawKey = mappingRecord.key;
  if (rawKey === null || typeof rawKey !== 'object' || Array.isArray(rawKey)) {
    throw new Error('the saved column mapping has no key columns.');
  }
  const keyRecord = rawKey as Record<string, unknown>;
  const by = readString(keyRecord.by, 'key form');
  let mapping: GeneratorGroupMapping;
  if (by === 'name') {
    mapping = {
      key: { by: 'name', nameColumn: readString(keyRecord.nameColumn, 'name column') },
      groupColumn: readString(mappingRecord.groupColumn, 'group column'),
    };
  } else if (by === 'bus-unit') {
    mapping = {
      key: {
        by: 'bus-unit',
        busColumn: readString(keyRecord.busColumn, 'bus column'),
        unitColumn: readString(keyRecord.unitColumn, 'unit column'),
      },
      groupColumn: readString(mappingRecord.groupColumn, 'group column'),
    };
  } else {
    throw new Error(`the saved key form "${by}" is neither "name" nor "bus-unit".`);
  }

  if (!Array.isArray(record.members)) {
    throw new Error('the saved membership list is not a list.');
  }
  const members: [string, string[]][] = record.members.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2 || !Array.isArray(entry[1])) {
      throw new Error('a saved membership entry is not a group with its member list.');
    }
    return [
      readString(entry[0], 'group name'),
      entry[1].map((name) => readString(name, 'member name')),
    ];
  });

  if (!Array.isArray(record.unresolved)) {
    throw new Error('the saved kept-unresolved row list is not a list.');
  }
  const unresolved: UnresolvedPairRow[] = record.unresolved.map((row) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('a saved kept-unresolved row is not an object.');
    }
    const fields = row as Record<string, unknown>;
    return {
      group: readString(fields.group, 'kept row group'),
      busId: readString(fields.busId, 'kept row bus number cell'),
      unitId: readString(fields.unitId, 'kept row unit id cell'),
      reason: readString(fields.reason, 'kept row reason'),
    };
  });

  return { mapping, members, unresolved };
}

/** Restore the map from a bundle, replacing (not merging) the session's. */
export function adoptGeneratorGroups(raw: unknown): void {
  const saved = readSavedGeneratorGroups(raw);
  groupToUnits = new Map(saved.members.map(([group, names]) => [group, names.slice()]));
  unresolvedPairRows = saved.unresolved.map((row) => ({ ...row }));
  chosenMapping = saved.mapping;
}

/** Tests only: nothing in the app clears this session state. */
export function clearGeneratorGroups(): void {
  groupToUnits = new Map();
  unresolvedPairRows = [];
  chosenMapping = undefined;
}
