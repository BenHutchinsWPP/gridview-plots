// src/tables/long/sample-years.ts
//
// A long file's years as the Import Dialog shows them, read from its first
// and last rows before any parse. A long file has no date line, and its full
// axis scan runs only once the dialog has answered, so without this a 2045
// file joins a 2035 Case and is refused only after the load starts.
//
// **A hint for the dialog, never an input to ingest.** Row order carries no
// meaning (AGENTS.md), so only a file whose sampled rows run in date order, or
// one small enough to be read whole, is taken to start and end where its
// sample does. Any other sample proves only that its years are in the file.
// The scan still reads every row and still has the last word.
//
// `readDate` mirrors `date_to_day` in parser/common/fields.h, which the dialog
// must agree with: tests/test_sample_years.mjs runs the same cells through
// both.

import type { YearSpan } from '../../model/calendar';

/** The years a long file's sample shows. */
export interface SampledYears extends YearSpan {
  /** True when the span is the file's own: the whole file was read, or its
   * sampled rows run in date order. False: only these years are known to
   * be in it. */
  whole: boolean;
}

const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** A `0:00`, `00:00:00`, `12:00:00 AM` after the date, as the C reader allows. */
const MIDNIGHT = /^(?:0+:0+(?::0+)?|12:0+(?::0+)?[ \t]*[aA][mM])$/;

/**
 * A Date cell's year and its day of that year (month × 31 + day, enough to
 * order two dates), or null where the parser would refuse it: not M/D/YYYY,
 * a day its month lacks, a Feb 29 of a non-leap year, a time past midnight.
 */
export function readDate(cell: string): { year: number; order: number } | null {
  const match = /^(\d+)\/(\d+)\/(\d+)(?:[ \t]+(.+))?$/.exec(cell.replace(/^[ \t]+|[ \t]+$/g, ''));
  if (!match) return null;
  if (match[4] !== undefined && !MIDNIGHT.test(match[4])) return null;
  const [month, day, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1 || day > MONTH_DAYS[month - 1]) return null;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  if (month === 2 && day === 29 && !leap) return null;
  return { year, order: year * 400 + month * 31 + day };
}

/** Each complete row's Date, in file order. `cutFirst` drops the first line
 * (the header, or a row the tail chunk cut); `cutLast` the last, which the
 * head chunk may have cut. */
function datesOf(bytes: Uint8Array, cutFirst: boolean, cutLast: boolean) {
  const lines = new TextDecoder().decode(bytes).split('\n');
  if (cutFirst) lines.shift();
  if (cutLast) lines.pop();
  const dates: { year: number; order: number }[] = [];
  for (const line of lines) {
    const comma = line.indexOf(',');
    const date = readDate(comma < 0 ? line.replace(/\r$/, '') : line.slice(0, comma));
    if (date) dates.push(date);
  }
  return dates;
}

const ascending = (dates: readonly { order: number }[]): boolean =>
  dates.every((date, i) => i === 0 || dates[i - 1].order <= date.order);

/**
 * The years a long file's rows show. `head` starts at byte 0 (its header
 * line is skipped); `tail` ends at the file's last byte, or is null when
 * `head` is the whole file. Undefined when no row's Date reads.
 */
export function sampleYears(head: Uint8Array, tail: Uint8Array | null): SampledYears | undefined {
  const first = datesOf(head, true, tail !== null);
  const last = tail === null ? [] : datesOf(tail, true, false);
  const all = [...first, ...last];
  if (all.length === 0) return undefined;
  const years = all.map((date) => date.year);
  const firstYear = Math.min(...years);
  return {
    firstYear,
    numYears: Math.max(...years) - firstYear + 1,
    whole: tail === null || ascending(all),
  };
}
