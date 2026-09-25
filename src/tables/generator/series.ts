// src/tables/generator/series.ts
//
// Generator's half of the series model, the ONE place a generator line is
// built: one `SeriesSpec` in, one drawn `CaseSeries` out.
//
// Domain rules:
//   * `{groupBy, value}`: EXTENSIVE and RATE quantities sum across matching
//     units. INTENSIVE quantities refuse cleanly.
//   * `perUnit` ("% of range", `src/series/range.ts`): a power quantity
//     (MW/MWh) divides by GeneratorList's `PSSEMaxCap(MW)` / `PSSEMinCap(MW)`;
//     a group by its members' summed caps, over the members it summed. Any
//     other unit, or a unit with no cap listed, divides by its own peak. A
//     group's power needs the list: with none it is refused, as on the
//     Generator Groups tab, rather than divided by its peak.

import { HOURS_PER_YEAR, buildCalendar, buildMask } from '../../model/calendar';
import {
  CASE_GROUP_BY,
  refusedSeries,
  type ResolveOptions,
  type SeriesBuffers,
  type SeriesSpec,
} from '../../series/model';
import type { Filters } from '../../model/types';
import type { CaseSeries } from '../../ui/charts';
import { applyMask, buildSeries, isAllZero, quantiles, stats } from './kernels';
import { spatialOf, spatialRefusal, unitOf } from './rules';
import { lookupFor } from '../../lookups/store';
import { bucketLabelFor, reduceMembers, reduceSingleBucket } from '../../lookups/reduce';
import { cellValue } from '../../lookups/merge';
import { GENERATOR_GROUP_BY, unitsInGroup } from './groups';
import { derivedAttribute } from './derived';
import type { GeneratorTable } from './types';
import { PERCENT, normalizeToRange, rangeLabel, type RangeLimits } from '../../series/range';
import type { LookupTable } from '../../lookups/types';
import { GENERATOR_LIST } from '../../lookups/schema';

/** What this kind's group members are called when counted (`14 units`). */
export const MEMBER_NOUN = { one: 'unit', many: 'units' };

export const MAX_CAP_COLUMN = 'PSSEMaxCap(MW)';
/** How many capless units a note names before it counts the rest. */
const CAPLESS_SHOWN = 5;

/** GeneratorList's caps are MW; an hourly MWh is the same number, and no
 * other unit is divided by them. */
export function isPower(unit: string): boolean {
  return unit === 'MW' || unit === 'MWh';
}

/** GeneratorList's two cap columns, when the list carries them. */
function capColumnsOf(lookup: LookupTable | undefined) {
  const column = (name: string) => {
    const index = lookup?.byName.get(name);
    return index === undefined || !lookup ? undefined : lookup.columns[index];
  };
  return { max: column(MAX_CAP_COLUMN), min: column('PSSEMinCap(MW)') };
}

/** Whether a list row states a usable max cap (> 0). */
export function hasMaxCap(lookup: LookupTable | undefined, row: number | undefined): boolean {
  const { max } = capColumnsOf(lookup);
  const cap = row !== undefined && max ? cellValue(max, row) : null;
  return typeof cap === 'number' && cap > 0;
}

/** Why a group's power has no "% of range" without the list. Falling back
 * to the peak would make the same toggle mean two things on two tabs. */
export function rangeNeedsList(unit: string): string {
  return (
    `% of range divides ${unit} by the members' summed ${MAX_CAP_COLUMN}, which needs ` +
    `${GENERATOR_LIST.banner} to be loaded.`
  );
}

/** Says which summed units added MW but no capacity, when the others' caps
 * are the divisor. The division is left as it is: dropping them from both
 * sides would hide output that happened. `what` is "a row" or "the line". */
export function caplessNote(capless: ReadonlySet<string | number>, what: string): string[] {
  if (capless.size === 0) return [];
  const shown = [...capless].slice(0, CAPLESS_SHOWN).join(', ');
  const more = capless.size > CAPLESS_SHOWN ? `, and ${capless.size - CAPLESS_SHOWN} more` : '';
  const one = capless.size === 1;
  return [
    `${one ? '1 summed unit has' : `${capless.size} summed units have`} no ${MAX_CAP_COLUMN} ` +
      `above 0 in ${GENERATOR_LIST.banner} (${shown}${more}): ${one ? 'its' : 'their'} output ` +
      `is in the % of range numerator but not the capacity, so ${what} can read over 100%.`,
  ];
}

/**
 * One list row's caps, or a sum over several. A max cap counts only when
 * > 0; any numeric min cap counts, since a min ≥ 0 is what sends a negative
 * hour to the max. A side no row states is NaN, which is "use the peak".
 */
export function capsOf(lookup: LookupTable | undefined, rows: Iterable<number>): RangeLimits {
  const { max, min } = capColumnsOf(lookup);
  let upper = 0;
  let lower = 0;
  let hasUpper = false;
  let hasLower = false;
  for (const row of rows) {
    const pmax = max ? cellValue(max, row) : null;
    if (typeof pmax === 'number' && pmax > 0) {
      upper += pmax;
      hasUpper = true;
    }
    const pmin = min ? cellValue(min, row) : null;
    if (typeof pmin === 'number' && !Number.isNaN(pmin)) {
      lower += pmin;
      hasLower = true;
    }
  }
  return { upper: hasUpper ? upper : NaN, lower: hasLower ? lower : NaN };
}

/** The caps a line divides by: its unit's list row, or the rows of the units
 * a group actually summed, so a member the sums skipped adds no capacity.
 * `capless` is the summed units without a max cap, when the others' caps are
 * the divisor (all capless is the peak fallback, which cannot pass 100%). */
function nameplateOf(
  lookup: LookupTable | undefined,
  spec: SeriesSpec,
  summed: readonly (string | number)[] | undefined,
): { caps: RangeLimits; capless: Set<string | number> } {
  const capless = new Set<string | number>();
  if (!lookup) return { caps: {}, capless };
  const names = 'entity' in spec.subject ? [String(spec.subject.entity)] : (summed ?? []);
  const rows: number[] = [];
  for (const name of names) {
    const row = lookup.index.get(name);
    if (row !== undefined) rows.push(row);
    if (summed && !hasMaxCap(lookup, row)) capless.add(name);
  }
  const caps = capsOf(lookup, rows);
  if (Number.isNaN(caps.upper)) capless.clear();
  return { caps, capless };
}

export function resolveGeneratorSeries(
  spec: SeriesSpec,
  table: unknown,
  filters: Filters,
  buffers: SeriesBuffers,
  options: ResolveOptions,
): CaseSeries {
  const data = table as GeneratorTable;
  const unit = unitOf(data.quantity);

  let warnings: string[] = [];
  // A frozen member set restricts every membership question below to the
  // units the ticked row's bucket held -- the sums, and so the caps a
  // "% of range" line divides by. It is a restriction on the label match, never a
  // substitute for it, so a member the study has since relabelled or dropped
  // simply does not contribute.
  const members =
    !('entity' in spec.subject) && spec.subject.members
      ? new Set<string | number>(spec.subject.members)
      : undefined;
  // The units a grouped line summed, handed on for `checkStackOverlap`: it
  // imports no kind, so an injection group or a derived fuel is a `groupBy`
  // it cannot answer for, and asking would miss the overlap in silence.
  const summed: (string | number)[] | undefined = 'entity' in spec.subject ? undefined : [];
  if (!('entity' in spec.subject)) {
    if (spatialOf(unit) === 'REFUSE') {
      const reason =
        spatialRefusal(data.quantity, unit) ??
        `"${data.quantity}" cannot be combined across generators.`;
      return refusedSeries(options, data.quantity, reason, buffers, unit);
    }
    const groupValue = spec.subject.value;
    if (spec.subject.groupBy === CASE_GROUP_BY) {
      // Every unit this table carries. `reduceSingleBucket` with a constant
      // label is the whole of it: each unit answers with the case's name, so
      // each unit matches, and a frozen member set still narrows it exactly
      // as it narrows a column bucket.
      const count = reduceSingleBucket(
        data.cube,
        data.presence,
        data.generators,
        undefined,
        CASE_GROUP_BY,
        groupValue,
        buffers.series,
        members,
        () => groupValue,
        summed,
      );
      if (count === 0) {
        return refusedSeries(
          options,
          data.quantity,
          `${options.tableLabel} carries no unit for "${groupValue}".`,
          buffers,
          unit,
        );
      }
    } else if (spec.subject.groupBy === GENERATOR_GROUP_BY) {
      // A user-authored group: membership is the map's (or the frozen set a
      // narrowed tick froze), not a list column's labels -- the same rule the
      // area resolver draws area groups by, and for the same reason: a frozen
      // member set is the pin's truth, and the map's current membership is
      // only the fallback for subjects that never froze one.
      const names = spec.subject.members
        ? spec.subject.members.map(String)
        : unitsInGroup(spec.subject.value);
      const count = reduceMembers(
        data.cube,
        data.presence,
        data.generators,
        new Set(names),
        buffers.series,
        summed,
      );
      if (count === 0) {
        return refusedSeries(
          options,
          data.quantity,
          `No unit of group "${spec.subject.value}" is carried by ${options.tableLabel}.`,
          buffers,
          unit,
        );
      }
    } else {
      const lookup = lookupFor('generatorlist');
      if (!lookup) {
        return refusedSeries(
          options,
          data.quantity,
          `Grouping generators by ${spec.subject.groupBy} needs GeneratorList.csv to be loaded.`,
          buffers,
          unit,
        );
      }
      const derived = derivedAttribute(spec.subject.groupBy);
      const labelOf = derived
        ? (genName: string | number) =>
            derived.labelOf((column) => bucketLabelFor(genName, lookup, column))
        : undefined;

      const count = reduceSingleBucket(
        data.cube,
        data.presence,
        data.generators,
        lookup,
        spec.subject.groupBy,
        spec.subject.value,
        buffers.series,
        members,
        labelOf,
        summed,
      );
      if (count === 0) {
        return refusedSeries(
          options,
          data.quantity,
          `No generators in ${options.tableLabel} match ${spec.subject.groupBy} = "${spec.subject.value}".`,
          buffers,
          unit,
        );
      }
    }
  } else {
    const built = buildSeries(
      data,
      String(spec.subject.entity),
      buffers.series,
      options.tableLabel,
    );
    if (built.values === null) {
      const refused = refusedSeries(options, data.quantity, built.refusal ?? '', buffers, unit);
      return { ...refused, warnings: built.warnings };
    }
    warnings = built.warnings;
  }

  buildMask(filters, buildCalendar(data.year), data.tou, buffers.mask);
  let outUnit = unit;
  let rangeText: string | undefined;
  if (spec.perUnit) {
    outUnit = '%';
    let caps: RangeLimits = {};
    if (isPower(unit)) {
      const lookup = lookupFor('generatorlist');
      if (summed && !lookup) {
        return refusedSeries(options, data.quantity, rangeNeedsList(unit), buffers, unit);
      }
      const nameplate = nameplateOf(lookup, spec, summed);
      caps = nameplate.caps;
      warnings.push(...caplessNote(nameplate.capless, 'the line'));
    }
    rangeText = rangeLabel(normalizeToRange(buffers.series, caps, PERCENT, buffers.mask));
  }

  for (let hour = 0; hour < HOURS_PER_YEAR; hour++) {
    buffers.display[hour] = buffers.mask[hour] === 1 ? buffers.series[hour] : NaN;
  }

  const n = applyMask(buffers.series, buffers.mask, buffers.gathered);
  const summary = stats(buffers.gathered, n);
  const allZero = isAllZero(buffers.gathered, n);
  const spread = quantiles(buffers.gathered, n);
  return {
    name: options.name,
    detail: options.detail,
    color: options.color,
    dashed: options.dashed,
    unit: outUnit,
    quantity: data.quantity,
    values: buffers.display,
    warnings,
    sorted: buffers.gathered,
    n,
    stats: summary,
    quantiles: spread,
    allZero,
    ...(rangeText ? { rangeLabel: rangeText } : {}),
    summed,
  };
}
