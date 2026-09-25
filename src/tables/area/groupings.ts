// src/tables/area/groupings.ts
//
// The Area axis, and re-exports of session groupings.
//
// NOTHING about a utility's areas ships in the build. The axis is read from
// the first hour of the first CSV loaded (pool.ts `discoverEntities`) or from a
// saved bundle. Before either happens this module knows no areas, which is the
// correct empty state for an app that gets handed around.
//
// The group membership map lives in `src/lookups/groupings.ts` beside `src/lookups/`,
// because Group is a universal scope control that non-Area kinds read too.
// The AREA AXIS stays here -- that one genuinely is the Area cube's own
// index order.

import {
  ALL_AREAS,
  exportGroupings,
  groupingNames,
  areasIn,
  registerAllAreasProvider,
  setGroupings as setGroupingsImpl,
  type GroupingSummary,
} from '../../lookups/groupings';

export { ALL_AREAS, exportGroupings, groupingNames, areasIn, type GroupingSummary };

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

registerAllAreasProvider(allAreas);

/** True for a name that is not on the area axis: a group can reference one,
 * nothing can plot one. */
export function isOffAxis(area: string): boolean {
  return !AXIS.includes(area.trim());
}

/** The header the Area groupings editor writes, which is the whole of the
 * `Groupings.csv` shape. The drop classifier matches a first line against it. */
export const EDITOR_CSV_HEADERS: readonly (readonly string[])[] = [['Name', 'Grouping']];

/**
 * Replace group membership from a Groupings.csv the user supplied at runtime,
 * or from the editor.
 */
export function setGroupings(csv: string): GroupingSummary {
  return setGroupingsImpl(csv, AXIS);
}
