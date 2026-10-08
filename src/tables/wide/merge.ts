// src/tables/wide/merge.ts
//
// Whether several WIDE-shape files may be read into one table, and which
// years it spans. Same rules as `src/tables/long/merge.ts` (HOUR axis only;
// the years a contiguous run; the group commits whole or not at all); only
// the axis differs. A wide export carries ONE quantity on its
// title line, so there is no metric axis to union: two quantities are two
// tables and a refusal. The ENTITIES are unioned instead, in `pool.ts`,
// before the accumulator is allocated. Kind-neutral.

import type { YearSpan } from '../../model/calendar';
import { yearSpanOf } from '../../ingest';
import type { CasePlan } from './pool';

export interface MergeCheck {
  /** Set when the group cannot be read as one table. Nothing else is used. */
  refusal?: string;
  /** The group's years, min..max over its members' spans. Set unless refused. */
  span?: YearSpan;
  warnings: string[];
}

const list = (names: readonly string[]): string => names.map((n) => `"${n}"`).join(', ');

/**
 * May these files be one table, and over which years? Refused: a year inside
 * the union of the members' spans that no member's span covers (a Case is a
 * contiguous run; members may overlap, and a doubled hour is refused at the
 * blit), and different quantities on the title line (`Power Flow (MW)` vs `(MWh)` or vs
 * `Power Flow(MW)`: named, never canonicalized on a guess). A title naming no
 * quantity is not refused here: the finalizer already warns it has no unit.
 * An entity only some members carry is a warning; its plane is NaN elsewhere
 * and the coverage note says how much of the span the table holds.
 */
export function checkMergeGroup(members: readonly CasePlan[]): MergeCheck {
  const names = members.map((m) => m.file.name);

  // Each member's span is what its date line states (or its first row's
  // year); the rows are verified against it at the parse.
  const union = new Map<number, number>();
  for (const member of members) {
    for (let y = member.firstYear; y < member.firstYear + member.numYears; y++) {
      union.set(y, (union.get(y) ?? 0) + 1);
    }
  }
  const years = yearSpanOf(
    members.length === 1
      ? `${names[0]} has`
      : `${list(names)} were assigned to one study and together have`,
    union,
  );
  if (years.refusal !== undefined) {
    const giveNames =
      members.length === 1 ? '' : ' Give them different study names to load them separately.';
    return { refusal: years.refusal + giveNames, warnings: [] };
  }
  const span = years.span;
  if (members.length < 2) return { span, warnings: [] };

  const quantities = [...new Set(members.map((m) => m.title.quantity.trim()))].filter(
    (q) => q.length > 0,
  );
  if (quantities.length > 1) {
    return {
      refusal:
        `${list(names)} were assigned to one study but their title lines name different ` +
        `measurements (${list(quantities)}). A column-per-entity export carries one quantity, ` +
        `so these are two tables — and if they are meant to be the same one, the spelling or ` +
        `the unit differs and nothing in this app can decide which is right. Fix the export, ` +
        `or load them as separate studies.`,
      warnings: [],
    };
  }

  const everywhere = new Set(members[0].header.entityNames);
  for (const member of members.slice(1)) {
    const here = new Set(member.header.entityNames);
    for (const entity of everywhere) if (!here.has(entity)) everywhere.delete(entity);
  }
  const partial = new Set<string>();
  for (const member of members) {
    for (const entity of member.header.entityNames) {
      if (!everywhere.has(entity)) partial.add(entity);
    }
  }
  if (partial.size === 0) return { span, warnings: [] };
  return {
    span,
    warnings: [
      `${list(names)} are read as one study, but ${partial.size} column(s) are in only some ` +
        `of them (${[...partial].slice(0, 3).join(', ')}${partial.size > 3 ? ', …' : ''}). Those ` +
        `cover only the hours their own file did.`,
    ],
  };
}
