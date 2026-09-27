// src/limits/parse.ts
//
// Reading an INTERFACELIMITSCHEDULE_MONTHLY export into a `LimitTable`. No
// wasm: one row per interface per side, twelve numbers wide.
//
// Five domain rules from the data's owner, none derivable from the bytes:
//
//   1. YEAR IS DISCARDED: it carries no meaning in this export.
//   2. THE KEY IS (interface name, side). A repeated key: the FIRST row wins,
//      and the later one is dropped and COUNTED.
//   3. THE SIDE IS FOUND BY VALUE (the cell reading `MIN` or `MAX`), never by
//      header text or column position.
//   4. EITHER SIDE MAY BE ABSENT; neither implies the other.
//   5. A CELL BEYOND `±NO_LIMIT_BEYOND` MEANS NO LIMIT, per cell (a path may
//      be bounded only in some months). Magnitude only, so MIN need not be
//      negative.
//
// Monthly is the schedule's real resolution: limits change only at month
// boundaries.

import { MONTH_NAMES } from '../model/calendar';
import { normalizeCell, parseNumber, splitCsvLine } from '../lookups/parse';
import { MONTHS_PER_YEAR, type InterfaceLimit, type LimitSide, type LimitTable } from './types';

/** Beyond this magnitude a cell means "no limit this month". The export
 * writes ±99999; a threshold (strictly above 90,000, per the data owner: no
 * real rating lies in between) also catches near-spellings of the sentinel. */
export const NO_LIMIT_BEYOND = 90000;

/** The banner token in cell 1 of line 1, shared with `detect.ts`. */
export const LIMITS_BANNER = 'INTERFACELIMITSCHEDULE_MONTHLY';

/** The header naming the path (case-insensitive); absent, cell 0 is used. */
const NAME_HEADER = 'interface name';

/** How far down the header may sit; a missing header is refused, not
 * searched for. */
const MAX_HEADER_SEARCH = 20;

/** Rows a parse discarded, by the rule that discarded them. */
export interface LimitRowsDropped {
  /** Rule 2: a later row for a (name, side) already read. */
  duplicates: number;
  /** No cell reads MIN or MAX. */
  untyped: number;
  /** A marker, but a blank path name. */
  unnamed: number;
}

export interface LimitParseResult {
  table: LimitTable;
  /** Non-fatal notes; every discard is counted into one. */
  warnings: string[];
  dropped: LimitRowsDropped;
}

/** Where this parse's cells sit on a row, resolved once from the header. */
export interface LimitLayout {
  headerIndex: number;
  /** The header's cells, trimmed and lower-cased. */
  header: string[];
  nameIndex: number;
  /** Each month's column, January first, found by NAME. */
  monthIndexes: number[];
}

/** One row the table is built from: the first for its (name, side). */
export interface LimitRow {
  name: string;
  side: LimitSide;
  /** The column the side was found in (rule 3). */
  sideIndex: number;
  cells: string[];
}

/** The rows a limits file defines, before any cell becomes a number. */
export interface LimitRows {
  layout: LimitLayout;
  rows: LimitRow[];
  dropped: LimitRowsDropped;
}

/** Locate the header line and the columns on it, or return null. */
function findLayout(lines: string[]): LimitLayout | null {
  const wanted = MONTH_NAMES.map((month) => month.toLowerCase());
  const limit = Math.min(lines.length, MAX_HEADER_SEARCH);
  for (let i = 0; i < limit; i++) {
    const cells = splitCsvLine(lines[i]).map((cell) => cell.trim().toLowerCase());
    const monthIndexes = wanted.map((month) => cells.indexOf(month));
    if (monthIndexes.some((index) => index < 0)) continue;
    const named = cells.indexOf(NAME_HEADER);
    return { headerIndex: i, header: cells, nameIndex: named >= 0 ? named : 0, monthIndexes };
  }
  return null;
}

/** The side a row carries (rule 3), and where. */
function sideOf(cells: string[]): { side: LimitSide; index: number } | null {
  for (let index = 0; index < cells.length; index++) {
    const text = cells[index].trim().toLowerCase();
    if (text === 'min' || text === 'max') return { side: text, index };
  }
  return null;
}

/** Twelve monthly values, rule 5 applied per cell. */
function readMonths(cells: string[], monthIndexes: number[]): Float32Array {
  const values = new Float32Array(MONTHS_PER_YEAR);
  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const raw = cells[monthIndexes[m]];
    const text = raw === undefined ? null : normalizeCell(raw);
    const value = text === null ? null : parseNumber(text);
    values[m] = value === null || Math.abs(value) > NO_LIMIT_BEYOND ? NaN : value;
  }
  return values;
}

/**
 * Rules 2 to 4 over a file's lines: the rows the table is built from, and a
 * count of every row discarded. Null with no header. `scripts/audit-limits.mjs`
 * reads its counts off these rows, so it describes exactly what a drop keeps.
 */
export function readLimitRows(text: string): LimitRows | null {
  const lines = text.split(/\r?\n/);
  const layout = findLayout(lines);
  if (layout === null) return null;

  const rows: LimitRow[] = [];
  const seen = new Set<string>();
  const dropped: LimitRowsDropped = { duplicates: 0, untyped: 0, unnamed: 0 };

  for (let i = layout.headerIndex + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const cells = splitCsvLine(lines[i]);
    const found = sideOf(cells);
    if (found === null) {
      dropped.untyped++;
      continue;
    }
    const name = normalizeCell(cells[layout.nameIndex] ?? '');
    if (name === null) {
      dropped.unnamed++;
      continue;
    }
    // Rule 2: the first row wins; the duplicate is dropped and counted.
    const key = `${found.side}\u0000${name}`;
    if (seen.has(key)) {
      dropped.duplicates++;
      continue;
    }
    seen.add(key);
    rows.push({ name, side: found.side, sideIndex: found.index, cells });
  }
  return { layout, rows, dropped };
}

/** Parse a dropped limits file. Refuses (throws) only with no header or no
 * usable row; anything else is counted, and a half-readable file contributes
 * its readable half. */
export function parseLimitsCsv(text: string, filename: string): LimitParseResult {
  const read = readLimitRows(text);
  if (read === null) {
    throw new Error(
      `${filename}: no header line with all twelve month columns (${MONTH_NAMES.join(', ')}) in ` +
        `the first ${MAX_HEADER_SEARCH} lines, so there is no way to tell which columns hold the ` +
        `monthly limits.`,
    );
  }
  const { layout, rows, dropped } = read;
  if (rows.length === 0) {
    throw new Error(
      `${filename}: a limits header was found on line ${layout.headerIndex + 1}, but no row after ` +
        `it carried both a path name and a MIN or MAX marker, so the file defines no limits.`,
    );
  }

  const byInterface = new Map<string, { min?: Float32Array; max?: Float32Array }>();
  for (const row of rows) {
    let entry = byInterface.get(row.name);
    if (entry === undefined) {
      entry = {};
      byInterface.set(row.name, entry);
    }
    entry[row.side] = readMonths(row.cells, layout.monthIndexes);
  }

  const warnings: string[] = [];
  if (dropped.duplicates > 0) {
    warnings.push(
      `${filename}: ${dropped.duplicates.toLocaleString()} duplicate (path, MIN/MAX) row(s) ` +
        `dropped -- the first row for each was kept.`,
    );
  }
  if (dropped.untyped > 0) {
    warnings.push(
      `${filename}: ${dropped.untyped.toLocaleString()} row(s) skipped with no MIN or MAX marker ` +
        `in any cell.`,
    );
  }
  if (dropped.unnamed > 0) {
    warnings.push(
      `${filename}: ${dropped.unnamed.toLocaleString()} row(s) skipped with a blank path name.`,
    );
  }

  return {
    table: { source: filename, byInterface: byInterface as ReadonlyMap<string, InterfaceLimit> },
    warnings,
    dropped,
  };
}
