// src/tables/wide/quantity.ts
//
// The wide title line's quantity, and the unit inside it.
//
// Lives with the SHAPE reader, not a kind: reading the parenthesised unit is
// the same string operation for every wide export, and so is looking a unit up
// in a table keyed by unit string. What a unit MEANS is each kind's own rules
// file (AGENTS.md: kind never crosses) -- `unitRules` below is handed that
// file's `units` array and never names one.

/**
 * The unit inside a quantity's parentheses: `Power Flow (MW)` -> `MW`,
 * `Congestion Cost ($)` -> `$`. The LAST parenthesised group wins, so a
 * quantity that qualifies itself -- `Congestion Cost (Total) ($)` -- still
 * yields its unit. Returns '' when there is nothing to read, which is a
 * stated no-unit case and never a guessed one.
 */
export function unitOf(quantity: string): string {
  const groups = quantity.match(/\(([^()]*)\)/g);
  if (!groups || groups.length === 0) return '';
  return groups[groups.length - 1].slice(1, -1).trim();
}

/** The shape every kind's `units` entry shares: a unit string and how its
 * hours combine. A kind's own entry carries more -- `class`, `note` -- and
 * `unitRules` hands that entry straight back, so nothing is lost by passing
 * through here. The vocabulary itself stays declared per kind, on purpose: a
 * kind must be able to change its rules without asking the others. */
export interface UnitRuleLike {
  readonly unit: string;
  readonly temporal: 'SUM' | 'MEAN';
}

export interface UnitRules<R extends UnitRuleLike> {
  /** The rule for a unit, or undefined when this build has no rule for it. */
  ruleForUnit(unit: string): R | undefined;
  /**
   * How hours combine for a unit. Anything unrecognised is MEAN: a mean is
   * always a defined number, whereas a total of an unknown unit is exactly the
   * plausible-looking wrong answer this project keeps refusing to produce.
   */
  temporalOf(unit: string): R['temporal'];
  /** True when a period total over the filtered hours is a meaningful number. */
  totalIsMeaningful(unit: string): boolean;
}

/**
 * The three lookups every wide kind's rules file needs, over that kind's own
 * `units` array. Built once at module scope by the caller, so the Map is
 * indexed once per kind and not once per question.
 *
 * This is the MECHANISM only. It was three verbatim copies -- bus, generator
 * and interface -- of a Map and three one-line readers, which is the category
 * of duplication that quietly drifts (see `src/series/scales.ts` for the one
 * that did).
 */
export function unitRules<R extends UnitRuleLike>(units: readonly R[]): UnitRules<R> {
  const byUnit = new Map<string, R>();
  for (const rule of units) byUnit.set(rule.unit, rule);

  const ruleForUnit = (unit: string): R | undefined => byUnit.get(unit.trim());
  const temporalOf = (unit: string): R['temporal'] => ruleForUnit(unit)?.temporal ?? 'MEAN';
  return {
    ruleForUnit,
    temporalOf,
    totalIsMeaningful: (unit: string) => temporalOf(unit) === 'SUM',
  };
}
