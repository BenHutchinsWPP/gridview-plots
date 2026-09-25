// src/tables/interface/groups.ts
//
// The session-wide interface group map: group -> member interfaces, each with
// the DIRECTION it counts in. What it shares with the bus and generator maps
// is stated in `src/tables/generator/groups.ts`.
//
// A MEMBER IS A NAME AND A SIGN. A path exported A→B and one exported
// B→A carry the same physics with opposite signs, so summing them as
// exported measures nothing. `signOf` turns a direction into ±1 for
// `reduceSignedMembers`.
//
// The words are "direction", "forward", "reversed": "invert" reads as a
// reciprocal and "negate" names the arithmetic, not the analyst's decision.
//
// THE DIRECTION IS THE GROUP'S, NOT THE VARIABLE'S, and applies to every
// quantity, including ones with no direction (a reversed member subtracts a
// congestion cost). Never drop the sign silently; `isDirectional` in
// `rules.ts` is what the UI consults to say so.
//
// The key is the interface NAME (the cube axis). There is no id row and no
// list file, so there is no resolver and no kept-unresolved rows.

import { splitCsvLine } from '../../lookups/parse';

/** The `groupBy` marker of an interface-GROUP subject (see `BUS_GROUP_BY`). */
export const INTERFACE_GROUP_BY = 'Interface Group';

/** How a member counts into its group's sum. */
export type Direction = 'forward' | 'reversed';

/** The multiplier a direction is, which is what reaches the reduce. */
export function signOf(direction: Direction): number {
  return direction === 'reversed' ? -1 : 1;
}

/** One member of one group: the interface, and the direction it counts in. */
export interface InterfaceMember {
  name: string;
  direction: Direction;
}

/** What the editor's "Save CSV…" writes, directions included, and the
 * provenance of a hand-built map. */
export const EDITOR_MAPPING: InterfaceGroupMapping = {
  nameColumn: 'Name',
  groupColumn: 'Grouping',
  directionColumn: 'Direction',
};

/** Every header the editor may write, including the direction column (without
 * which a saved file reloads as a plain sum), for the drop classifier. */
export const EDITOR_CSV_HEADERS: readonly (readonly string[])[] = [
  [EDITOR_MAPPING.nameColumn, EDITOR_MAPPING.groupColumn, EDITOR_MAPPING.directionColumn ?? ''],
];

/** Which columns hold which role. `directionColumn` is optional: without it
 * every member is `forward`, the file as exported. A reversed member is a
 * decision and is never inferred. */
export interface InterfaceGroupMapping {
  nameColumn: string;
  groupColumn: string;
  directionColumn?: string;
}

/**
 * The cells a direction column may carry: a STATED list, matched trimmed and
 * case-insensitively. Anything else refuses the row, quoting the cell: a
 * misread direction turns a sum into a difference that looks real. A blank
 * cell is `forward`.
 */
const REVERSED_CELLS = new Set(['-1', '-', 'reverse', 'reversed', 'rev', 'r', 'negative']);
const FORWARD_CELLS = new Set(['', '1', '+1', '+', 'forward', 'fwd', 'f', 'positive']);

/** The direction a cell states, or undefined when it states neither. */
export function directionOf(cell: string): Direction | undefined {
  const text = cell.trim().toLowerCase();
  if (REVERSED_CELLS.has(text)) return 'reversed';
  if (FORWARD_CELLS.has(text)) return 'forward';
  return undefined;
}

/** Every accepted spelling, for the mapping pane to show up front. */
export function directionSpellings(): { forward: string[]; reversed: string[] } {
  return {
    forward: [...FORWARD_CELLS].filter((cell) => cell !== ''),
    reversed: [...REVERSED_CELLS],
  };
}

// ------------------------------------------------------------- the map

/** group -> members, insertion order. Empty until a file or bundle fills it:
 * a utility's boundaries are never built in. */
let groupToInterfaces = new Map<string, InterfaceMember[]>();
let chosenMapping: InterfaceGroupMapping | undefined;

export function hasInterfaceGroups(): boolean {
  return groupToInterfaces.size > 0;
}

export function interfaceGroupNames(): string[] {
  return Array.from(groupToInterfaces.keys());
}

export function membersOfGroup(group: string): InterfaceMember[] {
  return (groupToInterfaces.get(group.trim()) ?? []).map((member) => ({ ...member }));
}

/** The group's members as the reduce takes them: name -> +1 or -1. */
export function coefficientsOfGroup(group: string): Map<string | number, number> {
  const out = new Map<string | number, number>();
  for (const member of groupToInterfaces.get(group.trim()) ?? []) {
    out.set(member.name, signOf(member.direction));
  }
  return out;
}

/** `coefficientsOfGroup` narrowed to a pin's frozen members. The signs still
 * come from the map: a frozen set freezes membership, never direction. */
export function boundaryCoefficients(
  group: string,
  members?: readonly (string | number)[],
): Map<string | number, number> {
  const coefficients = coefficientsOfGroup(group);
  if (members) {
    const frozen = new Set(members.map(String));
    for (const key of [...coefficients.keys()]) {
      if (!frozen.has(String(key))) coefficients.delete(key);
    }
  }
  return coefficients;
}

export function chosenInterfaceGroupMapping(): InterfaceGroupMapping | undefined {
  return chosenMapping;
}

// ------------------------------------------------------------- summary

export interface InterfaceGroupsSummary {
  groups: number;
  /** Distinct member names the given interface set carries. */
  mapped: number;
  /** Member names the given set lacks: kept and flagged. */
  offAxis: string[];
  /** Members counted at -1, across every group. */
  reversed: number;
}

/** Coverage against the caller's interface names (never cached; see
 * `summarizeBusGroups`), or undefined when nothing is loaded. */
export function summarizeInterfaceGroups(
  interfaces: readonly string[] | undefined,
): InterfaceGroupsSummary {
  const named = new Set<string>();
  let reversed = 0;
  for (const members of groupToInterfaces.values()) {
    for (const member of members) {
      named.add(member.name);
      if (member.direction === 'reversed') reversed++;
    }
  }
  if (interfaces === undefined) {
    return { groups: groupToInterfaces.size, mapped: 0, offAxis: [], reversed };
  }
  const carried = new Set(interfaces);
  return {
    groups: groupToInterfaces.size,
    mapped: [...named].filter((name) => carried.has(name)).length,
    offAxis: [...named].filter((name) => !carried.has(name)),
    reversed,
  };
}

// ------------------------------------------------------------- ingest

/** One refusal reason and how many rows it refused. */
export interface RefusalCount {
  reason: string;
  rows: number;
}

/** What `planInterfaceGroups` resolved a file into, before any state moves. */
export interface InterfaceGroupsPlan {
  members: Map<string, InterfaceMember[]>;
  /** Distinct (interface, group) pairs the file produced. */
  memberships: number;
  /** Members the file marked reversed. */
  reversed: number;
  refusals: RefusalCount[];
}

function countRefusal(refusals: RefusalCount[], reason: string): void {
  const held = refusals.find((entry) => entry.reason === reason);
  if (held) held.rows++;
  else refusals.push({ reason, rows: 1 });
}

/**
 * File a member. Repeated with the SAME direction it is idempotent; with the
 * OPPOSITE direction one row is a mistake, so it is refused and counted,
 * never last-writer-wins.
 */
function addMember(
  map: Map<string, InterfaceMember[]>,
  member: InterfaceMember,
  group: string,
): boolean {
  const members = map.get(group);
  if (!members) {
    map.set(group, [member]);
    return true;
  }
  const held = members.find((entry) => entry.name === member.name);
  if (!held) {
    members.push(member);
    return true;
  }
  return held.direction === member.direction;
}

/** Resolve a membership CSV WITHOUT touching the loaded map: the editor's
 * "Load CSV…" path. */
export function planInterfaceGroups(
  csv: string,
  mapping: InterfaceGroupMapping,
): InterfaceGroupsPlan {
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

  const nameAt = columnOf(mapping.nameColumn);
  const groupAt = columnOf(mapping.groupColumn);
  const directionAt =
    mapping.directionColumn === undefined ? -1 : columnOf(mapping.directionColumn);

  const members = new Map<string, InterfaceMember[]>();
  const refusals: RefusalCount[] = [];
  let reversed = 0;

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const group = (cells[groupAt] ?? '').trim();
    if (group === '') {
      countRefusal(refusals, 'A row has a blank group cell, so it names no group.');
      continue;
    }
    const name = (cells[nameAt] ?? '').trim();
    if (name === '') {
      countRefusal(refusals, 'A row has a blank interface cell, so it names no interface.');
      continue;
    }
    const cell = directionAt < 0 ? '' : (cells[directionAt] ?? '');
    const direction = directionOf(cell);
    if (direction === undefined) {
      const spellings = directionSpellings();
      countRefusal(
        refusals,
        `"${cell.trim()}" is not a direction. Write ${spellings.forward.slice(0, 3).join(', ')} ` +
          `or ${spellings.reversed.slice(0, 3).join(', ')}; a blank cell is forward.`,
      );
      continue;
    }
    if (!addMember(members, { name, direction }, group)) {
      countRefusal(
        refusals,
        `A row gives "${name}" both directions in group "${group}"; one of the two is wrong, ` +
          'so neither is taken over the other.',
      );
      continue;
    }
    if (direction === 'reversed') reversed++;
  }

  if (members.size === 0) {
    const why = refusals.map((entry) => `${entry.reason} (${entry.rows} row(s))`).join(' ');
    throw new Error(
      'That file produced no group membership — the mapping was left unchanged.' +
        (why === '' ? '' : ` ${why}`),
    );
  }

  let memberships = 0;
  for (const list of members.values()) memberships += list.length;

  return { members, memberships, reversed, refusals };
}

/** The plan, plus what it now covers. */
export interface InterfaceGroupsLoad extends InterfaceGroupsPlan {
  summary: InterfaceGroupsSummary;
}

/** Replace the map from a membership CSV through the caller's mapping. */
export function loadInterfaceGroups(
  csv: string,
  mapping: InterfaceGroupMapping,
  axis?: readonly string[],
): InterfaceGroupsLoad {
  const plan = planInterfaceGroups(csv, mapping);
  groupToInterfaces = plan.members;
  chosenMapping = mapping;
  return { ...plan, summary: summarizeInterfaceGroups(axis) };
}

/** Replace the map from the editor, keeping the provenance mapping (or the
 * editor's own shape). */
export function setInterfaceMembership(
  members: ReadonlyMap<string, readonly InterfaceMember[]>,
): void {
  if (members.size === 0) {
    throw new Error('That leaves no groups — the mapping was left unchanged.');
  }
  groupToInterfaces = new Map(
    [...members].map(([group, list]) => [group, list.map((member) => ({ ...member }))]),
  );
  if (chosenMapping === undefined) chosenMapping = EDITOR_MAPPING;
}

// ---------------------------------------------------------- persistence

/** The bundle shape. Every member carries its direction: without it, the
 * same names would be summed the wrong way round. */
export interface SavedInterfaceGroups {
  mapping: InterfaceGroupMapping;
  members: [string, InterfaceMember[]][];
}

/** The current map for the bundle writer, or null when none is loaded. */
export function exportInterfaceGroups(): SavedInterfaceGroups | null {
  if (groupToInterfaces.size === 0) return null;
  if (chosenMapping === undefined) {
    // A wiring bug, not a user state.
    throw new Error('Interface groups are loaded with no column mapping recorded for them.');
  }
  return {
    mapping: chosenMapping,
    members: Array.from(groupToInterfaces, ([group, list]) => [
      group,
      list.map((member) => ({ ...member })),
    ]),
  };
}

function readString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`the saved ${what} is not text.`);
  return value;
}

/** Validate and copy a saved map, strictly. A direction that is neither word
 * is REFUSED, never defaulted to forward. */
export function readSavedInterfaceGroups(raw: unknown): SavedInterfaceGroups {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('the saved interface group membership is not an object.');
  }
  const record = raw as Record<string, unknown>;

  const rawMapping = record.mapping;
  if (rawMapping === null || typeof rawMapping !== 'object' || Array.isArray(rawMapping)) {
    throw new Error('the saved column mapping is not an object.');
  }
  const mappingRecord = rawMapping as Record<string, unknown>;
  const mapping: InterfaceGroupMapping = {
    nameColumn: readString(mappingRecord.nameColumn, 'interface name column'),
    groupColumn: readString(mappingRecord.groupColumn, 'group column'),
    ...(mappingRecord.directionColumn === undefined
      ? {}
      : { directionColumn: readString(mappingRecord.directionColumn, 'direction column') }),
  };

  if (!Array.isArray(record.members)) {
    throw new Error('the saved membership list is not a list.');
  }
  const members: [string, InterfaceMember[]][] = record.members.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2 || !Array.isArray(entry[1])) {
      throw new Error('a saved membership entry is not a group with its member list.');
    }
    return [
      readString(entry[0], 'group name'),
      entry[1].map((member) => {
        if (member === null || typeof member !== 'object' || Array.isArray(member)) {
          throw new Error('a saved member is not an object.');
        }
        const fields = member as Record<string, unknown>;
        const direction = readString(fields.direction, 'member direction');
        if (direction !== 'forward' && direction !== 'reversed') {
          throw new Error(`the saved direction "${direction}" is neither forward nor reversed.`);
        }
        return { name: readString(fields.name, 'member name'), direction };
      }),
    ];
  });

  return { mapping, members };
}

/** Restore the map from a bundle, replacing the session's. */
export function adoptInterfaceGroups(raw: unknown): void {
  const saved = readSavedInterfaceGroups(raw);
  groupToInterfaces = new Map(
    saved.members.map(([group, list]) => [group, list.map((member) => ({ ...member }))]),
  );
  chosenMapping = saved.mapping;
}

/** Tests only. */
export function clearInterfaceGroups(): void {
  groupToInterfaces = new Map();
  chosenMapping = undefined;
}
