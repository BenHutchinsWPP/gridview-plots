// src/tables/generator/rules.ts
//
// Units and y scales for Generator. A wide generator export is ONE quantity
// per file, named on the title line, so the unit (and the temporal rule) is a
// property of the FILE, never of a column name. Branch on `temporal` from
// data/generator/quantity-rules.json; do not re-derive it.
//
// Three headers are polysemous (`Fuel Cost ($) /ES Storage` and friends): the
// meaning depends on the unit's technology. They are carried verbatim, never
// split at ingest, and `isPolysemous` lets a pane say so.

import rulesData from '../../../data/generator/quantity-rules.json' with { type: 'json' };
import { scaleOf, scalesOf } from '../../series/scales';
import { unitOf, unitRules } from '../wide/quantity';
import type { UnitRule } from './types';

// Re-exported so this kind's callers reach them beside the unit rules.
export { unitOf, scaleOf, scalesOf };

export const { ruleForUnit, temporalOf, totalIsMeaningful } = unitRules(
  rulesData.units as UnitRule[],
);

interface QuantityRule {
  readonly quantity: string;
  readonly polysemous?: boolean;
  readonly note?: string;
}
const byQuantity = new Map<string, QuantityRule>();
for (const rule of rulesData.quantities as QuantityRule[]) byQuantity.set(rule.quantity, rule);

export type SpatialRule = 'SUM' | 'REFUSE';

/** EXTENSIVE and RATE sum across generators each hour; INTENSIVE refuses. */
export function spatialOf(unit: string): SpatialRule {
  const rule = ruleForUnit(unit);
  if (!rule) return 'REFUSE';
  return rule.class === 'EXTENSIVE' || rule.class === 'RATE' ? 'SUM' : 'REFUSE';
}

/** `spatialOf` asked of a title, so the Groups tab can leave a refused
 * quantity out of its dropdown rather than show an empty table. */
export function combinesAcrossGenerators(quantity: string): boolean {
  return spatialOf(unitOf(quantity)) === 'SUM';
}

/** Why a quantity cannot combine, or undefined. Name the unit and the
 * arithmetic, never the kind. */
export function spatialRefusal(quantity: string, unit: string): string | undefined {
  const rule = ruleForUnit(unit);
  if (!rule) {
    return (
      `"${quantity}" is measured in ${unit || 'no unit this build can read'}, which this build ` +
      'has no combining rule for, so there is no saying whether adding it across generators ' +
      'means anything. A total that might be meaningless is not offered.'
    );
  }
  if (rule.class === 'INTENSIVE') {
    return (
      `"${quantity}" is measured in ${unit}, a per-unit figure that cannot be added up: the ` +
      `sum of two generators' ${unit} is not a ${unit}. An average would need a weighting ` +
      'column, and a single-quantity export carries none.'
    );
  }
  return undefined;
}

/** One header, several meanings by technology. A stated list, never a guess
 * at a header with a slash in it. */
export function isPolysemous(quantity: string): boolean {
  return byQuantity.get(quantity.trim())?.polysemous === true;
}

/** What a polysemous quantity means, for the pane note. Undefined when there
 * is nothing recorded -- callers print no note rather than inventing one. */
export function quantityNote(quantity: string): string | undefined {
  return byQuantity.get(quantity.trim())?.note;
}
