// src/tables/area/groupings.ts
//
// The Area axis and the session-wide area <-> group membership map.
//
// NOTHING about a utility's areas ships in the build. The axis is read from
// the first hour of the first CSV loaded (pool.ts `discoverEntities`) or from a
// saved bundle, and membership from a Groupings.csv or a bundle. Before either
// happens this module knows no areas, which is the correct empty state for an
// app that gets handed around.
//
// The axis and the membership are two things: the axis is the cube's own
// index order, while a group may name areas the axis lacks (kept, flagged,
// never plotted). Code outside the Area kind never reads the map: a drawn
// group line carries the areas it summed (`CaseSeries.summed`).

/**
 * Every area, in the order the loaded data lists them. This is the cube's
 * area axis and the order the WASM parser's hash table is filled in, so it is
 * the one definition of "area index N" in the whole app. Empty until a case
 * or a bundle supplies it.
 */
let AXIS: string[] = [];

/** Adopt the axis discovered in a file or restored from a bundle. */
export function setAxis(areas: string[]): void {
  AXIS = areas.slice();
}

export function allAreas(): string[] {
  return AXIS.slice();
}

/** True for a name that is not on the area axis: a group can reference one,
 * nothing can plot one. */
export function isOffAxis(area: string): boolean {
  return !AXIS.includes(area.trim());
}

/** The header the Area groupings editor writes, which is the whole of the
 * `Groupings.csv` shape. The drop classifier matches a first line against it. */
export const EDITOR_CSV_HEADERS: readonly (readonly string[])[] = [['Name', 'Grouping']];

/** Ordered (area, group) pairs, exactly as a Groupings.csv carries them. */
function parsePairs(csv: string): [string, string][] {
  const pairs: [string, string][] = [];
  const lines = csv.split(/\r?\n/).filter((line) => line.trim().length > 0);
  // lines[0] is the "Name,Grouping" header -- skip it.
  for (let i = 1; i < lines.length; i++) {
    const [nameRaw, groupingRaw] = lines[i].split(',');
    const name = (nameRaw ?? '').trim();
    const grouping = (groupingRaw ?? '').trim();
    if (!name || !grouping) continue;
    pairs.push([name, grouping]);
  }
  return pairs;
}

/**
 * group -> its members, in insertion order. Members need not be on the axis.
 *
 * Empty until someone loads a mapping: how a utility rolls its areas up is
 * the user's own analysis and does not belong baked into a build that gets
 * handed around. Load a Groupings.csv, or a saved bundle that carries one.
 */
let groupToAreas = new Map<string, string[]>();

function membershipFrom(pairs: [string, string][]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [name, grouping] of pairs) {
    const members = map.get(grouping);
    if (!members) map.set(grouping, [name]);
    else if (!members.includes(name)) members.push(name);
  }
  return map;
}

/**
 * The everything grouping. Computed from the area axis rather than listed in
 * a mapping, so it stays right when a new one is loaded and cannot
 * drift out of date the way a hand-maintained "All" row would. A mapping that
 * defines this name itself wins -- an explicit list is a decision.
 */
export const ALL_AREAS = 'All areas';

export function groupingNames(): string[] {
  const named = Array.from(groupToAreas.keys());
  return named.includes(ALL_AREAS) ? named : [ALL_AREAS, ...named];
}

export function areasIn(grouping: string): string[] {
  const name = grouping.trim();
  return groupToAreas.get(name) ?? (name === ALL_AREAS ? allAreas() : []);
}

export interface GroupingSummary {
  groups: number;
  /** Distinct areas named by any group and present on the axis. */
  mapped: number;
  /** Names a group claims that the axis does not have -- kept, not dropped. */
  offAxis: string[];
  /** Axis areas that no group names. They are still plottable on their own. */
  unmapped: string[];
}

function summarizeGroupings(axis: readonly string[]): GroupingSummary {
  const named = new Set<string>();
  for (const members of groupToAreas.values()) for (const area of members) named.add(area);
  const axisSet = new Set(axis);
  return {
    groups: groupingNames().length,
    mapped: axis.filter((area) => named.has(area)).length,
    offAxis: Array.from(named).filter((area) => !axisSet.has(area.trim())),
    unmapped: axis.filter((area) => !named.has(area)),
  };
}

/**
 * Replace group membership from a Groupings.csv the user supplied at runtime,
 * or from the editor.
 */
export function setGroupings(csv: string): GroupingSummary {
  const parsed = membershipFrom(parsePairs(csv));
  if (parsed.size === 0) {
    throw new Error('That file has no Name,Grouping rows — the mapping was left unchanged.');
  }
  groupToAreas = parsed;
  return summarizeGroupings(AXIS);
}

/** The current mapping back as a Groupings.csv: one row per (area, group)
 * pair, so a many-to-many mapping round-trips through the file, the editor
 * and a saved bundle unchanged. ALL_AREAS is not in it -- it is computed. */
export function exportGroupings(): string {
  const lines = ['Name,Grouping'];
  for (const [grouping, members] of groupToAreas) {
    for (const area of members) lines.push(`${area},${grouping}`);
  }
  return lines.join('\n') + '\n';
}
