// src/ui/hourly-csv.ts
//
// The one writer for hourly CSV, DOM-free: the hour columns, the cell format
// and field quoting that every hourly file shares, so the same hour reads the
// same in the chart pane's download and the browse drawer's. The drawer's
// stats file quotes its fields here too.
//
//   * **A cell is the float32 it came from, not a double's noise.** A value
//     read out of a Float32Array prints as `0.10000000149011612` through
//     `String`; the shortest of 7, 8 or 9 significant digits that reads back
//     to the same float32 is exact and short. 9 always does, so the loop ends.
//     A shortest-digits search is about 3x the cost per cell.
//   * **A "% of range" percent becomes its ratio by moving the decimal point
//     as a string**, never by dividing: `42.1 / 100` in doubles is
//     `0.42100000000000004`, and the percent was already the exact text.

import { dayOfMonth, monthOf } from './chart-format';
import { HOURS_PER_YEAR, MONTH_NAMES } from '../model/calendar';
import { kindNoun, shortLabels, type SeriesFacets } from '../series/label';

/** The hour columns, in the order `hourFields` writes them. HourOfYear is
 * 0-based, HE hour-ending 1-24. */
export const HOUR_COLUMNS = ['Month', 'Day', 'HE', 'HourOfYear'] as const;

/** The hour columns' cells for one hour-of-year, comma-joined. */
export function hourFields(hour: number): string {
  return `${MONTH_NAMES[monthOf(hour)]},${dayOfMonth(hour)},${(hour % 24) + 1},${hour}`;
}

/** One CSV field, quoted when it carries a delimiter. `;` counts: it is the
 * list separator Excel splits on in comma-decimal locales, and series labels
 * carry it. */
export function csvField(value: string): string {
  return /[",;\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Drop a decimal's trailing zeros (and a bare point), keeping any exponent. */
function trimZeros(text: string): string {
  const e = text.indexOf('e');
  const mantissa = e < 0 ? text : text.slice(0, e);
  const exponent = e < 0 ? '' : text.slice(e);
  if (!mantissa.includes('.')) return text;
  return mantissa.replace(/0+$/, '').replace(/\.$/, '') + exponent;
}

/** A float32 value as a cell: blank when not finite, an integer bare,
 * otherwise the first of 7, 8 or 9 significant digits that round-trips. */
export function formatCell(value: number): string {
  if (!Number.isFinite(value)) return '';
  // Bare below 1e9 only: above it a float32 integer's trailing digits are
  // rounding, and `String` would print all of them.
  if (Number.isInteger(value) && Math.abs(value) < 1e9) return String(value);
  const target = Math.fround(value);
  for (let digits = 7; digits < 9; digits++) {
    const text = value.toPrecision(digits);
    if (Math.fround(Number(text)) === target) return trimZeros(text);
  }
  return trimZeros(value.toPrecision(9));
}

/** A percent cell's text as its ratio: the decimal point moved two places
 * left, in the digits `formatCell` printed. */
export function percentTextAsRatio(text: string): string {
  if (text === '') return '';
  const e = text.indexOf('e');
  if (e >= 0) {
    // 1.5e-7 % is 1.5e-9: the mantissa stays, the exponent moves.
    return `${text.slice(0, e)}e${formatExponent(Number(text.slice(e + 1)) - 2)}`;
  }
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const point = unsigned.indexOf('.');
  const whole = point < 0 ? unsigned : unsigned.slice(0, point);
  const fraction = point < 0 ? '' : unsigned.slice(point + 1);
  const digits = whole + fraction;
  const at = whole.length - 2;
  const shifted =
    at <= 0 ? `0.${'0'.repeat(-at)}${digits}` : `${digits.slice(0, at)}.${digits.slice(at)}`;
  const [left, right] = shifted.split('.');
  const intPart = left.replace(/^0+(?=\d)/, '');
  const fracPart = right.replace(/0+$/, '');
  const out = fracPart === '' ? intPart : `${intPart}.${fracPart}`;
  return negative && out !== '0' ? `-${out}` : out;
}

function formatExponent(exponent: number): string {
  return exponent < 0 ? String(exponent) : `+${exponent}`;
}

/** A drawn "% of range" value (float32, x100) as its ratio cell. */
export function formatRatioCell(percent: number): string {
  return percentTextAsRatio(formatCell(percent));
}

// ------------------------------------------------ the drawer's hourly files
//
// A drawer export is a header (the tab's descriptor, then one key line per
// series, the warnings and the refusals) and 8,760 rows per layout unit:
//
//   * **wide**: one row per hour, one column per series.
//   * **long**: `Series, Month, Day, HE, HourOfYear, Value`, one row per
//     series-hour, written one series at a time.
//
// Two layouts and never an automatic switch between them: one click must
// produce one file shape. Every series has all 8,760 hours and a masked hour
// is a blank cell, so two exports of one Case line up row for row.

/** Excel's 16,384 columns, less the four hour columns. */
export const WIDE_MAX_SERIES = 16_380;
/** The most series whose long rows fit Excel's 1,048,576: 120 x 8,760 does
 * not. */
export const LONG_EXCEL_SERIES = 119;

export type HourlyLayout = 'wide' | 'long';

/** The unit a "% of range" cell is written in. A ratio, so 0.42 is 42%. */
export const RATIO_UNIT = 'ratio of range';

/** One exported series as its resolve left it; values travel separately. */
export interface HourlyEntry {
  readonly facets: SeriesFacets;
  /** Why it has no values, or `''` when it has them. */
  readonly refusal: string;
  readonly warnings: readonly string[];
  /** Its values are drawn "% of range" percents, written as ratios. */
  readonly ratio: boolean;
}

/** The unit a series' cells are in. */
function unitOf(entry: HourlyEntry): string {
  return entry.ratio ? RATIO_UNIT : entry.facets.unit;
}

/**
 * Each series' name: the legend's shorthand over the exported set, with its
 * unit. A name two series would share takes its 1-based position, so the
 * header, the `Series` column and the key join one to one.
 */
export function hourlyNames(entries: readonly HourlyEntry[]): string[] {
  const short = shortLabels(entries.map((entry) => entry.facets));
  const names = short.map((label, i) => `${label} [${unitOf(entries[i])}]`);
  const count = new Map<string, number>();
  for (const name of names) count.set(name, (count.get(name) ?? 0) + 1);
  const out = names.map((name, i) => ((count.get(name) ?? 0) > 1 ? `${name} (${i + 1})` : name));
  if (new Set(out).size !== out.length) throw new Error('two exported series share a name');
  return out;
}

const orNone = (text: string | undefined): string => (text ? text : 'none');

/** The facets that name one series, in the key's order. */
function keyFields(entry: HourlyEntry): [string, string][] {
  const { facets } = entry;
  return [
    ['Kind', kindNoun(facets.kind)],
    ['Case', facets.caseLabel],
    ['Subject', facets.subject],
    ['Group-by', orNone(facets.groupBy)],
    [
      'Filters',
      orNone(facets.filters?.map((entry) => `${entry.label} ${entry.constraint}`).join('; ')),
    ],
    ['Variable', facets.variable],
    ['Unit', unitOf(entry)],
    // `% of limit` names a percent's divisor; the cells are ratios of it.
    ['Divisor', orNone(facets.range?.replace(/^% of /, ''))],
  ];
}

/** The facets every series shares, stated once rather than in every name. */
function sharedLine(entries: readonly HourlyEntry[]): string[] {
  if (entries.length === 0) return [];
  const fields = entries.map(keyFields);
  const shared = fields[0].filter(
    ([label, value], i) =>
      label !== 'Subject' &&
      fields.every((other) => other[i][0] === label && other[i][1] === value),
  );
  if (shared.length === 0) return [];
  return [`# Every series: ${shared.map(([label, value]) => `${label}: ${value}`).join(' | ')}`];
}

/** Warnings once each, with how many series raised them; then the notes the
 * tab showed above its rows, which are not all warnings. */
function warningLines(entries: readonly HourlyEntry[], notes: readonly string[]): string[] {
  const count = new Map<string, number>();
  for (const entry of entries)
    for (const warning of new Set(entry.warnings))
      count.set(warning, (count.get(warning) ?? 0) + 1);
  const lines = [...count].map(([warning, n]) =>
    `# Warnings: ${warning} (${n} series)`.replace(/\r?\n/g, ' '),
  );
  for (const note of new Set(notes)) lines.push(`# Notes: ${note}`.replace(/\r?\n/g, ' '));
  return lines;
}

/** How many names a refusal line lists before counting the rest. */
const REFUSAL_NAMES = 5;

/** Refused series grouped by reason, each with a count and a few names. */
function refusalLines(entries: readonly HourlyEntry[], names: readonly string[]): string[] {
  const byReason = new Map<string, string[]>();
  entries.forEach((entry, i) => {
    if (!entry.refusal) return;
    const list = byReason.get(entry.refusal) ?? [];
    list.push(names[i]);
    byReason.set(entry.refusal, list);
  });
  return [...byReason].map(([reason, list]) => {
    const shown = list.slice(0, REFUSAL_NAMES).join('; ');
    const rest = list.length > REFUSAL_NAMES ? ` and ${list.length - REFUSAL_NAMES} more` : '';
    return `# Refused: ${reason} (${list.length} series, blank: ${shown}${rest})`.replace(
      /\r?\n/g,
      ' ',
    );
  });
}

/** The long layout's column header. */
export const LONG_COLUMNS = ['Series', ...HOUR_COLUMNS, 'Value'] as const;

/**
 * Everything above the first hour row: the descriptor, the shared facets, a
 * key line per series, the warnings and refusals, a blank line, and the
 * column header. Ends on a newline.
 */
export function hourlyHeader(
  layout: HourlyLayout,
  descriptor: readonly string[],
  entries: readonly HourlyEntry[],
  names: readonly string[],
  notes: readonly string[],
): string {
  const lines = [
    ...descriptor,
    ...sharedLine(entries),
    ...entries.map(
      (entry, i) =>
        `# Series: ${names[i]} | ${keyFields(entry)
          .map(([label, value]) => `${label}: ${value}`)
          .join(' | ')}`,
    ),
    ...warningLines(entries, notes),
    ...refusalLines(entries, names),
    '',
    layout === 'wide'
      ? [...HOUR_COLUMNS, ...names.map(csvField)].join(',')
      : LONG_COLUMNS.join(','),
  ];
  return lines.join('\n') + '\n';
}

/** A series' cell at one hour: blank when refused or masked. */
function cellAt(values: Float32Array | null, ratio: boolean, hour: number): string {
  if (values === null) return '';
  return ratio ? formatRatioCell(values[hour]) : formatCell(values[hour]);
}

/** Wide rows for hours `[from, to)`, one line per hour. */
export function wideRows(
  columns: readonly (Float32Array | null)[],
  ratio: readonly boolean[],
  from: number,
  to: number,
): string {
  let out = '';
  for (let hour = from; hour < to; hour++) {
    let line = hourFields(hour);
    for (let i = 0; i < columns.length; i++) line += ',' + cellAt(columns[i], ratio[i], hour);
    out += line + '\n';
  }
  return out;
}

/** One series' 8,760 long rows. */
export function longRows(name: string, values: Float32Array | null, ratio: boolean): string {
  const lead = csvField(name) + ',';
  let out = '';
  for (let hour = 0; hour < HOURS_PER_YEAR; hour++) {
    out += `${lead}${hourFields(hour)},${cellAt(values, ratio, hour)}\n`;
  }
  return out;
}

/** The widest a cell can print, sign and leading zeros of a shifted ratio
 * included (`-0.000000012345679`); asserted by the writer suite. */
export const CELL_MAX_CHARS = 19;
/** The widest hour fields: `Dec,31,24,8759`. */
const HOUR_FIELDS_MAX_CHARS = 14;

const utf8 = new TextEncoder();
/** Bytes of a string as UTF-8, which is what the Blob holds. */
export function utf8Bytes(text: string): number {
  return utf8.encode(text).length;
}

/** An upper bound on the file's UTF-8 bytes, from its exact header and names:
 * every cell is counted at its widest. */
export function hourlyFileBound(
  layout: HourlyLayout,
  headerBytes: number,
  names: readonly string[],
): number {
  // Each hour row: hour fields and one separator and cell per column, then a
  // newline.
  if (layout === 'wide') {
    return (
      headerBytes +
      HOURS_PER_YEAR * (HOUR_FIELDS_MAX_CHARS + names.length * (1 + CELL_MAX_CHARS) + 1)
    );
  }
  let rowsBytes = 0;
  for (const name of names) {
    rowsBytes +=
      HOURS_PER_YEAR *
      (utf8Bytes(csvField(name)) + 1 + HOUR_FIELDS_MAX_CHARS + 1 + CELL_MAX_CHARS + 1);
  }
  return headerBytes + rowsBytes;
}

/**
 * An upper bound on what writing the file holds at its peak: wide's float32
 * copy of every series, the text as UTF-16 (at most two bytes per UTF-8
 * byte), and the Blob. Long streams its series and holds no copies.
 */
export function hourlyPeakBytes(layout: HourlyLayout, fileBound: number, series: number): number {
  const copies = layout === 'wide' ? series * HOURS_PER_YEAR * Float32Array.BYTES_PER_ELEMENT : 0;
  return copies + 2 * fileBound + fileBound;
}

/** Why wide cannot write `series` columns, or `''` when it can. */
export function wideWithheld(series: number): string {
  if (series <= WIDE_MAX_SERIES) return '';
  return (
    `Withheld: ${series.toLocaleString()} series is more columns than Excel holds ` +
    `(${WIDE_MAX_SERIES.toLocaleString()} beside the hour columns). Filter the tab to fewer ` +
    'rows, or take the long layout.'
  );
}

/** What the long item says about `series` series: past Excel's rows, it is a
 * file for pandas or R. Always offered, since nothing else can write it. */
export function longNote(series: number): string {
  if (series <= LONG_EXCEL_SERIES) return '';
  return (
    `For pandas or R: ${(series * HOURS_PER_YEAR).toLocaleString()} rows is past ` +
    "Excel's 1,048,576."
  );
}
