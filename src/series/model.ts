// src/series/model.ts
//
// What a ticked row MEANS: the plain-data record every drawn line reduces to,
// and the map that sends it to the kind that draws it.
//
//   * **No cube, no closure, no DOM.** A spec is data: it saves in the bundle,
//     compares by value and tests under Node.
//   * **The map holds no domain logic.** It dispatches on `spec.source.kind`;
//     each kind's rules live in `src/tables/<kind>/series.ts`.
//   * **A kind is registered, never imported**, so this meeting point of four
//     kinds imports none of them.

import type { TableKind } from '../model/case-model';
import { HOURS_PER_YEAR } from '../model/calendar';
import { createScratch, quantiles } from '../kernels';
import type { LookupVariant, LookupTable } from '../lookups/types';
import { lookupFor } from '../lookups/store';
import { bucketLabelFor } from '../lookups/reduce';
import { areasIn } from '../lookups/groupings';
import type { Filters } from '../model/types';
import type { CaseSeries } from '../ui/charts';
import type { RangeLimits } from './range';

/**
 * One drawn series, as data. `caseId` is the store's id, never the editable
 * name. `source` is the table's SLOT: one Case can hold Power Flow and
 * Congestion Cost, which are two series for the same subject.
 */
export interface SeriesSpec {
  readonly caseId: string;
  readonly source: { readonly kind: TableKind; readonly quantity: string };
  /** One row of a browse tab: an entity on the table's own axis, or one
   * grouped row. A kind that cannot combine refuses the grouped arm by name. */
  readonly subject:
    | { readonly entity: string | number }
    | {
        readonly groupBy: string;
        readonly value: string;
        /** The bucket's entity keys when ticked, FROZEN: a pin outlives the
         * filters that built its bucket, so it must not be re-derived. Absent
         * means the whole (live) bucket. */
        readonly members?: readonly (string | number)[];
      };
  /** "% of range" (`src/series/range.ts`): divide by the kind's limit, else
   * the series' own peak. The field name is saved in bundles. */
  readonly perUnit?: boolean;
}

/**
 * The `groupBy` of the bucket that is not a lookup column: every entity in the
 * Case, summed. Shared here so every reader spells it the same way
 * (`BUS_GROUP_BY` and `GENERATOR_GROUP_BY` follow the same pattern).
 *
 * Footgun: it holds every entity, so a reader that resolves membership by
 * walking a lookup column must special-case it or find the group EMPTY.
 */
export const CASE_GROUP_BY = 'Case';

/**
 * The buffers one drawn line owns, allocated per series and reused (never in
 * a render path). The returned `CaseSeries` views them, so two lines must
 * never share a set.
 */
export interface SeriesBuffers {
  /** The unmasked plane; the box-plot partitions read it hour by hour. */
  series: Float32Array;
  /** Filtered-out hours blanked to NaN: what the time pane draws, as gaps. */
  display: Float32Array;
  mask: Uint8Array;
  /** The kept values, sorted ascending: the duration curve and every stat. */
  gathered: Float32Array;
}

export function createSeriesBuffers(): SeriesBuffers {
  return {
    series: createScratch(),
    display: createScratch(),
    mask: new Uint8Array(HOURS_PER_YEAR),
    gathered: createScratch(),
  };
}

/**
 * A spec's identity: the key for its buffers and colour. NUL-separated, since
 * names may contain any printable character. A grouped subject is spelled
 * `groupBy=value` so it never collides with an entity, and a frozen member
 * set adds its signature: "Coal" under two filters is two series.
 */
export function specId(spec: SeriesSpec): string {
  const subject =
    'entity' in spec.subject
      ? String(spec.subject.entity)
      : spec.subject.members
        ? `${spec.subject.groupBy}=${spec.subject.value}~${memberSignature(spec.subject.members)}`
        : `${spec.subject.groupBy}=${spec.subject.value}`;
  return [
    spec.caseId,
    `${spec.source.kind} ${spec.source.quantity}`,
    subject,
    spec.perUnit ? 'p.u.' : '',
  ].join('\u0000');
}

/**
 * A short, stable fingerprint of a frozen member set, for row ids and buffer
 * keys. Deterministic, so a restored pin still matches its rebuilt row. Two
 * hash lanes, because a collision would silently merge two series.
 */
export function memberSignature(members: readonly (string | number)[]): string {
  let lane1 = 0x811c9dc5;
  let lane2 = 0x9e3779b9;
  // Sorted, because a later drop can reindex the axis the set was collected in.
  for (const member of [...members].map(String).sort()) {
    const text = member;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      lane1 = Math.imul(lane1 ^ code, 0x01000193);
      lane2 = Math.imul(lane2 ^ code, 0x85ebca6b);
    }
    // A boundary advances the state, so ["ab", "c"] and ["a", "bc"] differ.
    lane1 = Math.imul(lane1, 0x01000193);
    lane2 = Math.imul(lane2, 0x85ebca6b);
  }
  return (lane1 >>> 0).toString(36) + (lane2 >>> 0).toString(36);
}

/**
 * The spec a browse row stands for. Structural (browse-model.ts is not
 * imported), so any row-shaped source builds a spec the same way.
 */
export function specFromRow(row: {
  readonly caseId: string;
  readonly kind: string;
  readonly variable: string;
  readonly entity: string | number;
  readonly groupBy?: string;
  readonly groupValue?: string;
  /** The frozen member set a grouped row was built under, if any. */
  readonly members?: readonly (string | number)[];
  readonly perUnit?: boolean;
}): SeriesSpec {
  const base = {
    caseId: row.caseId,
    source: { kind: row.kind as TableKind, quantity: row.variable },
    subject:
      row.groupBy && row.groupValue !== undefined
        ? row.members
          ? { groupBy: row.groupBy, value: row.groupValue, members: row.members }
          : { groupBy: row.groupBy, value: row.groupValue }
        : { entity: row.entity },
  };
  return row.perUnit ? { ...base, perUnit: true } : base;
}

/**
 * The transient preview's colour: grey and never from the palette, so it does
 * not look like a pin. Also drawn dashed, since grey alone could pass for an
 * eleventh series.
 */
export const PREVIEW_COLOR = '#8a8f98';

/** What every kind's resolver is handed beyond the spec and its table. */
export interface ResolveOptions {
  /** The legend label, trimmed by the caller to what varies across the set. */
  readonly name: string;
  /** The full form, for messages that must be unambiguous. */
  readonly detail: string;
  /** What to call the TABLE in a refusal, e.g. "Winter 2032 - Generation
   * (MWh)". Tables carry no name of their own. */
  readonly tableLabel: string;
  readonly color: string;
  /** The transient click-preview. Only the chart reads it. */
  readonly dashed?: boolean;
  /** "% of range": one entity's limits by name (the line's own, or a group
   * member's), when the caller holds them. Numbers only, so no kind or store
   * crosses in. A kind that has none ignores it. */
  readonly rangeOf?: (entity: string) => RangeLimits;
}

/**
 * One kind's resolver: spec + table + hour filters -> a drawn series. `table`
 * is `unknown` here and cast by the resolver, which alone knows its kind's
 * table type.
 */
export type SeriesResolver = (
  spec: SeriesSpec,
  table: unknown,
  filters: Filters,
  buffers: SeriesBuffers,
  options: ResolveOptions,
) => CaseSeries;

export type ResolverMap = Readonly<Partial<Record<TableKind, SeriesResolver>>>;

/**
 * Dispatch, and nothing else. A kind with no resolver registered refuses BY
 * NAME rather than throwing or drawing nothing.
 */
export function resolveSeries(
  resolvers: ResolverMap,
  spec: SeriesSpec,
  table: unknown,
  filters: Filters,
  buffers: SeriesBuffers,
  options: ResolveOptions,
): CaseSeries {
  const resolver = resolvers[spec.source.kind];
  if (!resolver) {
    return refusedSeries(
      options,
      spec.source.quantity,
      `${spec.source.kind} series cannot be drawn from the browse table yet.`,
      buffers,
    );
  }
  const resolved = resolver(spec, table, filters, buffers, options);
  resolved.spec = spec;
  return resolved;
}

/**
 * The shell a refusal is carried in, shared by every resolver. `values: null`
 * makes the pane show the reason; statistics are NaN, not 0, because 0 would
 * read as data.
 */
export function refusedSeries(
  options: ResolveOptions,
  quantity: string,
  refusal: string,
  buffers: SeriesBuffers,
  unit = '',
): CaseSeries {
  return {
    name: options.name,
    detail: options.detail,
    color: options.color,
    dashed: options.dashed,
    unit,
    quantity,
    values: null,
    refusal,
    warnings: [],
    sorted: buffers.gathered,
    n: 0,
    stats: { n: 0, mean: NaN, min: NaN, max: NaN, sd: NaN, sum: NaN },
    // The empty-n shape, from the kernel that defines it.
    quantiles: quantiles(buffers.gathered, 0),
    allZero: false,
  };
}

/**
 * The order a STACK is drawn in: largest TOTAL at the bottom. The band on the
 * axis is the only one read against a flat edge, so it goes to the series
 * that carries the most, and thin bands stay together at the top. Total, not
 * peak, because a stack shows area. NaN hours are skipped. Stable, so equal
 * totals keep selection order. Returns a new array; selection order is the
 * legend and must not move.
 */
export function stackOrder(series: readonly CaseSeries[]): CaseSeries[] {
  const totals = new Map<CaseSeries, number>();
  for (const entry of series) {
    let total = 0;
    // A refused series ranks last; its pane reports the refusal.
    const values = entry.values ?? [];
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (!Number.isNaN(value)) total += value;
    }
    totals.set(entry, total);
  }
  return [...series].sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0));
}

/** The label a list row carries in an enum or text column, or '' for none. */
function labelAt(column: LookupTable['columns'][number], row: number): string {
  if (column.kind === 'enum') {
    const code = column.codes[row];
    return code >= 0 ? column.labels[code] : '';
  }
  if (column.kind === 'text') return column.values[row] ?? '';
  return '';
}

/** A list row by entity key, whichever of number or text the list keyed it by. */
function rowOf(lookup: LookupTable, key: string | number): number | undefined {
  return lookup.index.get(key) ?? lookup.index.get(Number(key)) ?? lookup.index.get(String(key));
}

/**
 * The entity keys a grouped series holds: what its resolver summed, when
 * known (the only answer for an authored group or derived attribute).
 * Otherwise walked from a list column, or the Case bucket.
 */
function heldBy(
  series: CaseSeries,
  subject: {
    readonly groupBy: string;
    readonly value: string;
    readonly members?: readonly (string | number)[];
  },
  lookup: LookupTable,
): readonly (string | number)[] {
  if (series.summed) return series.summed;
  // A frozen member set narrows the group, as in the sums: an entity the
  // filter excluded cannot double-count.
  const frozen = subject.members ? new Set(subject.members.map(String)) : null;
  // No column answers for a Case bucket's membership; it holds everything.
  const holdsAll = subject.groupBy === CASE_GROUP_BY;
  const held: (string | number)[] = [];
  for (const key of lookup.index.keys()) {
    if (!holdsAll && bucketLabelFor(key, lookup, subject.groupBy) !== subject.value) continue;
    if (frozen && !frozen.has(String(key))) continue;
    held.push(key);
  }
  return held;
}

/**
 * Whether drawable series overlap in a way a stack would double-count: the
 * same series twice, an Area with a Generator in that Area, or an Area with a
 * Bus in that Area. Returns the refusal message, or null.
 */
export function checkStackOverlap(
  series: readonly CaseSeries[],
  lookups?: ReadonlyMap<LookupVariant, LookupTable>,
): string | null {
  // 1. Duplicate series
  const seenSpecs = new Map<string, string>();
  const seenNames = new Set<string>();
  for (const s of series) {
    if (s.spec) {
      const id = specId(s.spec);
      if (seenSpecs.has(id)) {
        return `${s.name} is selected twice; a stack would count it twice`;
      }
      seenSpecs.set(id, s.name);
    } else {
      if (seenNames.has(s.name)) {
        return `${s.name} is selected twice; a stack would count it twice`;
      }
      seenNames.add(s.name);
    }
  }

  // 2. Area contains Generator / Area contains Bus
  const areaSeries = series.filter((s) => s.spec?.source.kind === 'area' || s.metric !== undefined);
  if (areaSeries.length === 0) return null;

  const genLookup = lookups?.get('generatorlist') ?? lookupFor('generatorlist');
  const busLookup = lookups?.get('buslist') ?? lookupFor('buslist');

  for (const area of areaSeries) {
    const caseId = area.spec?.caseId;
    const areaNames = new Set<string>();
    let areaLabel = '';
    if (area.spec && 'entity' in area.spec.subject) {
      areaLabel = String(area.spec.subject.entity);
      areaNames.add(areaLabel.trim().toLowerCase());
    } else if (area.spec && 'groupBy' in area.spec.subject) {
      areaLabel = area.spec.subject.value;
      // A frozen member set IS the group, as in the resolver; the grouping
      // file's live membership is only the fallback.
      const members = area.spec.subject.members
        ? area.spec.subject.members.map(String)
        : areasIn(area.spec.subject.value);
      for (const m of members) areaNames.add(m.trim().toLowerCase());
    } else {
      // Fallback when no spec: "Case · Area · Metric" or "Area".
      const parts = area.name.split(' · ');
      areaLabel = parts.length >= 2 ? parts[1] : parts[0];
      areaNames.add(areaLabel.trim().toLowerCase());
    }
    const inArea = (column: LookupTable['columns'][number], row: number | undefined): boolean => {
      if (row === undefined) return false;
      const label = labelAt(column, row);
      return label !== '' && areaNames.has(label.trim().toLowerCase());
    };

    // Check generators in the same case
    if (genLookup) {
      const areaColIdx = genLookup.byName.get('Area Name') ?? genLookup.byName.get('Area');
      if (areaColIdx !== undefined) {
        const col = genLookup.columns[areaColIdx];
        for (const s of series) {
          if (s === area) continue;
          if (caseId && s.spec?.caseId && s.spec.caseId !== caseId) continue;
          const isGen =
            s.spec?.source.kind === 'generator' ||
            (!s.spec && genLookup.index.has(s.name.split(' · ').pop() ?? s.name));
          if (!isGen) continue;

          if (s.spec && 'groupBy' in s.spec.subject) {
            for (const genName of heldBy(s, s.spec.subject, genLookup)) {
              if (inArea(col, rowOf(genLookup, genName))) {
                return `${areaLabel} (area) contains ${genName} in group "${s.spec.subject.value}"; a stack would count it twice`;
              }
            }
          } else {
            let genName = '';
            if (s.spec && 'entity' in s.spec.subject) {
              genName = String(s.spec.subject.entity);
            } else {
              genName = s.name.split(' · ').pop() ?? s.name;
            }
            if (inArea(col, genLookup.index.get(genName))) {
              return `${areaLabel} (area) contains ${genName}; a stack would count it twice`;
            }
          }
        }
      }
    }

    // Check buses in the same case
    if (busLookup) {
      const busAreaColIdx = busLookup.byName.get('LoadArea') ?? busLookup.byName.get('Area');
      if (busAreaColIdx !== undefined) {
        const col = busLookup.columns[busAreaColIdx];
        for (const s of series) {
          if (s === area) continue;
          if (caseId && s.spec?.caseId && s.spec.caseId !== caseId) continue;
          const isBus =
            s.spec?.source.kind === 'bus' ||
            (!s.spec &&
              (busLookup.index.has(s.name.split(' · ').pop() ?? s.name) ||
                busLookup.index.has(Number(s.name.split(' · ').pop() ?? s.name))));
          if (!isBus) continue;

          // A grouped bus subject is a set of buses (buses sum), so test it
          // like a generator group.
          if (s.spec && 'groupBy' in s.spec.subject) {
            for (const busKey of heldBy(s, s.spec.subject, busLookup)) {
              if (inArea(col, rowOf(busLookup, busKey))) {
                return `${areaLabel} (area) contains bus ${busKey} in group "${s.spec.subject.value}"; a stack would count it twice`;
              }
            }
            continue;
          }

          let busEntity: string | number = '';
          if (s.spec && 'entity' in s.spec.subject) {
            busEntity = s.spec.subject.entity;
          } else {
            const raw = s.name.split(' · ').pop() ?? s.name;
            busEntity = Number.isNaN(Number(raw)) ? raw : Number(raw);
          }
          if (inArea(col, rowOf(busLookup, busEntity))) {
            return `${areaLabel} (area) contains ${busEntity}; a stack would count it twice`;
          }
        }
      }
    }
  }

  return null;
}
