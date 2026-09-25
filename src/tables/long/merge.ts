// src/tables/long/merge.ts
//
// Whether several long-shape files may be read into ONE table (date-split
// halves of one study), and what the user is told. Merges join the HOUR axis
// only, never the metric axis, so the duplicate check stays per (entity,
// hour) and refuses overlaps across files for free. Kind-neutral: it sees
// header names, years and file names.

import type { CasePlan } from './kind';

export interface MergeCheck {
  /** Set when the group cannot be read as one table. Nothing else is used. */
  refusal?: string;
  warnings: string[];
}

/** Every character of whitespace removed. Two header names that differ only in
 * spacing collapse to the same key -- which is how the ambiguity below is
 * DETECTED, never how it is resolved. */
const despaced = (name: string): string => name.replace(/\s+/g, '');

const list = (names: readonly string[]): string => names.map((n) => `"${n}"`).join(', ');

/**
 * May these files be one table? A group of one always passes. Refused:
 * different years (a cube is one year), and two spellings of one metric
 * (`Load (MW)` vs `Load(MW)`: both are named rather than guessed equal). A
 * metric only some members carry is a warning, covered by the coverage note;
 * units are part of names here, so mismatched units are just two columns.
 */
export function checkMergeGroup(members: readonly CasePlan[]): MergeCheck {
  if (members.length < 2) return { warnings: [] };
  const names = members.map((m) => m.file.name);

  const years = [...new Set(members.map((m) => m.year))];
  if (years.length > 1) {
    return {
      refusal:
        `${list(names)} were assigned to one study but carry different years ` +
        `(${years.sort().join(', ')}). One study is one calendar year, so these cannot be read ` +
        `as one table. Give them different study names to load them separately.`,
      warnings: [],
    };
  }

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
        `nothing in this app can tell -- merging them would either split one year in half or ` +
        `stack two measurements on one column. Fix the spelling in the export, or load them as ` +
        `separate studies.`,
      warnings: [],
    };
  }

  const warnings: string[] = [];
  const everywhere = new Set(members[0].header.metricNames);
  for (const member of members.slice(1)) {
    const here = new Set(member.header.metricNames);
    for (const metric of everywhere) if (!here.has(metric)) everywhere.delete(metric);
  }
  const partial: string[] = [];
  for (const shape of byShape.values()) {
    if (!everywhere.has(shape[0])) partial.push(shape[0]);
  }
  if (partial.length > 0) {
    warnings.push(
      `${list(names)} are read as one study, but ${partial.length} column(s) are in only some of ` +
        `them (${partial.slice(0, 3).join(', ')}${partial.length > 3 ? ', …' : ''}). Those cover ` +
        `only the part of the year their own file did.`,
    );
  }
  return warnings.length > 0 ? { warnings } : { warnings: [] };
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
