// src/lookups/merge.ts
//
// Growing the session's list: a second file of the same variant MERGES.
// New keys append; an existing key KEEPS ITS ROW (first wins, the data
// owner's rule: shared rows differ little between scenarios). Conflicts are
// counted in `differing`, the user's only sign the merge was not a clean
// superset.
//
// Decode, union, rebuild through `buildLookup`, never splice: splicing enum
// code arrays silently mislabels appended rows. Row order and codes never
// depend on arrival order; only the first-wins winner does.

import { buildLookup, type LookupRows } from './parse';
import type { LookupColumn, LookupTable } from './types';

/** One cell back as the text it was parsed from -- the merge's working form.
 * Null is blank, whatever spelling the file used. */
export function cellText(column: LookupColumn, row: number): string | null {
  switch (column.kind) {
    case 'int':
      return column.nulls[row] === 1 ? null : String(column.values[row]);
    case 'float':
      return column.nulls[row] === 1 ? null : String(column.values[row]);
    case 'bool':
      return column.values[row] === 2 ? null : column.values[row] === 1 ? 'true' : 'false';
    case 'date':
      return column.values[row] === -1 ? null : isoDate(column.values[row]);
    case 'text':
      return column.values[row] === '' ? null : column.values[row];
    case 'enum':
      return column.codes[row] === -1 ? null : column.labels[column.codes[row]];
  }
}

/** One cell as a VALUE (a number where stored as one), for sorting:
 * `cellText` stringifies, and `String(1000) < String(9)`. Both read the same
 * blanks. */
export function cellValue(column: LookupColumn, row: number): string | number | null {
  switch (column.kind) {
    case 'int':
      return column.nulls[row] === 1 ? null : column.values[row];
    case 'float':
      return column.nulls[row] === 1 ? null : column.values[row];
    default:
      return cellText(column, row);
  }
}

function isoDate(days: number): string {
  return new Date(days * 86_400_000).toISOString().slice(0, 10);
}

/** A stored table back to rows. The inverse of `buildLookup` for every value
 * a merge has to compare or carry. */
export function toRows(table: LookupTable): LookupRows {
  const columns = table.columns.map((column) => column.name);
  const rows = new Map<string | number, (string | null)[]>();
  for (const [key, row] of table.index) {
    rows.set(
      key,
      table.columns.map((column) => cellText(column, row)),
    );
  }
  return {
    entity: table.entity,
    keyColumn: table.keyColumns[0],
    columns,
    rows,
    sources: [...table.sources],
  };
}

export interface MergeResult {
  table: LookupTable;
  /** Keys the incoming file repeated. */
  alreadyKnown: number;
  /** Of those, how many disagreed on at least one shared column. The one
   * integer that says the merge was not a clean superset. */
  differing: number;
  added: number;
}

/** Merge an incoming file into the loaded list; with no list it still goes
 * through `buildLookup`, so one file equals the first half of two. */
export function mergeLookup(existing: LookupTable | undefined, incoming: LookupRows): MergeResult {
  if (!existing) {
    return {
      table: buildLookup(incoming),
      alreadyKnown: 0,
      differing: 0,
      added: incoming.rows.size,
    };
  }
  if (existing.entity !== incoming.entity) {
    throw new Error(
      `a ${incoming.entity} list cannot merge into the loaded ${existing.entity} list`,
    );
  }

  const base = toRows(existing);
  const columns = [...base.columns];
  for (const name of incoming.columns) if (!columns.includes(name)) columns.push(name);
  const at = (list: string[], name: string) => list.indexOf(name);

  // Widen the loaded rows onto the union first: a row from a file lacking a
  // column is null in it, never absent, or the rebuild would read a
  // ragged array.
  const merged = new Map<string | number, (string | null)[]>();
  for (const [key, cells] of base.rows) {
    merged.set(
      key,
      columns.map((name) => cells[at(base.columns, name)] ?? null),
    );
  }

  let alreadyKnown = 0;
  let differing = 0;
  let added = 0;
  for (const [key, cells] of incoming.rows) {
    const widened = columns.map((name) => cells[at(incoming.columns, name)] ?? null);
    const kept = merged.get(key);
    if (!kept) {
      merged.set(key, widened);
      added++;
      continue;
    }
    alreadyKnown++;
    // Compare only the columns BOTH files carried: a column the loaded row
    // never had is not a disagreement, it is new information, and counting it
    // as a conflict would make `differing` fire on every widened merge.
    for (const name of incoming.columns) {
      if (!base.columns.includes(name)) continue;
      const i = at(columns, name);
      if (kept[i] !== widened[i]) {
        differing++;
        break;
      }
    }
    // Rule 2: the loaded row stands. What the incoming file said is discarded
    // here, and `differing` is the only trace it leaves.
    for (let i = 0; i < columns.length; i++) {
      if (kept[i] === null && widened[i] !== null && !base.columns.includes(columns[i])) {
        kept[i] = widened[i];
      }
    }
  }

  const sources = [...base.sources];
  for (const source of incoming.sources) if (!sources.includes(source)) sources.push(source);

  return {
    table: buildLookup({
      entity: existing.entity,
      keyColumn: base.keyColumn,
      columns,
      rows: merged,
      sources,
    }),
    alreadyKnown,
    differing,
    added,
  };
}
