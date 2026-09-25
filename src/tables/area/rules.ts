// src/tables/area/rules.ts
//
// Loads data/area/aggregation-rules.json and indexes it by trimmed canonical
// column name. Never re-derive the rules -- branch on `series` (see the
// JSON's own `contract` string) and `weight`/`fallbackWeight`.

import rulesData from '../../../data/area/aggregation-rules.json' with { type: 'json' };
import { scaleOf, scalesOf } from '../../series/scales';
import type { ColumnRule } from './types';

const byCanonical = new Map<string, ColumnRule>();
for (const column of rulesData.columns as ColumnRule[]) {
  byCanonical.set(column.canonical.trim(), column);
}

/**
 * Column groups in the order an analyst reaches for them. A column no test
 * claims lands in "Other", including one with no aggregation rule, which is
 * what a new export shape produces and must not be hidden.
 */
interface Group {
  title: string;
  match: (name: string, unit: string) => boolean;
  first?: string[];
}

/** The group calculated columns live in (the picker styles it by title). */
export const CALCULATED_GROUP = 'Calculations';

const has = (name: string, ...needles: string[]) =>
  needles.some((needle) => name.toLowerCase().includes(needle.toLowerCase()));

const GROUPS: Group[] = [
  {
    title: 'Load',
    first: ['Load (MWh)', 'Served Load Including Losses (MWh)', 'Net Load (MW)'],
    match: (name) => has(name, 'load') && !has(name, 'payment', 'cost', 'lmp weighted'),
  },
  {
    title: 'Generation',
    first: ['Generation (MWh)', 'Available Capacity (MW)', 'Installed Capacity (MW)'],
    match: (name) =>
      has(name, 'generation', 'capacity', 'spillage') && !has(name, 'revenue', 'cost'),
  },
  {
    title: 'Prices',
    first: ['Avg LMP Weighted by Load ($/MWh)', 'Avg LMP Weighted by Gen ($/MWh)'],
    match: (name, unit) => has(name, 'lmp', 'price') || unit === '$/MWh',
  },
  {
    title: 'Interchange & losses',
    first: ['Import Flow(MWh)', 'Export Flow (MWh)'],
    match: (name) => has(name, 'flow', 'losses', 'import', 'export', 'interface', 'wheel'),
  },
  {
    title: 'Costs & revenue',
    match: (name, unit) => unit === 'k$' || has(name, 'cost', 'revenue', 'payment'),
  },
  {
    title: 'Ancillary services',
    match: (name) => has(name, 'a. s.', 'a.s.', 'reserve', 'regulation'),
  },
  {
    title: 'Emissions',
    match: (name) => has(name, 'so2', 'nox', 'co2', 'emission'),
  },
  {
    // Computed at ingest, never exported: its own highlighted group so it is
    // never mistaken for a simulation output.
    title: CALCULATED_GROUP,
    match: (name) => ruleFor(name)?.derived !== undefined,
  },
];

/** Match order, NOT display order: specific tests (calculations, ancillary,
 * emissions) run before the broad unit tests they would otherwise fall into. */
const MATCH_ORDER = [
  ...GROUPS.filter(
    (g) =>
      g.title === CALCULATED_GROUP || g.title === 'Ancillary services' || g.title === 'Emissions',
  ),
  ...GROUPS,
];

export function groupOf(name: string): string {
  const unit = ruleFor(name)?.unit ?? '';
  for (const group of MATCH_ORDER) if (group.match(name, unit)) return group.title;
  return 'Other';
}

/** Sort within a group: headline columns, then varying ones, then constants. */
function rank(group: Group | undefined, name: string): number {
  const headline = group?.first?.indexOf(name) ?? -1;
  if (headline >= 0) return headline;
  const rule = ruleFor(name);
  if (!rule) return 500;
  if (rule.degenerate) return 300;
  if (rule.sparse) return 200;
  return 100;
}

/** Columns bucketed and ranked for display, "Other" last. */
export function metricGroups(names: string[]): { title: string; names: string[] }[] {
  const buckets = new Map<string, string[]>();
  for (const name of names) {
    const title = groupOf(name);
    const bucket = buckets.get(title);
    if (bucket) bucket.push(name);
    else buckets.set(title, [name]);
  }
  return [...GROUPS.map((g) => g.title), 'Other']
    .filter((title) => buckets.has(title))
    .map((title) => {
      const group = GROUPS.find((g) => g.title === title);
      const inGroup = (buckets.get(title) as string[]).sort(
        (a, b) => rank(group, a) - rank(group, b) || a.localeCompare(b),
      );
      return { title, names: inGroup };
    });
}

export function ruleFor(canonical: string): ColumnRule | undefined {
  return byCanonical.get(canonical.trim());
}

/**
 * Whether the Area Groups tab offers a metric, given the scoped tables that
 * carry it. A metric it could only refuse is left out, so the refusal lands
 * where the metric is chosen: no rule, a plain `MEAN` (no group aggregate),
 * or a WEIGHTED_MEAN whose weight is missing from any of those tables.
 * `withheldFromGroups` says why. Compare `combinesAcrossGenerators`.
 */
export function combinesAcrossAreas(
  variable: string,
  holders: readonly { readonly metrics?: readonly string[] }[],
): boolean {
  const rule = ruleFor(variable);
  if (rule?.series === 'SUM') return true;
  if (rule?.series !== 'WEIGHTED_MEAN' || !rule.weight) return false;
  const weight = rule.weight;
  return holders.every((table) => table.metrics?.includes(weight) === true);
}

/**
 * Why Area Groups does not offer a metric whose only obstacle is data: its
 * weight is not in the same table. Names the weight, since a per-column export
 * cannot supply it.
 */
export function withheldFromGroups(variable: string): string | undefined {
  const rule = ruleFor(variable);
  if (rule?.series !== 'WEIGHTED_MEAN' || !rule.weight) return undefined;
  return (
    `Area Groups does not offer "${variable}": its group mean is weighted by ` +
    `"${rule.weight}", which is not in the same Area table in every Case that has it.`
  );
}

/**
 * Area metrics that are ratios, rendered as whole percent. Not derived from
 * `class` (an intensive LMP is still a quantity); the signal is the rule's
 * `unit: "ratio"`, and tests/test_browse.mjs pins this set against it.
 */
export const RATIO_METRICS: ReadonlySet<string> = new Set(['Generation / Installed Capacity']);

// The y-scale merge belongs to the drawn line, not the kind; re-exported so
// callers reach it here.
export { scaleOf, scalesOf };

/**
 * What the picker ticks by default: served, produced, cost, moved between
 * areas, and shortfall, at about 40% of the memory of everything. Closed
 * under its dependencies (weights and calculated operands are listed), since
 * nothing is auto-added. Left off: the A.S. triads (mostly zero or
 * unprocured), `Simple Average LMP`, SO2/NOx costs (zero), the two `Total`
 * columns (spatial rule unconfirmed), and `Committed Capacity (MW)`.
 */
export const DEFAULT_METRICS: readonly string[] = [
  // What was served, and its shape.
  'Load (MWh)',
  'Served Load Including Losses (MWh)',
  'Net Load (MW)',
  // What produced it, what was available to, and how hard it was worked.
  'Generation (MWh)',
  'Available Capacity (MW)',
  'Installed Capacity (MW)',
  'Generation / Installed Capacity',
  'Gen - Load',
  'Spillage (MWh)',
  // What it cost per MWh, decomposed.
  'Avg LMP Weighted by Load ($/MWh)',
  'Avg LMP Weighted by Gen ($/MWh)',
  'LMP - Energy ($/MWh)',
  'LMP Loss Component ($/MWh)',
  'LMP Congestion Component ($/MWh)',
  // What moved between areas. The gross pair is here because `Export - Import`
  // is built from it. Only the gross pair carries `intraGroupHazard`: flows
  // between member areas cancel in the net figure when summed over a group,
  // which is why the net is the safe one to roll up.
  'Import Flow(MWh)',
  'Export Flow (MWh)',
  'Export - Import',
  'Estimated Losses (MWh)',
  // What it cost in total.
  'Generation Cost (k$)',
  'Generation Revenue (k$)',
  'Load Payment (k$)',
  // Where the system fell short, and what it emitted.
  'Unserved Load (MWh)',
  'Unserved Load Cost (k$)',
  'CO2 Amt',
];

/** The default ticks for an export's columns, or the whole union when none
 * match: a picker that opens empty reads as a failed load. */
export function defaultSelection(union: string[]): string[] {
  const wanted = new Set(DEFAULT_METRICS);
  const picked = union.filter((name) => wanted.has(name.trim()));
  return picked.length > 0 ? picked : [...union];
}

export function isDegenerate(canonical: string): boolean {
  return ruleFor(canonical)?.degenerate === true;
}

/**
 * Columns `retained` depends on but lacks: WEIGHT columns (without one, a
 * group series is an unweighted mean that reads high) and OPERANDS of
 * calculated columns (without them the column stays absent). Reported, never
 * auto-added, so the picker's MB readout prices what is allocated.
 */
export function requiredInputs(retained: string[]): string[] {
  const retainedSet = new Set(retained.map((name) => name.trim()));
  const needed = new Set<string>();
  const want = (name: string | undefined) => {
    if (name && !retainedSet.has(name)) needed.add(name);
  };
  for (const name of retainedSet) {
    const rule = ruleFor(name);
    if (!rule) continue;
    want(rule.weight);
    want(rule.fallbackWeight);
    want(rule.derived?.minuend);
    want(rule.derived?.subtrahend);
  }
  return Array.from(needed);
}

/** Calculated columns whose operands are all available: the only way they
 * reach the picker. */
export function derivedFor(available: string[]): string[] {
  const have = new Set(available.map((name) => name.trim()));
  return (rulesData.columns as ColumnRule[])
    .filter((column) => {
      const d = column.derived;
      return d !== undefined && have.has(d.minuend) && have.has(d.subtrahend);
    })
    .map((column) => column.canonical.trim());
}
