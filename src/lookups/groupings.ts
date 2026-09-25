// src/lookups/groupings.ts
//
// The session-wide area <-> group membership map.
//
// Group is a universal scope control that non-Area kinds read too, so the
// mapping sits beside `src/lookups/` rather than inside the Area kind.
//
// The Area AXIS stays in Area -- that one is the cube's own index order,
// and conflating the two is the bug groupings.ts warned about.

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

let allAreasProvider: () => string[] = () => [];

/** Register the provider for all areas (from the Area kind's axis). */
export function registerAllAreasProvider(provider: () => string[]): void {
  allAreasProvider = provider;
}

export function groupingNames(): string[] {
  const named = Array.from(groupToAreas.keys());
  return named.includes(ALL_AREAS) ? named : [ALL_AREAS, ...named];
}

export function areasIn(grouping: string): string[] {
  const name = grouping.trim();
  return groupToAreas.get(name) ?? (name === ALL_AREAS ? allAreasProvider() : []);
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
export function setGroupings(
  csv: string,
  axis: readonly string[] = allAreasProvider(),
): GroupingSummary {
  const parsed = membershipFrom(parsePairs(csv));
  if (parsed.size === 0) {
    throw new Error('That file has no Name,Grouping rows — the mapping was left unchanged.');
  }
  groupToAreas = parsed;
  return summarizeGroupings(axis);
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
