// src/tables/long/merge.ts
//
// Whether several long-shape files may be read into ONE table (date- or
// year-split parts of one study, or metric-split ones), which years that
// table spans, and what the user is told. Where members overlap, the first
// file's value is kept (`FirstFile` in src/ingest.ts). Kind-neutral: it sees
// header names, years and file names.

import type { YearSpan } from '../../model/calendar';
import { yearSpanOf } from '../../ingest';
import type { CasePlan, HeaderInfo } from './kind';

export interface MergeCheck {
  /** Set when the group cannot be read as one table. Nothing else is used. */
  refusal?: string;
  /** The group's years, min..max over its members. Set unless refused. */
  span?: YearSpan;
  warnings: string[];
}

/** Add one scan block's rows per year into a file's running count. */
export function addYearRows(
  rowsByYear: Map<number, number>,
  scan: { minYear: number; yearRows: readonly number[] },
): void {
  scan.yearRows.forEach((rows, k) => {
    if (rows === 0) return;
    const year = scan.minYear + k;
    rowsByYear.set(year, (rowsByYear.get(year) ?? 0) + rows);
  });
}

/** Every character of whitespace removed. Two header names that differ only in
 * spacing collapse to the same key -- which is how the ambiguity below is
 * DETECTED, never how it is resolved. */
const despaced = (name: string): string => name.replace(/\s+/g, '');

const list = (names: readonly string[]): string => names.map((n) => `"${n}"`).join(', ');

/**
 * May these files be one table, and over which years? Every member must have
 * been scanned (`rowsByYear`). Refused: a year inside the union of the
 * members' years that no member has rows for (a Case is a contiguous run;
 * members may overlap, and the blit keeps the first member's value), and two
 * spellings of one metric (`Load (MW)` vs `Load(MW)`: both are named rather
 * than guessed equal). A metric only some members carry is noted after the
 * parse, and only when it is short of rows another member had; units are
 * part of names here, so mismatched units are just two columns.
 */
export function checkMergeGroup(members: readonly CasePlan[]): MergeCheck {
  const names = members.map((m) => m.file.name);

  const union = new Map<number, number>();
  for (const member of members) {
    for (const [year, rows] of member.rowsByYear) union.set(year, (union.get(year) ?? 0) + rows);
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

  // Collapsed spelling -> the raw spellings seen for it, in first-seen order.
  const byShape = new Map<string, string[]>();
  for (const member of members) {
    for (const metric of member.header.metricNames) {
      if (metric.length === 0) continue;
      const seen = byShape.get(despaced(metric));
      if (!seen) byShape.set(despaced(metric), [metric]);
      else if (!seen.includes(metric)) seen.push(metric);
    }
  }
  for (const spellings of byShape.values()) {
    if (spellings.length < 2) continue;
    return {
      refusal:
        `${list(names)} were assigned to one study but spell one column two ways ` +
        `(${list(spellings)}). These may be the same measurement or two different ones, and ` +
        `nothing in this app can tell -- merging them would either split one study in half or ` +
        `stack two measurements on one column. Fix the spelling in the export, or load them as ` +
        `separate studies.`,
      warnings: [],
    };
  }

  return { span, warnings: [] };
}

/** Every member's metric columns in first-seen order, for the merged table's
 * presence; bytes are still located by each member's own header. */
export function unionMetricNames(members: readonly CasePlan[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const member of members) {
    for (const metric of member.header.metricNames) {
      if (metric.length === 0 || seen.has(metric)) continue;
      seen.add(metric);
      out.push(metric);
    }
  }
  return out;
}

/** The group's header: the first member's key columns followed by every
 * member's metrics. Column plans locate metrics by `canonical`, so a union of
 * `metricNames` alone would leave a metric only a later member carries off the
 * group's plan, and its table empty. */
export function unionHeader(members: readonly CasePlan[]): HeaderInfo {
  const first = members[0].header;
  if (members.length === 1) return first;
  const metricNames = unionMetricNames(members);
  return {
    ...first,
    raw: [...first.raw.slice(0, first.keyCols), ...metricNames],
    canonical: [...first.canonical.slice(0, first.keyCols), ...metricNames],
    metricNames,
  };
}
