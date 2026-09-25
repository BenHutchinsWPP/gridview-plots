// src/ui/browse-csv.ts
//
// The CSV the browse drawer's download writes, DOM-free: the view's rows,
// sort, columns and order, under `#` descriptor lines stating what the
// numbers depend on (cases, variable, hour mask, filters, group-by).
//
//   * **Export is not paint.** Cells carry the full-precision double (a ratio
//     as a ratio), never the on-screen rounding.
//   * **The descriptor states only what was applied**: filters the row pass
//     or the grouped build used, in `filterConstraint`'s wording, never a
//     stale key that constrained nothing.
//   * **A "% of range" cell is a ratio** in every drawer export, and the
//     descriptor says so.

import {
  filterConstraint,
  visibleColumns,
  visibleRows,
  type BrowseTab,
  type ViewState,
} from './browse-model';
import { csvField } from './hourly-csv';

/** What the drawer knows that the tab cannot: the hour filter sentence, and
 * the dropdown's variable (the fallback for empty or mixed-kind tabs). */
export interface BrowseCsvMeta {
  readonly hourFilter: string;
  readonly variable: string;
  readonly caseLabel: (caseId: string) => string;
}

/** A cell: text as-is, numbers at full precision, NaN and null as empty. */
function csvCell(value: string | number | null): string {
  if (value === null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return csvField(value);
}

/** Distinct values of `read` over the exported rows, or `fallback`. */
function distinctFrom(order: Int32Array, read: (row: number) => string, fallback: string): string {
  const seen = new Set<string>();
  for (let i = 0; i < order.length; i++) seen.add(read(order[i]));
  if (seen.size === 0) return fallback;
  return [...seen].join(', ');
}

/** How a "% of range" value is written in every drawer export. */
const RATIO_NOTE = 'values are ratios of range (0.42 = 42%)';

/** The `#` lines stating what a drawer export's numbers depend on: the Cases
 * and variable of the exported rows, the hour filter, the filters that were
 * applied, the group-by and "% of range". The stats file and the hourly files
 * open with the same lines. */
export function browseDescriptor(tab: BrowseTab, view: ViewState, meta: BrowseCsvMeta): string[] {
  const order = visibleRows(tab, view);
  const byKey = new Map(visibleColumns(tab, view).map((column) => [column.key, column]));

  const descriptor: string[] = [
    `# Cases: ${distinctFrom(order, (row) => meta.caseLabel(tab.rows[row].caseId), '(none)')}`,
    `# Variable: ${distinctFrom(order, (row) => tab.rows[row].variable, meta.variable)}`,
    `# Hours: ${meta.hourFilter}`,
  ];

  // Only filters that constrained something: applied by the row pass (their
  // column is here) or by the grouped build (their label is frozen on rows).
  const frozen = new Map<string, string>();
  for (const row of tab.rows)
    for (const entry of row.filterContext ?? []) frozen.set(entry.key, entry.label);
  const applied: string[] = [];
  for (const [key, filter] of view.filters) {
    const column = byKey.get(key);
    if (column) applied.push(`${column.label}: ${filterConstraint(filter)}`);
    else if (frozen.has(key)) applied.push(`${frozen.get(key)}: ${filterConstraint(filter)}`);
  }
  if (applied.length > 0) descriptor.push(`# Column filters: ${applied.join('; ')}`);

  if (view.groupBy) {
    // The group-by as the rows name it, else the column key, else the raw key.
    const named = order.length > 0 ? tab.rows[order[0]].groupBy : undefined;
    descriptor.push(`# Grouped by: ${named ?? byKey.get(view.groupBy)?.label ?? view.groupBy}`);
  }

  // A ratio, in words: 0.42 under a "%" header is otherwise read as 0.42%.
  const perUnit = order.filter((row) => tab.rows[row].perUnit).length;
  if (perUnit > 0) {
    descriptor.push(
      perUnit === order.length
        ? `# % of range: ${RATIO_NOTE}; every series of its limit (summed, for a group), else of its own peak`
        : `# % of range: ${RATIO_NOTE}; ${perUnit} of ${order.length} series of their limit (summed, for a group), else of their own peak`,
    );
  }
  return descriptor;
}

/** The tab as CSV: descriptor lines, a blank line, the header, then every
 * `visibleRows` row (not just the painted ones) in sort order. */
export function browseTableCsv(tab: BrowseTab, view: ViewState, meta: BrowseCsvMeta): string {
  const order = visibleRows(tab, view);
  // The columns the VIEW shows, for header and rows alike.
  const shown = visibleColumns(tab, view);
  const rows = [
    browseDescriptor(tab, view, meta).join('\n'),
    '',
    shown.map((column) => csvField(column.label)).join(','),
  ];
  for (let i = 0; i < order.length; i++) {
    const rowIndex = order[i];
    rows.push(shown.map((column) => csvCell(column.value(rowIndex))).join(','));
  }
  return rows.join('\n') + '\n';
}
