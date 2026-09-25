// src/series/label.ts
//
// What a drawn line is CALLED. A pinned row is reached through a path
// (Case, kind, quantity, subject, and for a bucket its column and filters),
// and any part of it can vary between two lines on one pane, so a name that
// omits one can name two series. Facets are kept apart from rendering, in
// two forms:
//
//   * **FULL** names every facet: the legend, refusals, anything read alone.
//   * **SHORT** is computed over the WHOLE drawn set and keeps only facets
//     that vary within it, so a hover readout fits inside a plot. A short
//     label that is not unique in the set falls back to the full one.
//
// Imports no kind; the kind's display noun is derived from its token.

/** The facets of one drawn line: plain data, built from a browse row. */
export interface SeriesFacets {
  /** The Case's label (`caseLabel`), resolved when the line is drawn. */
  readonly caseLabel: string;
  /** The kind token (`bus`, `area`), rendered through `kindNoun`. */
  readonly kind: string;
  /** The table's quantity: `Power Flow (MW)`, or an Area metric. */
  readonly variable: string;
  readonly unit: string;
  /** The subject as the kind spells it: `WILLOWBEND (10002)`, `Coal (3 areas)`. */
  readonly subject: string;
  /** The column or authored grouping that made the bucket: `SOUTH` by zone,
   * by owner or by hand are three different series. */
  readonly groupBy?: string;
  /** A "% of range" line names its divisor (`% of limit`, `% of peak`): MW
   * and a percent are different numbers, and so are two divisors. */
  readonly range?: string;
  /** The subject as a print figure's key names it, when that differs from
   * `subject`: a group with its member count, or an interface group by its
   * name alone. A figure is frozen when exported, so it may state a count a
   * pin's label must not (an unfiltered group redraws from live membership). */
  readonly figureSubject?: string;
  /** The filters a grouped row was built under, frozen at tick time. */
  readonly filters?: readonly { readonly label: string; readonly constraint: string }[];
}

/** The separator every label in this app joins its parts with. */
const SEP = ' · ';

/** A kind's display noun, derived by capitalising the token so no second
 * list of kinds can drift from the registry. */
export function kindNoun(kind: string): string {
  return kind ? kind[0].toUpperCase() + kind.slice(1) : '';
}

/**
 * The quantity, with its unit appended only when it does not already carry
 * one: `Generation (MWh)` must not become `Generation (MWh) (MWh)`, and a bare
 * `LMP` must not go without a unit.
 */
export function variableLabel(variable: string, unit: string): string {
  if (!unit) return variable;
  return variable.includes(unit) ? variable : `${variable} (${unit})`;
}

/** The quantity as a line names it. A "% of range" line drops the unit: its
 * numbers are a percent, and the qualifier says of what. */
function quantityLabel(facets: SeriesFacets): string {
  return variableLabel(facets.variable, facets.range ? '' : facets.unit);
}

/** The subject, prefixed by its bucketing column: `Fuel Type = Gas (30
 * units)`, since `Gas` means a different set under every other column. */
export function subjectLabel(facets: SeriesFacets): string {
  return facets.groupBy ? `${facets.groupBy} = ${facets.subject}` : facets.subject;
}

/** Qualifiers that change what the numbers MEAN (normalisation, filters),
 * which the figures alone do not show. */
function qualifiers(facets: SeriesFacets): string[] {
  const out: string[] = [];
  if (facets.range) out.push(facets.range);
  if (facets.filters && facets.filters.length > 0) {
    out.push(
      `filtered: ${facets.filters.map((entry) => `${entry.label} ${entry.constraint}`).join('; ')}`,
    );
  }
  return out;
}

/** Every facet in breadcrumb order, subject last (the term a reader scans
 * for). Surfaces short of room use the short form rather than truncating. */
export function fullLabel(facets: SeriesFacets): string {
  return [
    facets.caseLabel,
    kindNoun(facets.kind),
    quantityLabel(facets),
    subjectLabel(facets),
    ...qualifiers(facets),
  ]
    .filter(Boolean)
    .join(SEP);
}

/** The full label minus the subject: the legend's second line. */
export function contextLabel(facets: SeriesFacets): string {
  return [facets.caseLabel, kindNoun(facets.kind), quantityLabel(facets), ...qualifiers(facets)]
    .filter(Boolean)
    .join(SEP);
}

/**
 * The in-plot shorthand, computed over the whole drawn set: a facet is named
 * only where the set disagrees about it, and the subject is always kept. Any
 * shorthand shared by two lines falls back to the full label for them: a name
 * that fits and names the wrong series is worse than one that wraps.
 */
export function shortLabels(facets: readonly SeriesFacets[]): string[] {
  const varies = (read: (entry: SeriesFacets) => string): boolean =>
    new Set(facets.map(read)).size > 1;

  const showCase = varies((entry) => entry.caseLabel);
  const showKind = varies((entry) => entry.kind);
  const showVariable = varies(quantityLabel);
  const showGroupBy = varies((entry) => entry.groupBy ?? '');
  const showRange = varies((entry) => entry.range ?? '');

  const short = facets.map((entry) =>
    [
      showCase ? entry.caseLabel : '',
      showKind ? kindNoun(entry.kind) : '',
      showVariable ? quantityLabel(entry) : '',
      showGroupBy ? subjectLabel(entry) : entry.subject,
      showRange ? (entry.range ?? '') : '',
    ]
      .filter(Boolean)
      .join(SEP),
  );

  const seen = new Map<string, number>();
  for (const label of short) seen.set(label, (seen.get(label) ?? 0) + 1);
  return short.map((label, i) => ((seen.get(label) ?? 0) > 1 ? fullLabel(facets[i]) : label));
}
