// src/app/render-frame.ts
//
// What one render shows, computed as a value before anything paints. Its
// steps have an order their inputs do not show: the notes are read after the
// series resolve, because a series raises its warnings while it resolves, and
// the overview pool is swept only once the panes have had their chance to ask
// for the whole year. Deciding that here, and painting it in `main.ts`, puts
// the order in one module a test can drive.
//
// Like the ingest engines, this holds no app state and reaches no store or
// DOM: `main.ts` hands in what a render reads, including the line pools.

import { HOURS_PER_YEAR } from '../model/calendar';
import type { Filters } from '../model/types';
import type { SeriesPool } from '../series/pool';
import type { AreaQuery, BoxDim } from '../tables/area/types';
import { pinLines, type PinLine } from '../ui/browse-model';
import type { BoxGroup, CaseSeries, ChartsInput, DrawnLimit } from '../ui/charts';
import { statusSentence } from '../ui/status-sentence';
import { computeBoxes, NO_YEAR } from './boxes';
import { filtersLabel, identityOf } from './browse-scope';
import { collectBrowseTabs, type CollectedTabs, type DeclaredTab } from './browse-tabs';
import { resolveDraws, type Draw, type DrawContext } from './draw';

/** Everything a draw context reads besides its filters and pool. */
export type DrawSource = Omit<DrawContext, 'filters' | 'lines'>;

/** One draw context per (filters, pool). Filters are read through the getter
 * at every draw, so no context holds a query that has since moved. */
export function drawContextOf(
  source: DrawSource,
  filters: () => Filters,
  lines: SeriesPool,
): DrawContext {
  return {
    ...source,
    get filters() {
      return filters();
    },
    lines,
  };
}

/** The filters with the dates cleared, one object per filter state: a year
 * overview draws the whole year under every other filter. */
export function datesCleared(filters: () => Filters): () => Filters {
  let held: { of: Filters; filters: Filters } | null = null;
  return () => {
    const of = filters();
    if (held?.of !== of) held = { of, filters: Object.freeze({ ...of, dates: null }) };
    return held.filters;
  };
}

/** A pool of lines as the frame uses it: resolve a drawn set into it (which
 * frees what the set no longer holds), or free everything. */
export interface LineSource {
  resolve(draws: readonly Draw[]): CaseSeries[];
  sweep(): void;
}

export function lineSourceOf(context: DrawContext): LineSource {
  return {
    resolve: (draws) => resolveDraws(context, draws),
    sweep: () => context.lines.sweep(),
  };
}

/** The app-wide inputs a browse rebuild reads that no tab's scope covers. */
export interface BrowseFreshness {
  /** The loaded lists by variant. Their OBJECTS count, not their file names:
   * a second GeneratorList.csv merges new rows under a source name the list
   * already carries, so the names hold still while every build that joins on
   * the list changes. */
  lookups: ReadonlyMap<string, object>;
  groupingsRev: number;
  generatorGroupsRev: number;
  busGroupsRev: number;
  interfaceGroupsRev: number;
  /** The installed limits tables, by object: a file replaced under the same
   * name is a different ranking. The Interface tab's "% of range" divides by
   * these. */
  limits: { shared: object | undefined; cases: ReadonlyMap<string, object> };
}

export interface FrameInput<B> {
  query: AreaQuery;
  /** The refusal a drawn set of this many lines gets, or null when it fits:
   * the charts' own cap (`seriesCapMessage`), stated where they are wired. */
  cap(lines: number): string | null;
  /** The pins, then the preview if there is one. */
  draws: readonly Draw[];
  /** The pins' row ids, without the preview. */
  pinnedIds: readonly string[];
  /** The notes ledger's messages, before this render's series add theirs. */
  notes: readonly string[];
  hasCases: boolean;
  drawn: LineSource;
  /** The drawn set again with the dates cleared, in buffers of its own. */
  overview: LineSource;
  limitLines(series: readonly CaseSeries[]): DrawnLimit[];
  yearOfCase(caseId: string): number;
  boxScratch: Float32Array;
  /** Every browse tab, loaded or not. Called once, after the series. */
  declareTabs(): readonly DeclaredTab<B>[];
  freshness: BrowseFreshness;
  /** The tab the drawer is showing. */
  activeTabId: string;
}

export interface BrowseFrame<B> {
  tabs: CollectedTabs<B>['tabs'];
  /** Moves exactly when a rebuilt tab would differ. */
  signature: string;
  variables: readonly string[];
  variable: string;
  hourFilter: string;
}

export interface Frame<B> {
  series: CaseSeries[];
  pinLines: Map<string, PinLine>;
  /** In the order shown: the cap refusal, the ledger, then the series'. */
  notes: string[];
  charts: ChartsInput;
  /** Call once the charts have painted: frees the overview pool when no pane
   * asked for the whole year, as the drawn pool frees its own every render. */
  settle(): void;
  browse: BrowseFrame<B>;
  status: string;
}

export function computeFrame<B>(input: FrameInput<B>): Frame<B> {
  const { query, draws } = input;
  // Only pins are drawn, so the Selected tab lists every line on screen.
  const capped = draws.length > 0 ? input.cap(draws.length) : null;
  // Resolved even when empty, and swept when capped: a render that draws
  // nothing frees every line buffer.
  let series: CaseSeries[] = [];
  if (capped) input.drawn.sweep();
  else series = input.drawn.resolve(draws);
  const lines = pinLines(
    input.pinnedIds,
    series,
    capped ?? undefined,
    capped !== null && input.cap(input.pinnedIds.length) === null,
  );

  const notes = [...input.notes, ...series.flatMap((entry) => entry.warnings)];
  if (capped) notes.unshift(capped);

  // Each pane's boxes, cut once per distinct dimension and only when asked.
  const cut = new Map<BoxDim, BoxGroup[]>();
  const boxesOn = (dim: BoxDim): BoxGroup[] => {
    let groups = cut.get(dim);
    if (!groups)
      cut.set(dim, (groups = computeBoxes(series, dim, input.yearOfCase, input.boxScratch)));
    return groups;
  };
  // Resolved once and only when a pane asks: a year overview, or a time pane
  // that does not follow the dates.
  let wholeYearLines: CaseSeries[] | null = null;
  const wholeYear = capped ? undefined : () => (wholeYearLines ??= input.overview.resolve(draws));
  const charts: ChartsInput = {
    boxDims: query.boxDims,
    limits: input.limitLines(series),
    series,
    boxes: (pane) => boxesOn(query.boxDims[pane]),
    refusal: capped ?? undefined,
    hasCases: input.hasCases,
    dates: query.filters.dates,
    yearOf: (line) => (line.spec?.caseId ? input.yearOfCase(line.spec.caseId) : NO_YEAR),
    overview: wholeYear,
    overviewLimits: wholeYear && (() => input.limitLines(wholeYear())),
  };

  let keptHours = 0;
  for (const entry of series) keptHours = Math.max(keptHours, entry.n);

  return {
    series,
    pinLines: lines,
    notes,
    charts,
    settle() {
      if (!wholeYearLines) input.overview.sweep();
    },
    browse: browseFrame(input),
    status: statusSentence(query, series.length === 0 ? HOURS_PER_YEAR : keptHours),
  };
}

/** The drawer's tabs and the signature it rebuilds on. A freshness input
 * missing from the signature leaves a stale ranking with nothing to say so,
 * so every term is built here from a named field of `BrowseFreshness`. */
function browseFrame<B>(input: FrameInput<B>): BrowseFrame<B> {
  const { freshness } = input;
  const limits = [freshness.limits.shared ? String(identityOf(freshness.limits.shared)) : '-'];
  for (const [caseId, table] of freshness.limits.cases)
    limits.push(`${caseId}#${identityOf(table)}`);
  // The dropdown lists the ACTIVE tab's quantities (a tab can vanish with its
  // last table).
  const collected = collectBrowseTabs(
    input.declareTabs(),
    {
      lookups: [...freshness.lookups]
        .map(([variant, list]) => `${variant}#${identityOf(list)}`)
        .join(','),
      groupingsRev: freshness.groupingsRev,
      generatorGroupsRev: freshness.generatorGroupsRev,
      busGroupsRev: freshness.busGroupsRev,
      interfaceGroupsRev: freshness.interfaceGroupsRev,
      limits: limits.join(','),
    },
    input.activeTabId,
  );
  return {
    tabs: collected.tabs,
    signature: collected.signature,
    variables: collected.shown?.variables ?? [],
    variable: collected.shown?.variable ?? '',
    hourFilter: filtersLabel(input.query.filters),
  };
}
