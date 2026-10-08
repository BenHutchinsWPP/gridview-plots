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
import {
  MONTH_NAMES,
  SLOT_MONTH_STARTS,
  YEAR_SLOT_HOURS,
  isLeapYear,
  type YearSpan,
} from '../model/calendar';
import { NO_YEAR } from '../app/boxes';
import { kindNoun, shortLabels, type SeriesFacets } from '../series/label';

/** The hour columns, in the order `hourFields` writes them. HourOfYear is
 * the 0-based hour of the leap-calendar slot, not of the real year: Mar 1 HE 1
 * is 1440 in every year, so rows line up across years and Cases. HE is
 * hour-ending 1-24. */
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
// series, the warnings and the refusals) and its hour rows on the year slot:
//
//   * **wide**: one row per hour of the 8,784-hour slot, one column per
//     series and year of its Case. Feb 29 is always a row, blank for a
//     non-leap year's column, because the row is shared with every other
//     column.
//   * **long**: `Series, Month, Day, HE, HourOfYear, Value`, one row per
//     series-hour, written one series at a time, year after year. A year
//     writes its own days only: 8,784 rows in a leap year, 8,760 without
//     Feb 29 otherwise, since a row for a day that did not happen reads as a
//     gap.
//
// **A file names years only when it holds more than one** (`namesYears`):
// then each wide column ends in its year and long gains a `Year` column.
// A file of one year is laid out as it was before Cases spanned years, so a
// reader of those files reads the same bytes; with two years and no name a
// column or row would not say which it holds.
//
// Two layouts and never an automatic switch between them: one click must
// produce one file shape. A masked hour is a blank cell, never a missing row,
// so two exports of one Case line up row for row.

/** Excel's 16,384 columns, less the four hour columns. */
export const WIDE_MAX_COLUMNS = 16_380;
/** The most series whose long rows fit Excel's 1,048,576 whatever their
 * years: 119 x 8,784 does, 120 x 8,760 does not. */
export const LONG_EXCEL_SERIES = 119;

export type HourlyLayout = 'wide' | 'long';

/** The unit a "% of range" cell is written in. A ratio, so 0.42 is 42%. */
const RATIO_UNIT = 'ratio of range';

/** One exported series as its resolve left it; values travel separately. */
export interface HourlyEntry {
  readonly facets: SeriesFacets;
  /** Why it has no values, or `''` when it has them. */
  readonly refusal: string;
  readonly warnings: readonly string[];
  /** Its values are drawn "% of range" percents, written as ratios. */
  readonly ratio: boolean;
  /** Its Case's years: one column (wide) or one run of rows (long) each,
   * Feb 29's rows (long) only in a leap year. */
  readonly span: YearSpan;
}

/** A span's years, first to last. */
function yearsOf(span: YearSpan): number[] {
  return Array.from({ length: span.numYears }, (_, i) => span.firstYear + i);
}

/** Whether a file of these series holds more than one year, so its columns
 * and rows name theirs. A series with no Case year counts none. */
export function namesYears(entries: readonly { readonly span: YearSpan }[]): boolean {
  const years = new Set<number>();
  for (const { span } of entries) {
    if (span.numYears > 1) return true;
    if (span.firstYear !== NO_YEAR) years.add(span.firstYear);
  }
  return years.size > 1;
}

/** A year as a column name or `Year` cell names it: blank for a series with
 * no Case year, whose stand-in must never print. */
function yearText(year: number): string {
  return year === NO_YEAR ? '' : String(year);
}

/** A column header under `namesYears`: the series' name and its year. */
export function yearColumnName(name: string, year: string): string {
  return year ? `${name} ${year}` : name;
}

/** The wide columns, in file order: each series' years in turn. `series` is
 * the entry, `year` the year's index in its span. */
export function wideColumns(
  entries: readonly HourlyEntry[],
  names: readonly string[],
): { readonly series: number; readonly year: number; readonly name: string }[] {
  const withYears = namesYears(entries);
  return entries.flatMap((entry, series) =>
    yearsOf(entry.span).map((year, i) => ({
      series,
      year: i,
      name: withYears ? yearColumnName(names[series], yearText(year)) : names[series],
    })),
  );
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

/** The facets that name one series, in the key's order; its years when
 * the file names them. */
function keyFields(entry: HourlyEntry, withYears: boolean): [string, string][] {
  const { facets, span } = entry;
  const last = span.firstYear + span.numYears - 1;
  const years =
    span.firstYear === NO_YEAR
      ? 'none'
      : span.numYears > 1
        ? `${span.firstYear}–${last}`
        : String(span.firstYear);
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
    ...(withYears ? [['Years', years] as [string, string]] : []),
  ];
}

/** The facets every series shares, stated once rather than in every name. */
function sharedLine(entries: readonly HourlyEntry[], withYears: boolean): string[] {
  if (entries.length === 0) return [];
  const fields = entries.map((entry) => keyFields(entry, withYears));
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

/** The long layout's column header; `Year` only when the file names years. */
function longColumns(withYears: boolean): string {
  return ['Series', ...(withYears ? ['Year'] : []), ...HOUR_COLUMNS, 'Value'].join(',');
}

/** The wide layout's column header over these column names. */
export function wideHeaderLine(names: readonly string[]): string {
  return [...HOUR_COLUMNS, ...names.map(csvField)].join(',');
}

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
  const withYears = namesYears(entries);
  const lines = [
    ...descriptor,
    ...sharedLine(entries, withYears),
    ...entries.map(
      (entry, i) =>
        `# Series: ${names[i]} | ${keyFields(entry, withYears)
          .map(([label, value]) => `${label}: ${value}`)
          .join(' | ')}`,
    ),
    ...warningLines(entries, notes),
    ...refusalLines(entries, names),
    '',
    layout === 'wide'
      ? wideHeaderLine(wideColumns(entries, names).map((column) => column.name))
      : longColumns(withYears),
  ];
  return lines.join('\n') + '\n';
}

/** A series' cell at one hour: blank when refused or masked. */
function cellAt(values: Float32Array | null, ratio: boolean, hour: number): string {
  if (values === null) return '';
  return ratio ? formatRatioCell(values[hour]) : formatCell(values[hour]);
}

/** One wide row: the slot hour's fields, then each column's cell, each
 * column one year slot long. No newline. */
export function wideRow(
  columns: readonly (Float32Array | null)[],
  ratio: readonly boolean[],
  hour: number,
): string {
  let line = hourFields(hour);
  for (let i = 0; i < columns.length; i++) line += ',' + cellAt(columns[i], ratio[i], hour);
  return line;
}

/** Wide rows for slot hours `[from, to)`, one line per hour. */
export function wideRows(
  columns: readonly (Float32Array | null)[],
  ratio: readonly boolean[],
  from: number,
  to: number,
): string {
  let out = '';
  for (let hour = from; hour < to; hour++) out += wideRow(columns, ratio, hour) + '\n';
  return out;
}

/** Feb 29's hours in the slot, `[FEB_29_FROM, FEB_29_FROM + 24)`. */
export const FEB_29_FROM = (SLOT_MONTH_STARTS[1] + 28) * 24;

/** How many long rows a span writes: its years' real hours. */
export function longRowCount(span: YearSpan): number {
  let rows = 0;
  for (const year of yearsOf(span))
    rows += isLeapYear(year) ? YEAR_SLOT_HOURS : YEAR_SLOT_HOURS - 24;
  return rows;
}

/** One series' long rows, year after year, Feb 29's only in a leap year.
 * `withYears` leads each row's hour fields with its `Year`. */
export function longRows(
  name: string,
  values: Float32Array | null,
  ratio: boolean,
  span: YearSpan,
  withYears: boolean,
): string {
  const head = csvField(name) + ',';
  let out = '';
  yearsOf(span).forEach((year, i) => {
    const lead = withYears ? `${head}${yearText(year)},` : head;
    const slot = values?.subarray(i * YEAR_SLOT_HOURS, (i + 1) * YEAR_SLOT_HOURS) ?? null;
    const leap = isLeapYear(year);
    for (let hour = 0; hour < YEAR_SLOT_HOURS; hour++) {
      if (!leap && hour === FEB_29_FROM) hour += 24;
      out += `${lead}${hourFields(hour)},${cellAt(slot, ratio, hour)}\n`;
    }
  });
  return out;
}

/** The widest a cell can print, sign and leading zeros of a shifted ratio
 * included (`-0.000000012345679`); asserted by the writer suite. */
export const CELL_MAX_CHARS = 19;
/** The widest hour fields: `Dec,31,24,8783`. */
const HOUR_FIELDS_MAX_CHARS = 14;
/** A long row's `Year` cell and its separator, at its widest (`99999,`). */
const YEAR_FIELD_MAX_CHARS = 6;

const utf8 = new TextEncoder();
/** Bytes of a string as UTF-8, which is what the Blob holds. */
export function utf8Bytes(text: string): number {
  return utf8.encode(text).length;
}

/** An upper bound on the file's UTF-8 bytes, from its exact header, names and
 * long row counts: every cell is counted at its widest. */
export function hourlyFileBound(
  layout: HourlyLayout,
  headerBytes: number,
  names: readonly string[],
  entries: readonly HourlyEntry[],
): number {
  // Each hour row: hour fields and one separator and cell per column, then a
  // newline.
  if (layout === 'wide') {
    const columns = wideColumnCount(entries);
    return (
      headerBytes + YEAR_SLOT_HOURS * (HOUR_FIELDS_MAX_CHARS + columns * (1 + CELL_MAX_CHARS) + 1)
    );
  }
  const year = namesYears(entries) ? YEAR_FIELD_MAX_CHARS : 0;
  let rowsBytes = 0;
  names.forEach((name, i) => {
    rowsBytes +=
      longRowCount(entries[i].span) *
      (utf8Bytes(csvField(name)) + 1 + year + HOUR_FIELDS_MAX_CHARS + 1 + CELL_MAX_CHARS + 1);
  });
  return headerBytes + rowsBytes;
}

/** How many columns wide writes: one per series and year. */
export function wideColumnCount(entries: readonly { readonly span: YearSpan }[]): number {
  let columns = 0;
  for (const { span } of entries) columns += span.numYears;
  return columns;
}

/**
 * An upper bound on what writing the file holds at its peak: wide's float32
 * copy of every column (a series' every year), the text as UTF-16 (at most
 * two bytes per UTF-8 byte), and the Blob. Long streams its series and holds
 * no copies.
 */
export function hourlyPeakBytes(layout: HourlyLayout, fileBound: number, columns: number): number {
  const copies = layout === 'wide' ? columns * YEAR_SLOT_HOURS * Float32Array.BYTES_PER_ELEMENT : 0;
  return copies + 2 * fileBound + fileBound;
}

/** Why wide cannot write `columns` columns (`wideColumnCount`), or `''`
 * when it can. */
export function wideWithheld(columns: number): string {
  if (columns <= WIDE_MAX_COLUMNS) return '';
  return (
    `Withheld: ${columns.toLocaleString()} columns is more than Excel holds ` +
    `(${WIDE_MAX_COLUMNS.toLocaleString()} beside the hour columns). Filter the tab to fewer ` +
    'rows, or take the long layout.'
  );
}

/** What the long item says about `series` series: past Excel's rows, it is a
 * file for pandas or R. Always offered, since nothing else can write it. The
 * menu knows no years, so the count is the least any mix of years writes. */
export function longNote(series: number): string {
  if (series <= LONG_EXCEL_SERIES) return '';
  return (
    `For pandas or R: at least ${(series * (YEAR_SLOT_HOURS - 24)).toLocaleString()} rows ` +
    "is past Excel's 1,048,576."
  );
}
