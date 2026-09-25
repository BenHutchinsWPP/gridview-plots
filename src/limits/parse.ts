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

export interface LimitParseResult {
  table: LimitTable;
  /** Non-fatal notes; every discard is counted into one. */
  warnings: string[];
}

/** Where this parse's cells sit on a row, resolved once from the header. */
interface Layout {
  headerIndex: number;
  nameIndex: number;
  /** Each month's column, January first, found by NAME. */
  monthIndexes: number[];
}

/** Locate the header line and the columns on it, or return null. */
function findLayout(lines: string[]): Layout | null {
  const wanted = MONTH_NAMES.map((month) => month.toLowerCase());
  const limit = Math.min(lines.length, MAX_HEADER_SEARCH);
  for (let i = 0; i < limit; i++) {
    const cells = splitCsvLine(lines[i]).map((cell) => cell.trim().toLowerCase());
    const monthIndexes = wanted.map((month) => cells.indexOf(month));
    if (monthIndexes.some((index) => index < 0)) continue;
    const named = cells.indexOf(NAME_HEADER);
    return { headerIndex: i, nameIndex: named >= 0 ? named : 0, monthIndexes };
  }
  return null;
}

/** The side a row carries (rule 3). */
function sideOf(cells: string[]): LimitSide | null {
  for (const cell of cells) {
    const text = cell.trim().toLowerCase();
    if (text === 'min') return 'min';
    if (text === 'max') return 'max';
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

/** Parse a dropped limits file. Refuses (throws) only with no header or no
 * usable row; anything else is counted, and a half-readable file contributes
 * its readable half. */
export function parseLimitsCsv(text: string, filename: string): LimitParseResult {
  const lines = text.split(/\r?\n/);
  const layout = findLayout(lines);
  if (layout === null) {
    throw new Error(
      `${filename}: no header line with all twelve month columns (${MONTH_NAMES.join(', ')}) in ` +
        `the first ${MAX_HEADER_SEARCH} lines, so there is no way to tell which columns hold the ` +
        `monthly limits.`,
    );
  }

  const byInterface = new Map<string, { min?: Float32Array; max?: Float32Array }>();
  let rows = 0;
  let duplicates = 0;
  let untyped = 0;
  let unnamed = 0;

  for (let i = layout.headerIndex + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const cells = splitCsvLine(lines[i]);
    const side = sideOf(cells);
    if (side === null) {
      untyped++;
      continue;
    }
    const name = normalizeCell(cells[layout.nameIndex] ?? '');
    if (name === null) {
      unnamed++;
      continue;
    }
    let entry = byInterface.get(name);
    if (entry === undefined) {
      entry = {};
      byInterface.set(name, entry);
    }
    // Rule 2: the first row wins; the duplicate is dropped and counted.
    if (entry[side] !== undefined) {
      duplicates++;
      continue;
    }
    entry[side] = readMonths(cells, layout.monthIndexes);
    rows++;
  }

  if (rows === 0) {
    throw new Error(
      `${filename}: a limits header was found on line ${layout.headerIndex + 1}, but no row after ` +
        `it carried both a path name and a MIN or MAX marker, so the file defines no limits.`,
    );
  }

  const warnings: string[] = [];
  if (duplicates > 0) {
    warnings.push(
      `${filename}: ${duplicates.toLocaleString()} duplicate (path, MIN/MAX) row(s) dropped -- ` +
        `the first row for each was kept.`,
    );
  }
  if (untyped > 0) {
    warnings.push(
      `${filename}: ${untyped.toLocaleString()} row(s) skipped with no MIN or MAX marker in any ` +
        `cell.`,
    );
  }
  if (unnamed > 0) {
    warnings.push(
      `${filename}: ${unnamed.toLocaleString()} row(s) skipped with a blank path name.`,
    );
  }

  return {
    table: { source: filename, byInterface: byInterface as ReadonlyMap<string, InterfaceLimit> },
    warnings,
  };
}
