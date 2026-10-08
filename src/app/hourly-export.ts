// src/app/hourly-export.ts
//
// The browse drawer's hourly download as a sequence: resolve every shown row,
// name the set, ask before a large file, then write it. What it reads from
// app state comes through `HourlyExportHost`, so it imports no store; the
// root owns the resolve, the busy line, the Blob and the download.
//
//   * **Two passes over the rows.** The names are the legend's shorthand over
//     the whole set, and a divisor is known only once a line resolves, so no
//     row can be written before every row has resolved once. The first pass
//     keeps only facets, warnings and refusals; the confirm sees the exact
//     header and names; the second pass writes. Holding every series from the
//     first pass instead would allocate before the size guard could ask.
//   * **Long holds one series at a time**; wide holds a copy of each, because
//     its rows are hours and every series is read for each one.
//   * **Wide's column limit is checked twice**: before any resolve on the
//     series count, and again once the Cases' years are known, since each
//     year of a series is a column of its own.
//   * Busy is set and a frame yielded before the first resolve, then again
//     between chunks, so the progress line paints and input stays refused.

import type { BrowseRowRef } from '../ui/browse-model';
import { pinnedConstraint, rowSubject, type CaseNames } from '../ui/browse-model';
import type { CaseSeries } from '../ui/charts';
import { RANGE_LABEL } from '../series/range';
import type { SeriesFacets } from '../series/label';
import { YEAR_SLOT_HOURS, type YearSpan } from '../model/calendar';
import {
  WIDE_MAX_COLUMNS,
  hourlyFileBound,
  hourlyHeader,
  hourlyNames,
  hourlyPeakBytes,
  longRows,
  namesYears,
  utf8Bytes,
  wideColumnCount,
  wideColumns,
  wideRows,
  type HourlyEntry,
  type HourlyLayout,
} from '../ui/hourly-csv';

/** What the drawer captured at the click: the rows in the order shown, the
 * descriptor lines, and the notes the tab showed. */
export interface HourlyExportRequest {
  readonly layout: HourlyLayout;
  readonly refs: readonly BrowseRowRef[];
  readonly descriptor: readonly string[];
  readonly notes: readonly string[];
}

export interface HourlyExportHost {
  /** One row resolved into the export's scratch buffers: its values are
   * valid until the next call. `null` when its table is gone. */
  resolve(ref: BrowseRowRef): CaseSeries | null;
  /** A Case's label (`caseLabel`), for a row whose table is gone. */
  caseLabel(caseId: string): string;
  /** A Case's years: a column (wide) or run of rows (long) each, Feb 29's
   * rows (long) only for a leap year. */
  spanOfCase(caseId: string): YearSpan;
  /** Case names, for a frozen filter chosen in another Case. */
  readonly caseNames: CaseNames;
  /** The busy line: input is refused while it is set. */
  progress(message: string): void;
  /** Let the progress paint. */
  nextFrame(): Promise<void>;
  /** The size guard: `true` to go ahead. */
  confirm(bytes: number, what: string): Promise<boolean>;
}

/** Rows resolved between yields. */
const CHUNK = 50;
/** Wide hours written between yields: a month or so. */
const HOUR_CHUNK = 730;

/** The file's parts in order, for a Blob; `null` when the confirm was
 * declined. Throws when wide is asked for past its column limit. */
export async function exportHourly(
  host: HourlyExportHost,
  request: HourlyExportRequest,
): Promise<string[] | null> {
  const { layout, refs } = request;
  const total = refs.length.toLocaleString();
  host.progress(`Preparing ${total} series…`);
  await host.nextFrame();

  const entries: HourlyEntry[] = [];
  for (let start = 0; start < refs.length; start += CHUNK) {
    for (const ref of refs.slice(start, start + CHUNK)) {
      const entry = entryOf(ref, host.resolve(ref), host.caseLabel, host.caseNames);
      entries.push({ ...entry, span: host.spanOfCase(ref.caseId) });
    }
    host.progress(`Resolving series ${entries.length.toLocaleString()} of ${total}…`);
    await host.nextFrame();
  }

  const columnCount = wideColumnCount(entries);
  if (layout === 'wide' && columnCount > WIDE_MAX_COLUMNS) {
    throw new Error(
      `the wide layout holds at most ${WIDE_MAX_COLUMNS.toLocaleString()} columns, and these ` +
        `series over their Cases' years are ${columnCount.toLocaleString()}; take the long layout`,
    );
  }
  const names = hourlyNames(entries);
  const header = hourlyHeader(layout, request.descriptor, entries, names, request.notes);
  const bound = hourlyFileBound(layout, utf8Bytes(header), names, entries);
  const what = `${total} hourly series (${layout})`;
  if (!(await host.confirm(hourlyPeakBytes(layout, bound, columnCount), what))) return null;
  host.progress(`Writing ${what}…`);
  await host.nextFrame();

  const parts = [header];
  const ratio = entries.map((entry) => entry.ratio);
  if (layout === 'long') {
    const withYears = namesYears(entries);
    for (let start = 0; start < refs.length; start += CHUNK) {
      const end = Math.min(refs.length, start + CHUNK);
      for (let i = start; i < end; i++) {
        const values = entries[i].refusal ? null : valuesOf(host.resolve(refs[i]));
        parts.push(longRows(names[i], values, ratio[i], entries[i].span, withYears));
      }
      host.progress(`Writing series ${end.toLocaleString()} of ${total}…`);
      await host.nextFrame();
    }
    return parts;
  }

  const copies: (Float32Array | null)[] = [];
  for (let start = 0; start < refs.length; start += CHUNK) {
    for (let i = start; i < Math.min(refs.length, start + CHUNK); i++) {
      copies.push(entries[i].refusal ? null : (valuesOf(host.resolve(refs[i]))?.slice() ?? null));
    }
    host.progress(`Reading series ${copies.length.toLocaleString()} of ${total}…`);
    await host.nextFrame();
  }
  const layoutColumns = wideColumns(entries, names);
  const columns = layoutColumns.map(
    ({ series, year }) =>
      copies[series]?.subarray(year * YEAR_SLOT_HOURS, (year + 1) * YEAR_SLOT_HOURS) ?? null,
  );
  const columnRatio = layoutColumns.map(({ series }) => ratio[series]);
  for (let from = 0; from < YEAR_SLOT_HOURS; from += HOUR_CHUNK) {
    const to = Math.min(YEAR_SLOT_HOURS, from + HOUR_CHUNK);
    parts.push(wideRows(columns, columnRatio, from, to));
    host.progress(`Writing hour ${to.toLocaleString()} of ${YEAR_SLOT_HOURS.toLocaleString()}…`);
    await host.nextFrame();
  }
  return parts;
}

function valuesOf(series: CaseSeries | null): Float32Array | null {
  return series?.values ?? null;
}

/** A row whose table is gone is refused under the facets its ref carries. */
const GONE = 'its table is no longer loaded';

function entryOf(
  ref: BrowseRowRef,
  series: CaseSeries | null,
  caseLabelOf: (caseId: string) => string,
  caseNames: CaseNames,
): Omit<HourlyEntry, 'span'> {
  const ratio = ref.perUnit === true;
  if (series?.facets) {
    return {
      facets: series.facets,
      refusal: series.values === null ? (series.refusal ?? 'refused') : '',
      warnings: series.warnings,
      ratio,
    };
  }
  return {
    facets: facetsOfRef(ref, caseLabelOf, caseNames),
    refusal: series?.refusal ?? GONE,
    warnings: [],
    ratio,
  };
}

function facetsOfRef(
  ref: BrowseRowRef,
  caseLabelOf: (caseId: string) => string,
  caseNames: CaseNames,
): SeriesFacets {
  return {
    caseLabel: caseLabelOf(ref.caseId),
    kind: ref.kind,
    variable: ref.variable,
    unit: ref.unit,
    subject: rowSubject(ref, caseLabelOf),
    ...(ref.groupBy ? { groupBy: ref.groupBy } : {}),
    ...(ref.perUnit ? { range: RANGE_LABEL } : {}),
    ...(ref.filterContext && ref.filterContext.length > 0
      ? {
          filters: ref.filterContext.map((entry) => ({
            label: entry.label,
            constraint: pinnedConstraint(entry, ref, caseNames),
          })),
        }
      : {}),
  };
}
