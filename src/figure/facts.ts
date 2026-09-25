// src/figure/facts.ts
//
// Where each fact about the lines goes in a figure. **A fact is stated once,
// in the place that covers every line it is true of**: what every line shares
// moves up (the context line, an axis title, a footnote), and only what
// differs is a legend column. The pane's hover labels make the same split
// (`shortLabels` in src/series/label.ts) but drop the shared facts; a figure
// read in a report has no app beside it, so it keeps them.
//
//   | Fact                  | Same for every line  | Differs                 |
//   |-----------------------|----------------------|-------------------------|
//   | Case                  | context `Case: …`    | legend column           |
//   | Kind                  | context, w/ quantity | legend column           |
//   | Quantity + unit       | y-axis title         | column if one unit      |
//   | Key                   | legend column        | legend column           |
//   | "% of range" divisor  | y-axis title         | legend column           |
//   | Group filters         | footnote             | line under the row      |
//   | Weighted mean         | footnote             | line under the row      |
//   | Axis side (2 scales)  | —                    | legend column           |
//   | Warning               | footnote             | footnote + row marker   |
//
// Pane-neutral and kind-neutral: it reads facets, which every kind builds.

import { kindNoun, subjectLabel, type SeriesFacets } from '../series/label';
import { scalesOf } from '../series/scales';

/** What placement reads of one drawn line. */
export interface FactLine {
  /** The pane's name for the line, used only when it has no facets. */
  readonly name: string;
  readonly facets?: SeriesFacets;
  readonly unit: string;
  /** Which y scale the line is read against: 0 left, 1 right. */
  readonly side: number;
  /** An Area weighted mean's weight column; absent when not weighted. */
  readonly weightColumn?: string;
  /** Caveats the line was drawn with (a plain-mean fallback, a unit with no
   * max cap), as the kind wrote them. */
  readonly warnings?: readonly string[];
}

/** A legend column: a short stable key (`case`, `key`) and one cell per line. */
export interface LegendColumn {
  readonly key: string;
  readonly cells: readonly string[];
}

export interface PlacedFacts {
  /** What every line shares, or '' when they share nothing worth a line. */
  readonly context: string;
  /** One title per y scale, by side. */
  readonly yTitles: readonly string[];
  /** In reading order: Case, kind, quantity, key, then qualifiers. */
  readonly columns: readonly LegendColumn[];
  /** Per line, a second line under its legend row, or ''. */
  readonly underRow: readonly string[];
  /** Footnotes that placement decided, before the pane's own. */
  readonly notes: readonly string[];
  /** What the caption and filename name: a fact every line shares, or null
   * where lines differ; `keys` per line. */
  readonly naming: FigureNaming;
}

export interface FigureNaming {
  readonly caseLabel: string | null;
  readonly kind: string | null;
  readonly quantity: string | null;
  readonly range: string | null;
  readonly cases: readonly string[];
  readonly quantities: readonly string[];
  readonly keys: readonly string[];
}

/** The quantity without a trailing ` (unit)`: the axis title states the unit
 * once, or states a divisor in its place. */
function bareQuantity(variable: string, unit: string): string {
  const suffix = ` (${unit})`;
  return unit && variable.endsWith(suffix) ? variable.slice(0, -suffix.length) : variable;
}

function filterText(facets: SeriesFacets | undefined): string {
  const filters = facets?.filters ?? [];
  return filters.map((entry) => `${entry.label} ${entry.constraint}`).join('; ');
}

/** Every value the same, and not blank. */
function sharedValue(values: readonly string[]): string | null {
  const first = values[0];
  return first && values.every((value) => value === first) ? first : null;
}

function distinct(values: readonly string[]): number {
  return new Set(values).size;
}

/** The footnote marks, in the order a report reader expects them. */
const MARKS = ['*', '†', '‡', '§', '¶'];

/** The `n`th mark: `*` … `¶`, then doubled, tripled. */
export function footnoteMark(n: number): string {
  return MARKS[n % MARKS.length].repeat(Math.floor(n / MARKS.length) + 1);
}

export function placeFacts(lines: readonly FactLine[]): PlacedFacts {
  const cases = lines.map((line) => line.facets?.caseLabel ?? '');
  const kinds = lines.map((line) => (line.facets ? kindNoun(line.facets.kind) : ''));
  // The quantity as the line's table names it, minus the unit its axis states.
  const quantities = lines.map((line) =>
    line.facets ? bareQuantity(line.facets.variable, line.facets.unit) : '',
  );
  const ranges = lines.map((line) => line.facets?.range ?? '');
  const keys = lines.map((line) =>
    line.facets ? (line.facets.figureSubject ?? subjectLabel(line.facets)) : line.name,
  );
  const filters = lines.map((line) => filterText(line.facets));
  const weights = lines.map((line) =>
    line.weightColumn ? `weighted mean by ${line.weightColumn}` : '',
  );

  const sides = [...new Set(lines.map((line) => line.side))].sort((a, b) => a - b);
  const onSide = (side: number): number[] =>
    lines.flatMap((line, index) => (line.side === side ? [index] : []));

  const sharedCase = sharedValue(cases);
  const sharedKind = sharedValue(kinds);
  const sharedQuantity = sharedValue(quantities);
  const context = [
    sharedCase ? `Case: ${sharedCase}` : '',
    [sharedKind ?? '', sharedQuantity ?? ''].filter(Boolean).join(' · '),
  ]
    .filter(Boolean)
    .join(' · ');

  // Two quantities read against one axis are told apart only by a column; on
  // two axes, each axis title names its own.
  let quantityColumn = false;
  let rangeColumn = false;
  const yTitles = sides.map((side) => {
    const indexes = onSide(side);
    const sideQuantities = indexes.map((i) => quantities[i]);
    const sideRanges = indexes.map((i) => ranges[i]);
    if (distinct(sideQuantities) > 1) quantityColumn = true;
    if (distinct(sideRanges) > 1) rangeColumn = true;
    const allRange = sideRanges.every(Boolean);
    const unit = allRange
      ? (sharedValue(sideRanges) ?? '%')
      : scalesOf(indexes.map((i) => ({ unit: lines[i].unit })))[0].label;
    const quantity = sharedValue(sideQuantities);
    return quantity ? `${quantity} (${unit})` : unit;
  });

  const columns: LegendColumn[] = [];
  if (!sharedCase && distinct(cases) > 1) columns.push({ key: 'case', cells: cases });
  if (!sharedKind && distinct(kinds) > 1) columns.push({ key: 'kind', cells: kinds });
  if (quantityColumn) columns.push({ key: 'quantity', cells: quantities });
  columns.push({ key: 'key', cells: keys });

  // A warning every line carries is a plain footnote; one that only some
  // carry is marked on their rows, so the caveat stays with its line.
  const notes: string[] = [];
  const marks = lines.map(() => '');
  const warned = new Map<string, number[]>();
  lines.forEach((line, index) => {
    for (const warning of new Set(line.warnings ?? [])) {
      warned.set(warning, [...(warned.get(warning) ?? []), index]);
    }
  });
  let marked = 0;
  for (const [warning, indexes] of warned) {
    if (indexes.length === lines.length) {
      notes.push(warning);
      continue;
    }
    const mark = footnoteMark(marked++);
    notes.push(`${mark} ${warning}`);
    for (const index of indexes) marks[index] += mark;
  }
  if (marks.some(Boolean)) columns.push({ key: 'mark', cells: marks });

  if (rangeColumn) columns.push({ key: 'range', cells: ranges });
  if (sides.length > 1) {
    columns.push({ key: 'axis', cells: lines.map((line) => (line.side === 0 ? 'left' : 'right')) });
  }

  // One line's filter or weight is shared by definition, so it is a
  // footnote too.
  const sharedFilter = sharedValue(filters);
  const sharedWeight = sharedValue(weights);
  const shared = [
    sharedFilter ? `Group filter: ${sharedFilter}` : '',
    sharedWeight ? sharedWeight[0].toUpperCase() + sharedWeight.slice(1) : '',
  ].filter(Boolean);
  notes.unshift(...shared);
  const underRow = lines.map((_, i) =>
    [!sharedFilter && filters[i] ? `filtered: ${filters[i]}` : '', !sharedWeight ? weights[i] : '']
      .filter(Boolean)
      .join(' · '),
  );

  const naming: FigureNaming = {
    caseLabel: sharedCase,
    kind: sharedKind,
    quantity: sharedQuantity,
    range: sharedValue(ranges),
    cases,
    quantities,
    keys,
  };
  return { context, yTitles, columns, underRow, notes, naming };
}
