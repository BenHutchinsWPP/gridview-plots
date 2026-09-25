// src/limits/envelope.ts
//
// A limits table's half of the save envelope, as plain JSON (a few hundred
// rows of twelve numbers, readable in a debugger). `byInterface` is written as
// an array and rebuilt on read, since a Map stringifies to `{}` and every
// limit would silently vanish. NaN ("no limit this month") round-trips as
// null, so no ±99999 sentinel is ever saved.

import { MONTHS_PER_YEAR, type InterfaceLimit, type LimitTable } from './types';

/** One row as written: the path, then each side as twelve numbers with `null`
 * for a month with no limit, or `null` for a side the file never carried. */
type SerializedRow = [string, (number | null)[] | null, (number | null)[] | null];

interface SerializedTable {
  source: string;
  rows: SerializedRow[];
}

function writeSide(values: Float32Array | undefined): (number | null)[] | null {
  if (values === undefined) return null;
  // `Array.from` on a Float32Array yields NaN, which JSON.stringify writes as
  // null -- the mapping this module's header calls exact. Spelled out anyway,
  // so a reader does not have to know that to trust the round trip.
  return Array.from(values, (value) => (Number.isNaN(value) ? null : value));
}

function readSide(written: (number | null)[] | null | undefined): Float32Array | undefined {
  if (written === null || written === undefined) return undefined;
  const values = new Float32Array(MONTHS_PER_YEAR);
  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const value = written[m];
    values[m] = value === null || value === undefined ? NaN : value;
  }
  return values;
}

export function serializeLimits(table: LimitTable): unknown {
  const rows: SerializedRow[] = [];
  for (const [name, limit] of table.byInterface) {
    rows.push([name, writeSide(limit.min), writeSide(limit.max)]);
  }
  return { source: table.source, rows } satisfies SerializedTable;
}

/** Rebuild a table, or undefined for anything else. Tolerant: a bad limits
 * block must not stop the Cases restoring. */
export function deserializeLimits(written: unknown): LimitTable | undefined {
  if (typeof written !== 'object' || written === null) return undefined;
  const raw = written as Partial<SerializedTable>;
  if (typeof raw.source !== 'string' || !Array.isArray(raw.rows)) return undefined;
  const byInterface = new Map<string, InterfaceLimit>();
  for (const row of raw.rows) {
    if (!Array.isArray(row) || typeof row[0] !== 'string') continue;
    const min = readSide(row[1]);
    const max = readSide(row[2]);
    if (min === undefined && max === undefined) continue;
    byInterface.set(row[0], { min, max });
  }
  return byInterface.size === 0 ? undefined : { source: raw.source, byInterface };
}

/** A per-Case limits table as a bundle stores it: by case INDEX, never a
 * live Case id (see `SavedPin`). */
export interface SavedCaseLimits {
  /** Index into the bundle manifest's `cases`. */
  readonly case: number;
  readonly table: unknown;
}

/** Live per-Case limits as a bundle stores them. `caseIds` is the bundle's
 * case list in manifest order; a table whose Case the bundle does not carry is
 * not saved, since nothing could restore it. */
export function saveCaseLimits(
  byCase: ReadonlyMap<string, LimitTable>,
  caseIds: readonly string[],
): SavedCaseLimits[] {
  const out: SavedCaseLimits[] = [];
  for (const [caseId, table] of byCase) {
    const index = caseIds.indexOf(caseId);
    if (index >= 0) out.push({ case: index, table: serializeLimits(table) });
  }
  return out;
}

/** Per-Case limits keyed by case index. `byCase` is written; older bundles'
 * `cases` (keyed by the manifest's own Case ids) is read only. `dropped`
 * counts tables naming a Case the bundle lacks, for the load note. */
export function readCaseLimits(
  written: { byCase?: unknown; cases?: Record<string, unknown> } | undefined,
  manifestCaseIds: readonly string[],
): { byIndex: Map<number, LimitTable>; dropped: number } {
  const byIndex = new Map<number, LimitTable>();
  let dropped = 0;
  const add = (index: number, raw: unknown) => {
    const table = deserializeLimits(raw);
    if (table === undefined) return;
    if (Number.isInteger(index) && index >= 0 && index < manifestCaseIds.length) {
      byIndex.set(index, table);
    } else {
      dropped++;
    }
  };
  if (Array.isArray(written?.byCase)) {
    for (const entry of written.byCase as Partial<SavedCaseLimits>[]) {
      if (typeof entry?.case === 'number') add(entry.case, entry.table);
    }
  }
  for (const [savedId, raw] of Object.entries(written?.cases ?? {})) {
    add(manifestCaseIds.indexOf(savedId), raw);
  }
  return { byIndex, dropped };
}

/** Per-Case limits resolved against the Cases a restore made (index i is
 * `manifest.cases[i]`): the ONE place a saved table meets a live id. */
export function restoreCaseLimits(
  byIndex: ReadonlyMap<number, LimitTable>,
  cases: readonly { readonly id: string }[],
): [string, LimitTable][] {
  const out: [string, LimitTable][] = [];
  for (const [index, table] of byIndex) {
    const owner = cases[index];
    if (owner) out.push([owner.id, table]);
  }
  return out;
}
