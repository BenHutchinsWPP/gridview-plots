// src/tables/interface/rules.ts
//
// Units, aggregation rules, and the name grouping the picker folds by. An
// interface export is one QUANTITY for every interface, so unit and temporal
// rule come from the title line: a congestion cost may be totalled over
// hours, a MW flow may not. Branch on `temporal` from
// data/interface/quantity-rules.json; never re-derive it.

import rulesData from '../../../data/interface/quantity-rules.json' with { type: 'json' };
import { scaleOf, scalesOf } from '../../series/scales';
import { unitOf, unitRules } from '../wide/quantity';
import type { UnitRule } from './types';

// Defined outside this kind (title-line and y-scale helpers), re-exported here.
export { unitOf, scaleOf, scalesOf };

export const { ruleForUnit, temporalOf, totalIsMeaningful } = unitRules(
  rulesData.units as UnitRule[],
);

export type SpatialRule = 'SUM' | 'REFUSE';

/**
 * How an interface quantity combines across interfaces, by unit `class`:
 * EXTENSIVE and RATE sum, INTENSIVE or unknown refuses. This does NOT license
 * summing any two interfaces: only an authored group with directions
 * (`groups.ts`) is a boundary. This answers the second question once that
 * first one has been answered by hand.
 */
export function spatialOf(unit: string): SpatialRule {
  const rule = ruleForUnit(unit);
  if (!rule) return 'REFUSE';
  return rule.class === 'EXTENSIVE' || rule.class === 'RATE' ? 'SUM' : 'REFUSE';
}

/** Why a quantity cannot combine across interfaces, or undefined; worded as in
 * src/tables/bus/rules.ts. */
export function spatialRefusal(quantity: string, unit: string): string | undefined {
  const rule = ruleForUnit(unit);
  if (!rule) {
    return (
      `"${quantity}" is measured in ${unit || 'no unit this build can read'}, which this build ` +
      'has no combining rule for, so there is no saying whether adding it across interfaces ' +
      'means anything. A total that might be meaningless is not offered.'
    );
  }
  if (rule.class === 'INTENSIVE') {
    return (
      `"${quantity}" is measured in ${unit}, a per-unit figure that cannot be added up: the ` +
      `sum of two paths' ${unit} is not a ${unit}. An average would need a weighting column, ` +
      'and an interface export carries one quantity per file, so no weight is in this table.'
    );
  }
  return undefined;
}

/** Whether a QUANTITY may combine, so the Interface Groups dropdown never
 * offers one it would refuse. */
export function combinesAcrossInterfaces(quantity: string): boolean {
  return spatialOf(unitOf(quantity)) === 'SUM';
}

/**
 * Whether a quantity has a DIRECTION for a member's sign to reverse. A flow
 * does; a congestion cost does not, so a reversed member subtracts a cost.
 * The sign is still applied, and the UI says so rather than ignoring it
 * (`src/tables/interface/ui/browse.ts`).
 */
export function isDirectional(unit: string): boolean {
  return unit === 'MW' || unit === 'MWh';
}

/** Whether "% of range" divides a quantity by a path's limit. A limit is a
 * flow rating, so the same units as `isDirectional`, for a different reason. */
export function isRated(unit: string): boolean {
  return unit === 'MW' || unit === 'MWh';
}

/**
 * The leading token of an interface name, for the picker's sort:
 * `P12 North Tie…` -> `P12`, `W07_AB_CD__…` -> `W07`, `Pth 03 East…` ->
 * `Pth 03`. Cosmetic only: naming conventions are the analyst's.
 */
export function prefixOf(name: string): string {
  const trimmed = name.trim();
  const spaced = /^([A-Za-z]+ ?\d*)[\s_]/.exec(trimmed);
  return spaced ? spaced[1] : trimmed.slice(0, 4);
}

export interface InterfaceGroup {
  title: string;
  names: string[];
}

/** Interfaces bucketed for display by FILE COVERAGE (every run vs some runs),
 * the question a mixed drop raises. One file means one group. */
export function interfaceGroups(
  names: string[],
  coverage: Map<string, string[]> | null,
  caseCount: number,
): InterfaceGroup[] {
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  if (!coverage || caseCount < 2) {
    return sorted.length > 0 ? [{ title: 'Interfaces', names: sorted }] : [];
  }

  const everywhere: string[] = [];
  const partial: string[] = [];
  for (const name of sorted) {
    ((coverage.get(name)?.length ?? 0) >= caseCount ? everywhere : partial).push(name);
  }
  return [
    { title: 'In every file', names: everywhere },
    { title: 'In some files only', names: partial },
  ].filter((group) => group.names.length > 0);
}
