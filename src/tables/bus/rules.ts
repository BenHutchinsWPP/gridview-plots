// src/tables/bus/rules.ts
//
// Units and y scales for Bus. A wide bus export is ONE quantity per file,
// named on its title line, so the unit and temporal rule belong to the FILE.
// Branch on `temporal` from data/bus/quantity-rules.json; never re-derive it.
//
// The SPATIAL rule (`spatialOf`) comes from the same unit's `class`:
// EXTENSIVE and RATE sum, INTENSIVE refuses. An LMP is refused rather than
// load-weighted because the load lives in another table and slot, a join no
// other rule here makes; an unweighted mean reads high. Reopening this means
// designing that join (AGENTS.md).

import rulesData from '../../../data/bus/quantity-rules.json' with { type: 'json' };
import { scaleOf, scalesOf } from '../../series/scales';
import { unitOf, unitRules } from '../wide/quantity';
import type { UnitRule } from './types';

// Defined with the shape reader and the series; re-exported here beside the
// rules that say what a unit means.
export { unitOf, scaleOf, scalesOf };

export const { ruleForUnit, temporalOf, totalIsMeaningful } = unitRules(
  rulesData.units as UnitRule[],
);

export type SpatialRule = 'SUM' | 'REFUSE';

/** How a bus quantity combines across buses, by unit `class` (as for
 * generators): EXTENSIVE (MWh, $) and RATE (MW) sum per hour; INTENSIVE
 * ($/MWh, kV, %) and unknown units refuse. */
export function spatialOf(unit: string): SpatialRule {
  const rule = ruleForUnit(unit);
  if (!rule) return 'REFUSE';
  return rule.class === 'EXTENSIVE' || rule.class === 'RATE' ? 'SUM' : 'REFUSE';
}

/**
 * Why a quantity cannot combine across buses, or undefined. Written for the
 * analyst at the disabled button: it states the arithmetic (the sum is in no
 * unit) and names the UNIT, which they can check against the dropdown, never
 * the kind or this code's vocabulary ("intensive").
 */
export function spatialRefusal(quantity: string, unit: string): string | undefined {
  const rule = ruleForUnit(unit);
  if (!rule) {
    return (
      `"${quantity}" is measured in ${unit || 'no unit this build can read'}, which this build ` +
      'has no combining rule for, so there is no saying whether adding it across buses means ' +
      'anything. A total that might be meaningless is not offered.'
    );
  }
  if (rule.class === 'INTENSIVE') {
    return (
      `"${quantity}" is measured in ${unit}, a per-unit figure that cannot be added up: the ` +
      `sum of two buses' ${unit} is not a ${unit}. An average would need a weighting column, ` +
      'and a bus export carries one quantity per file, so the weight is in another table.'
    );
  }
  return undefined;
}

/** Whether a QUANTITY may combine, so the Bus Groups dropdown never offers
 * one it would refuse (see `combinesAcrossGenerators`). */
export function combinesAcrossBuses(quantity: string): boolean {
  return spatialOf(unitOf(quantity)) === 'SUM';
}

/** How a bus is named for humans: `BUS_A (10002)`, always both. Names may
 * repeat, so a name alone is ambiguous and an id alone unreadable. */
export function busLabel(name: string, id: number): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? `${trimmed} (${id})` : `bus ${id}`;
}
