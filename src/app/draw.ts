// src/app/draw.ts
//
// One pinned or previewed browse row becomes one drawn line. The kind that
// owns the axis supplies only the table the row points at and how its
// subject reads; the resolve is `src/series/model.ts`'s.
//
// **The buffer key is the identity, and no kind builds it.** Two lines that
// build one key draw one line's numbers under two names, silently, so
// `bufferKey` builds it from the ref for every kind.
//
// **Names are decided over the whole drawn set** (`resolveDraws`): a row alone
// cannot know which facets the other lines make necessary
// (`src/series/label.ts`).

import { rowKeyOf, type TableRow } from '../model/case-model';
import { memberSignature, resolveSeries, specFromRow, type ResolveOptions } from '../series/model';
import { fullLabel, shortLabels, type SeriesFacets } from '../series/label';
import { RANGE_LABEL, type RangeLimits } from '../series/range';
import type { SeriesPool } from '../series/pool';
import type { SeriesBuffers } from '../series/model';
import { SERIES_RESOLVERS } from '../tables/registry';
import type { AreaTable } from '../tables/area/types';
import type { BusTable } from '../tables/bus/types';
import type { GeneratorTable } from '../tables/generator/types';
import type { InterfaceTable } from '../tables/interface/types';
import { MEMBER_NOUN as AREA_MEMBERS } from '../tables/area/series';
import { MEMBER_NOUN as BUS_MEMBERS } from '../tables/bus/series';
import { MEMBER_NOUN as GENERATOR_MEMBERS } from '../tables/generator/series';
import { pinnedConstraint, rowSubject, type BrowseRowRef } from '../ui/browse-model';
import type { CaseSeries } from '../ui/charts';
import type { Filters } from '../model/types';

/** One row to draw, its assigned colour, and whether it is the preview. */
export interface Draw {
  ref: BrowseRowRef;
  color: string;
  dashed: boolean;
}

/** One loaded Area table together with the Case that owns it. */
export interface AreaCase {
  id: string;
  name: string;
  /** The Case's own colour, so display sorting cannot change it. */
  color: string;
  data: AreaTable;
}

/** What a draw reads from app state, through accessors so nothing is cached:
 * a cached row list is how a removed Case comes back in a chart. */
export interface DrawContext {
  filters: Filters;
  /** A Case's label (`caseLabel`), read at every draw so a rename relabels
   * lines already drawn. */
  caseLabel(caseId: string): string;
  areaCases(): readonly AreaCase[];
  interfaceRows(): readonly TableRow<InterfaceTable>[];
  busRows(): readonly TableRow<BusTable>[];
  generatorRows(): readonly TableRow<GeneratorTable>[];
  /** Bus id -> label. Names may repeat, so the map is one-way. */
  busNames(): ReadonlyMap<number, string>;
  /** A bus's BaseKV from the BusList: null with no list, or a blank kV. */
  busKv(id: number): number | null;
  /** One path's hourly limits in one Case, for its "% of range" line. The
   * limits store stays in `main.ts`; only numbers come back. */
  interfaceRange(caseId: string, interfaceName: string, year: number): RangeLimits;
  /** Every drawn line's buffers, whatever its kind. */
  lines: SeriesPool;
}

/** Resolve one draw, or `null` when its table is gone (a Case removed between
 * pin and repaint): a dropped line, not an error. */
export function resolveDraw(context: DrawContext, draw: Draw): CaseSeries | null {
  const resolve = RESOLVERS[draw.ref.kind];
  // A kind this build cannot draw. Not a `never` check: the drawer may list
  // kinds with no resolver.
  if (!resolve) return null;
  return resolve(context, draw, context.lines.for(...bufferKey(draw.ref)));
}

type KindResolver = (context: DrawContext, spec: Draw, buffer: SeriesBuffers) => CaseSeries | null;

/** What each kind contributes: its table and how its subject reads, never
 * its buffer. */
const RESOLVERS: Readonly<Record<string, KindResolver>> = {
  area: resolveAreaDraw,
  interface: resolveInterfaceDraw,
  bus: resolveBusDraw,
  generator: resolveGeneratorDraw,
};

/**
 * The pool key of the line a row draws, from the REF, for every kind. Each
 * term is something two pins can differ in: Case, slot, quantity (one Area
 * slot holds every metric), subject (entity, or group plus frozen members)
 * and per-unit. A missing term draws one line with another's hours; an unused
 * one costs an empty string.
 */
function bufferKey(ref: BrowseRowRef): string[] {
  return [ref.caseId, ref.slotKey, ref.variable, groupSubject(ref), ref.perUnit ? 'p.u.' : ''];
}

/**
 * Every draw, resolved and then NAMED together: a short name depends on what
 * else is on the pane. Rows whose table is gone drop out before naming. This
 * is the whole drawn set, so the pool keeps only what it asked for.
 */
export function resolveDraws(context: DrawContext, draws: readonly Draw[]): CaseSeries[] {
  const out: CaseSeries[] = [];
  for (const one of draws) {
    const entry = resolveDraw(context, one);
    if (entry) out.push(entry);
  }
  context.lines.sweep();
  nameDrawnSet(out);
  return out;
}

/**
 * Give each line in a set its shorthand, keeping the full label on `detail`.
 * A series without facets keeps its name.
 */
function nameDrawnSet(series: readonly CaseSeries[]): void {
  const withFacets = series.filter((entry) => entry.facets);
  if (withFacets.length === 0) return;
  const short = shortLabels(withFacets.map((entry) => entry.facets!));
  withFacets.forEach((entry, i) => {
    entry.name = short[i];
  });
}

/** The table at a (case, slot) reference, by row key. */
function rowAt<T>(rows: readonly TableRow<T>[], ref: BrowseRowRef): TableRow<T> | undefined {
  return rows.find((row) => row.key === rowKeyOf(ref.caseId, ref.slotKey));
}

/** The subject a buffer hangs off: the entity, or the group label plus its
 * frozen member signature. Tagged, so no entity name can spell it. */
function groupSubject(ref: BrowseRowRef): string {
  return ref.groupBy
    ? `group:${ref.groupBy}=${ref.groupValue}` +
        (ref.members ? `~${memberSignature(ref.members)}` : '')
    : `entity:${String(ref.entity)}`;
}

/** The facets of the line a row draws. The row carries them all but the
 * Case's label, read now; a kind adds only how its subject reads. */
function facetsOf(context: DrawContext, ref: BrowseRowRef, subject: string): SeriesFacets {
  return {
    caseLabel: context.caseLabel(ref.caseId),
    kind: ref.kind,
    variable: ref.variable,
    unit: ref.unit,
    subject,
    ...(ref.groupBy ? { groupBy: ref.groupBy } : {}),
    ...(ref.perUnit ? { range: RANGE_LABEL } : {}),
    ...(ref.filterContext && ref.filterContext.length > 0
      ? {
          filters: ref.filterContext.map((entry) => ({
            label: entry.label,
            constraint: pinnedConstraint(entry, ref),
          })),
        }
      : {}),
  };
}

/** The one resolve call. `name` is the full label until `resolveDraws`
 * shortens it; a refusal must read on its own. */
function draw(
  context: DrawContext,
  spec: Draw,
  table: unknown,
  buffer: SeriesBuffers,
  facets: SeriesFacets,
  tableLabel: string,
  figureKey: FigureKey,
  rangeOf?: ResolveOptions['rangeOf'],
): CaseSeries {
  const full = fullLabel(facets);
  const resolved = resolveSeries(
    SERIES_RESOLVERS,
    specFromRow(spec.ref),
    table,
    context.filters,
    buffer,
    {
      name: full,
      detail: full,
      tableLabel,
      color: spec.color,
      dashed: spec.dashed,
      ...(rangeOf ? { rangeOf } : {}),
    },
  );
  // The divisor is known only once the line is resolved.
  if (resolved.rangeLabel && facets.range) {
    facets = { ...facets, range: resolved.rangeLabel };
    resolved.name = resolved.detail = fullLabel(facets);
  }
  const figureSubject = figureKey(resolved);
  resolved.facets = figureSubject === undefined ? facets : { ...facets, figureSubject };
  return resolved;
}

/** How a kind's line reads as a figure key (`SeriesFacets.figureSubject`),
 * given the resolved line; `undefined` keeps the subject. */
type FigureKey = (resolved: CaseSeries) => string | undefined;

/**
 * A group's figure key: its bucketing column, its bare name (a frozen row's
 * label already counts its members) and the members the line combined when it
 * resolved. The Case bucket reads the Case label, as its row does.
 */
function countedGroup(
  context: DrawContext,
  ref: BrowseRowRef,
  noun: { readonly one: string; readonly many: string },
): FigureKey {
  return (resolved) => {
    if (!ref.groupBy || ref.groupValue === undefined) return undefined;
    const name = rowSubject({ ...ref, label: ref.groupValue }, context.caseLabel);
    const count = resolved.summed?.length;
    if (count === undefined) return `${ref.groupBy} = ${name}`;
    return `${ref.groupBy} = ${name} (${count} ${count === 1 ? noun.one : noun.many})`;
  };
}

function resolveAreaDraw(
  context: DrawContext,
  spec: Draw,
  buffer: SeriesBuffers,
): CaseSeries | null {
  const owner = context.areaCases().find((entry) => entry.id === spec.ref.caseId);
  if (!owner) return null;
  return draw(
    context,
    spec,
    owner.data,
    buffer,
    facetsOf(context, spec.ref, rowSubject(spec.ref, context.caseLabel)),
    `${owner.name} · ${spec.ref.variable}`,
    countedGroup(context, spec.ref, AREA_MEMBERS),
  );
}

function resolveInterfaceDraw(
  context: DrawContext,
  spec: Draw,
  buffer: SeriesBuffers,
): CaseSeries | null {
  const row = rowAt(context.interfaceRows(), spec.ref);
  if (!row) return null;
  // A path's own limits, or for a group each member's, which the kind sums
  // in the group's directions.
  const { caseId, perUnit } = spec.ref;
  const year = row.data.year;
  const rangeOf = perUnit
    ? (path: string) => context.interfaceRange(caseId, path, year)
    : undefined;
  return draw(
    context,
    spec,
    row.data,
    buffer,
    facetsOf(context, spec.ref, rowSubject(spec.ref, context.caseLabel)),
    row.label,
    // A boundary is named by the name its author gave it: its members and
    // directions are the group's, and a count would say nothing about signs.
    () => (spec.ref.groupBy ? spec.ref.groupValue : undefined),
    rangeOf,
  );
}

function resolveBusDraw(
  context: DrawContext,
  spec: Draw,
  buffer: SeriesBuffers,
): CaseSeries | null {
  const row = rowAt(context.busRows(), spec.ref);
  if (!row) return null;
  const id = Number(spec.ref.entity);
  return draw(
    context,
    spec,
    row.data,
    buffer,
    // The row's label, else the id: a bare name may be ambiguous.
    facetsOf(
      context,
      spec.ref,
      spec.ref.label === undefined
        ? `${context.busNames().get(id) ?? ''} (${id})`.trim()
        : rowSubject(spec.ref, context.caseLabel),
    ),
    row.label,
    spec.ref.groupBy ? countedGroup(context, spec.ref, BUS_MEMBERS) : () => busKey(context, id),
  );
}

/**
 * A bus as a power-flow study names it, in a figure only: `number name kV`.
 * The kV is left out when the BusList has none or states 0, so a figure never
 * invents a voltage. The app's own bus label stays `name (number)`: pins
 * save it, and a kV there would change with every BusList drop.
 */
function busKey(context: DrawContext, id: number): string {
  const kv = context.busKv(id);
  return [String(id), context.busNames().get(id) ?? '', kv ? `${kv} kV` : '']
    .filter(Boolean)
    .join(' ');
}

function resolveGeneratorDraw(
  context: DrawContext,
  spec: Draw,
  buffer: SeriesBuffers,
): CaseSeries | null {
  const row = rowAt(context.generatorRows(), spec.ref);
  if (!row) return null;
  return draw(
    context,
    spec,
    row.data,
    buffer,
    facetsOf(context, spec.ref, rowSubject(spec.ref, context.caseLabel)),
    row.label,
    countedGroup(context, spec.ref, GENERATOR_MEMBERS),
  );
}
