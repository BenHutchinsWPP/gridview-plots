// src/tables/generator/ui/browse.ts
//
// The Generator tab of the browse drawer: rows, columns, and the masked pass
// that ranks them. The drawer is kind-neutral; this adapter is where the kind
// lives, and it is the worked example the other kinds follow.
//
//   * **The rows are GeneratorList joined to the export.** A unit the export
//     carries but the list lacks is listed with empty attributes, so the
//     import never looks like it lost units.
//   * **A unit with no hours in the case is not a row.** Most listed units do
//     not run in a given case; blank rows would bury the ones with data, so
//     they are counted in a note instead.
//   * **Stats are computed for scoped rows only**: the scope is applied before
//     any plane is touched.
//   * **The area scope is a lookup join** through GeneratorList. Without the
//     list it cannot apply, and the tab says so.
//   * **Most list columns start hidden**; hiding never changes rows or stats.
//
// Group-by collapses rows by an attribute column; the groups tab
// (`isGroupTab`) collapses them into user-authored injection groups instead,
// needing no list (except for a power quantity's "% of range", whose caps
// are the list's). Grouped stats are stats OF THE AGGREGATE. A filter must
// choose which units enter a sum, so the drawer hands this build a keep-set,
// and a narrowed bucket freezes its membership onto its row for pins.
//
// "% of range" (`perUnit`) divides each series by `src/series/range.ts`
// before its stats are taken; this tab supplies only the caps.

import { RANKED, RANKED_FIELDS, createScratch, type RankMemo } from '../../../kernels';
import { cellValue } from '../../../lookups/merge';
import { GENERATOR_LIST } from '../../../lookups/schema';
import type { LookupColumn, LookupTable } from '../../../lookups/types';
import { rankScopedRows } from '../../../ui/browse-planes';
import {
  browseJoinKey,
  CASE_COLUMN_KEY,
  statColumns,
  statColumnsFrom,
} from '../../../ui/browse-model';
import {
  groupRowLabel,
  withRowId,
  caseLabelsOf,
  type BrowseColumn,
  type BrowseRowRef,
  type BrowseTab,
} from '../../../ui/browse-model';
import { CASE_GROUP_BY } from '../../../series/model';
import { applyMask, planeStart, quantiles, stats } from '../kernels';
import { spatialOf, spatialRefusal, unitOf, type SpatialRule } from '../rules';
import {
  bucketLabelFor,
  bucketedReduce,
  isBucketable,
  reduceMembers,
} from '../../../lookups/reduce';
import { GENERATOR_GROUP_BY, generatorGroupNames, unitsInGroup } from '../groups';
import { GENERATOR_DERIVED, derivedAttribute } from '../derived';
import type { GeneratorTable } from '../types';
import {
  MEMBER_NOUN as UNIT_NOUN,
  MAX_CAP_COLUMN,
  capsOf,
  caplessNote,
  hasMaxCap,
  isPower,
  rangeNeedsList,
} from '../series';
import { normalizedCopy, type RangeLimits } from '../../../series/range';

/** The GeneratorList column the area scope joins through. */
const AREA_COLUMN = 'Area Name';

/**
 * The GeneratorList columns the tab opens with: where a unit is, what it
 * burns and how big it is. Named rather than derived because which columns an
 * analyst reads first is domain knowledge; the other ~27 start hidden so they
 * do not push the stats off screen.
 */
const DEFAULT_ON_LIST_COLUMNS: ReadonlySet<string> = new Set([
  AREA_COLUMN,
  'FuelType',
  MAX_CAP_COLUMN,
]);

/** One generator table in scope, as the drawer's caller already has it. */
export interface GeneratorBrowseTable {
  caseId: string;
  caseName: string;
  caseLabel: string;
  slotKey: string;
  data: GeneratorTable;
  /** The hours kept, for THIS table: masks are built from each table's own
   * calendar and TOU codes. */
  mask: Uint8Array;
}

export interface GeneratorBrowseInput {
  /** The (case, slot) tables in scope, all of one quantity. */
  tables: readonly GeneratorBrowseTable[];
  /** The session's GeneratorList, or undefined when none is loaded. */
  list: LookupTable | undefined;
  /** Areas the scope keeps, or null for all of them. */
  areas: ReadonlySet<string> | null;
  /** Reused across rows, so ranking allocates nothing per row. */
  scratch?: Float32Array;
  memo?: RankMemo;
  /** The attribute column to collapse rows by, or null. */
  groupBy?: string | null;
  /** The generator-groups tab: rows are user-authored injection groups from
   * the session map (`src/tables/generator/groups.ts`), which needs no list. */
  isGroupTab?: boolean;
  /** Power quantities only. */
  perUnit?: boolean;
  /** See `keptRowKeys` in src/ui/browse-model.ts. */
  keep?: ReadonlySet<string>;
}

/** Each bucket's members after a filter (label -> names, axis order): the
 * units `bucketedReduce` summed, for freezing onto rows. */
function membersByLabel(
  data: GeneratorTable,
  list: LookupTable | undefined,
  column: string,
  filter: (name: string | number) => boolean,
  labelOf?: (name: string | number) => string,
): Map<string, (string | number)[]> {
  const byLabel = new Map<string, (string | number)[]>();
  for (let i = 0; i < data.generators.length; i++) {
    if (data.presence[i] === 0) continue;
    const name = data.generators[i];
    if (!filter(name)) continue;
    const label = labelOf ? labelOf(name) : bucketLabelFor(name, list, column);
    const held = byLabel.get(label);
    if (held) held.push(name);
    else byLabel.set(label, [name]);
  }
  return byLabel;
}

/** Computed once in `buildGeneratorTab` and passed to whichever body runs. */
interface GeneratorTabCtx {
  tables: readonly GeneratorBrowseTable[];
  list: LookupTable | undefined;
  areas: ReadonlySet<string> | null;
  scratch: Float32Array | undefined;
  memo: RankMemo | undefined;
  keep: ReadonlySet<string> | undefined;
  notes: string[];
  quantity: string;
  unit: string;
  isPerUnit: boolean;
  effectiveUnit: string;
  spatial: SpatialRule;
  /** Why the QUANTITY cannot be combined. Nothing the user loads changes it,
   *  so it alone governs a Case bucket. */
  spatialReason: string | undefined;
  /** Why an ATTRIBUTE bucket is unavailable: the quantity, or no
   *  GeneratorList to join through. */
  attributeReason: string | undefined;
  canGroup: boolean;
  columnOf: (name: string) => LookupColumn | undefined;
  areaColumn: LookupColumn | undefined;
  maxCapColumn: LookupColumn | undefined;
  /** The caps a "% of range" series divides by, over these list rows. Empty
   * for a quantity that is not MW/MWh: it divides by its own peak. */
  capsFor: (rows: Iterable<number>) => RangeLimits;
  /** `capsFor` over the units a sum took, by name. A summed unit with no
   * usable max cap is remembered for `caplessNote` whenever the others'
   * caps are the divisor, since that is when it can read over 100%. */
  capsOfSummed: (names: readonly (string | number)[]) => RangeLimits;
  capless: Set<string | number>;
}

/**
 * Build the tab. Deterministic row order: tables as given, then within a
 * table the GeneratorList's order followed by export-only names in axis order.
 */
export function buildGeneratorTab(input: GeneratorBrowseInput): BrowseTab {
  const { tables, list, areas, groupBy, perUnit, keep } = input;
  const notes: string[] = [];

  const quantity = tables[0]?.data.quantity ?? '';
  const unit = unitOf(quantity);
  const isPerUnit = Boolean(perUnit);
  const effectiveUnit = isPerUnit ? '%' : unit;

  const spatial = spatialOf(unit);
  // Two refusals (see `buildBusTab`). Only the quantity's blocks a group-by
  // BY CASE, which needs no list.
  const spatialReason =
    spatial === 'REFUSE'
      ? (spatialRefusal(quantity, unit) ?? `"${quantity}" cannot be combined across generators.`)
      : undefined;
  const listReason = list ? undefined : 'Grouping generators needs GeneratorList.csv to be loaded.';
  const attributeReason = spatialReason ?? listReason;
  const canGroup = attributeReason === undefined;

  const columnOf = (name: string) => {
    const index = list?.byName.get(name);
    return index === undefined || !list ? undefined : list.columns[index];
  };
  const areaColumn = columnOf(AREA_COLUMN);
  const maxCapColumn = columnOf(MAX_CAP_COLUMN);
  const capsFor = (rows: Iterable<number>): RangeLimits =>
    isPower(unit) ? capsOf(list, rows) : {};
  const capless = new Set<string | number>();
  const capsOfSummed = (names: readonly (string | number)[]): RangeLimits => {
    const rows: number[] = [];
    const missing: (string | number)[] = [];
    for (const name of names) {
      const row = list?.index.get(name);
      if (row !== undefined) rows.push(row);
      if (!hasMaxCap(list ?? undefined, row)) missing.push(name);
    }
    const caps = capsFor(rows);
    // All capless is the peak fallback, which cannot pass 100%.
    if (typeof caps.upper === 'number' && !Number.isNaN(caps.upper)) {
      for (const name of missing) capless.add(name);
    }
    return caps;
  };

  if (areas !== null && !areaColumn) {
    notes.push(
      `Area scope needs ${GENERATOR_LIST.banner} (${AREA_COLUMN}); it is not loaded, so every ` +
        'area is listed.',
    );
  }
  if (!list) {
    notes.push(
      'No GeneratorList loaded: names come from the export, and attribute columns are empty.',
    );
  }

  const ctx: GeneratorTabCtx = {
    tables,
    list,
    areas,
    scratch: input.scratch,
    memo: input.memo,
    keep,
    notes,
    quantity,
    unit,
    isPerUnit,
    effectiveUnit,
    spatial,
    spatialReason,
    attributeReason,
    canGroup,
    columnOf,
    areaColumn,
    maxCapColumn,
    capsFor,
    capsOfSummed,
    capless,
  };

  if (input.isGroupTab) return groupTabRows(ctx);
  if (groupBy && spatialReason === undefined) {
    const groupByRowsResult = groupByRows(ctx, groupBy);
    if (groupByRowsResult) return groupByRowsResult;
  }
  return ungroupedRows(ctx);
}

// ------------------------------------------------------ injection groups
//
// Rows are the user-authored groups; membership is stored as names, which is
// the export's own axis, so no list is needed. Aggregation is the explicit
// member-set reduce the resolver draws by, never Area's derived-column rule.
function groupTabRows(ctx: GeneratorTabCtx): BrowseTab {
  const { tables, list, areas, scratch, keep, notes, quantity, unit, spatial, areaColumn } = ctx;
  const caseLabelOf = caseLabelsOf(tables);
  const { isPerUnit, effectiveUnit, capsOfSummed, capless } = ctx;
  const actions = [{ id: 'edit-groups', label: 'Edit Groups…' }];
  const groupsTabId = 'generator-groups';
  const groupsTabLabel = 'Generator Groups';

  const groupedRefs: BrowseRowRef[] = [];
  const groupCounts: number[] = [];
  const groupStatsList: {
    n: number;
    min: number;
    max: number;
    mean: number;
    sd: number;
    p25: number;
    p75: number;
  }[] = [];
  const columns: BrowseColumn[] = [
    {
      key: CASE_COLUMN_KEY,
      category: true,
      label: 'Case',
      kind: 'text',
      computed: false,
      value: (row) => (groupedRefs[row] ? caseLabelOf(groupedRefs[row].caseId) : ''),
    },
    {
      key: 'entity',
      label: 'Group',
      kind: 'text',
      computed: false,
      value: (row) => groupedRefs[row]?.entity ?? '',
    },
    {
      key: 'group.units',
      label: 'Units',
      kind: 'number',
      computed: true,
      cellClass: 'count',
      value: (row) => groupCounts[row] ?? null,
    },
  ];

  // An intensive quantity refuses the whole tab, keeping the columns.
  if (spatial === 'REFUSE') {
    return {
      id: groupsTabId,
      label: groupsTabLabel,
      rows: [],
      columns,
      notes: [
        spatialRefusal(quantity, unit) ?? `"${quantity}" cannot be combined across generators.`,
      ],
      actions,
    };
  }

  // A power quantity's "% of range" is a % of capacity, and capacity is the
  // list's (`rangeNeedsList`).
  if (isPerUnit && isPower(unit) && !list) {
    return {
      id: groupsTabId,
      label: groupsTabLabel,
      rows: [],
      columns,
      notes: [rangeNeedsList(unit)],
      actions,
    };
  }

  const groups = generatorGroupNames();
  if (groups.length === 0) {
    return {
      id: groupsTabId,
      label: groupsTabLabel,
      rows: [],
      columns,
      notes: [
        'No generator groups are loaded yet — Edit Groups… builds them, or loads a membership CSV.',
      ],
      actions,
    };
  }

  const seriesScratch = scratch ?? createScratch();
  const gatheredScratch = createScratch();
  const rangeScratch = createScratch();
  // A group narrowed by the area scope or keep-set freezes its membership,
  // as a narrowed attribute bucket does.
  const narrowed = keep !== undefined || areas !== null;

  for (const table of tables) {
    const axisIndex = new Map(table.data.generators.map((name, index) => [name, index] as const));
    for (const groupName of groups) {
      // Scope and keep-set choose which members may enter; presence chooses
      // which do. A group with no contributors is no row at all.
      const scopedMembers = unitsInGroup(groupName).filter((name) => {
        const index = axisIndex.get(name);
        if (index === undefined || table.data.presence[index] === 0) return false;
        if (areas !== null && areaColumn) {
          const row = list?.index.get(name);
          if (row !== undefined) {
            const area = cellValue(areaColumn, row);
            if (typeof area !== 'string' || !areas.has(area)) return false;
          }
        }
        if (keep !== undefined && !keep.has(browseJoinKey(table.caseId, table.slotKey, name))) {
          return false;
        }
        return true;
      });
      if (scopedMembers.length === 0) continue;

      const contributing = reduceMembers(
        table.data.cube,
        table.data.presence,
        table.data.generators,
        new Set(scopedMembers),
        seriesScratch,
      );
      if (contributing === 0) continue;

      let series = seriesScratch;
      if (isPerUnit) {
        // The caps of the members just summed, so capacity the sum skipped
        // is not divided by -- the rule a group-by bucket follows.
        series = normalizedCopy(seriesScratch, capsOfSummed(scopedMembers), rangeScratch);
      }
      const n = applyMask(series, table.mask, gatheredScratch);
      const s = stats(gatheredScratch, n);
      const q = quantiles(gatheredScratch, n);

      groupedRefs.push(
        withRowId({
          kind: 'generator',
          caseId: table.caseId,
          slotKey: table.slotKey,
          entity: groupName,
          label: groupRowLabel(groupName, narrowed ? contributing : undefined, UNIT_NOUN),
          variable: quantity,
          unit: effectiveUnit,
          axisIndex: -1,
          groupBy: GENERATOR_GROUP_BY,
          groupValue: groupName,
          ...(narrowed ? { members: scopedMembers } : {}),
          ...(isPerUnit ? { perUnit: true } : {}),
        }),
      );
      groupCounts.push(contributing);
      groupStatsList.push({
        n,
        min: s.min,
        max: s.max,
        mean: s.mean,
        sd: s.sd,
        p25: q.p25,
        p75: q.p75,
      });
    }
  }

  return {
    id: groupsTabId,
    label: groupsTabLabel,
    rows: groupedRefs,
    columns: [
      ...columns,
      ...statColumnsFrom((row) => groupStatsList[row], isPerUnit ? 'ratio' : 'quantity'),
    ],
    notes: [
      'Ticking a group row draws the aggregate series across its member units. A unit can ' +
        'sit in several groups, so these rows do not sum to a fleet.',
      ...caplessNote(capless, 'a row'),
      ...notes,
    ],
    actions,
  };
}

// -------------------------------------------------------- group-by mode
//
// Entry conditions and the undefined return are stated at `groupByRows` in
// src/tables/bus/ui/browse.ts. Generator adds a third bucket type: a derived
// fuel column labelled from the registry.
function groupByRows(ctx: GeneratorTabCtx, groupBy: string): BrowseTab | undefined {
  const {
    tables,
    list,
    areas,
    keep,
    notes,
    quantity,
    isPerUnit,
    effectiveUnit,
    areaColumn,
    capsOfSummed,
    capless,
  } = ctx;
  const caseLabelOf = caseLabelsOf(tables);
  const byCase = groupBy === CASE_COLUMN_KEY;
  const targetColumn = byCase
    ? CASE_GROUP_BY
    : groupBy.startsWith('list.')
      ? groupBy.slice(5)
      : groupBy.startsWith('computed.')
        ? groupBy.slice(9)
        : groupBy;
  const derived = byCase ? undefined : derivedAttribute(targetColumn);
  if (byCase || (list && (list.byName.has(targetColumn) || derived))) {
    const effectiveTargetColumn = derived ? derived.label : targetColumn;
    const columnLabelOf =
      derived && list
        ? (name: string | number) => derived.labelOf((column) => bucketLabelFor(name, list, column))
        : undefined;
    const seededLabels = derived ? derived.values : undefined;

    const groupedRefs: BrowseRowRef[] = [];
    const groupCounts: number[] = [];
    const groupStatsList: {
      n: number;
      min: number;
      max: number;
      mean: number;
      sd: number;
      p25: number;
      p75: number;
    }[] = [];
    const gatheredScratch = createScratch();
    const rangeScratch = createScratch();

    for (const table of tables) {
      // A Case bucket: every unit answers with the table's case name.
      const labelOf = byCase ? () => table.caseName : columnLabelOf;
      const caseSeeded = byCase ? [table.caseName] : seededLabels;
      const areaFilter =
        areas !== null && areaColumn && list
          ? (name: string | number) => {
              const row = list.index.get(name);
              if (row === undefined) return true;
              const a = cellValue(areaColumn, row);
              return typeof a === 'string' && areas.has(a);
            }
          : undefined;
      // Area scope and keep-set are one predicate from here: the pooled
      // nameplate must exclude the same units the sums did.
      const unitFilter =
        keep === undefined
          ? areaFilter
          : (name: string | number) =>
              keep.has(browseJoinKey(table.caseId, table.slotKey, name)) &&
              (areaFilter === undefined || areaFilter(name));
      // Only a narrowed bucket freezes its membership; an unnarrowed one
      // re-derives exactly, and freezing it would change its row id.
      const frozen = unitFilter
        ? membersByLabel(table.data, list, effectiveTargetColumn, unitFilter, labelOf)
        : undefined;

      const { buckets } = bucketedReduce(
        table.data.cube,
        table.data.presence,
        table.data.generators,
        list,
        effectiveTargetColumn,
        unitFilter,
        labelOf,
        caseSeeded,
      );

      for (const bucket of buckets) {
        const members = frozen?.get(bucket.label);
        let series = bucket.series;
        if (isPerUnit) {
          // The caps of the units this bucket summed: the same membership
          // test, so capacity the sums skipped is not divided by.
          const summed: (string | number)[] = [];
          for (let i = 0; list && i < table.data.generators.length; i++) {
            if (table.data.presence && table.data.presence[i] === 0) continue;
            const genName = table.data.generators[i];
            if (unitFilter && !unitFilter(genName)) continue;
            const label = labelOf
              ? labelOf(genName)
              : bucketLabelFor(genName, list, effectiveTargetColumn);
            if (label === bucket.label) summed.push(genName);
          }
          series = normalizedCopy(bucket.series, capsOfSummed(summed), rangeScratch);
        }
        const n = applyMask(series, table.mask, gatheredScratch);

        const s = stats(gatheredScratch, n);
        const q = quantiles(gatheredScratch, n);

        groupedRefs.push(
          withRowId({
            kind: 'generator',
            caseId: table.caseId,
            slotKey: table.slotKey,
            entity: bucket.label,
            label: groupRowLabel(bucket.label, members ? bucket.count : undefined, UNIT_NOUN),
            variable: quantity,
            unit: effectiveUnit,
            axisIndex: -1,
            groupBy: effectiveTargetColumn,
            groupValue: bucket.label,
            ...(members ? { members } : {}),
            perUnit: isPerUnit,
          }),
        );
        groupCounts.push(bucket.count);
        groupStatsList.push({
          n,
          min: s.min,
          max: s.max,
          mean: s.mean,
          sd: s.sd,
          p25: q.p25,
          p75: q.p75,
        });
      }
    }

    const columns: BrowseColumn[] = [
      // No Case column beside a Case bucket (as in src/tables/bus/ui/browse.ts).
      ...(byCase
        ? []
        : [
            {
              key: CASE_COLUMN_KEY,
              category: true,
              label: 'Case',
              kind: 'text' as const,
              computed: false,
              value: (row: number) => caseLabelOf(groupedRefs[row].caseId),
            },
          ]),
      {
        key: byCase
          ? CASE_COLUMN_KEY
          : derived
            ? `computed.${derived.key}`
            : `list.${targetColumn}`,
        label: effectiveTargetColumn,
        kind: 'text',
        computed: false,
        groupable: true,
        // A Case bucket's value is the Case's name (in the row id); it reads
        // as the Case's label.
        value: (row) => (byCase ? caseLabelOf(groupedRefs[row].caseId) : groupedRefs[row].entity),
      },
      {
        key: 'group.units',
        label: 'Units',
        kind: 'number',
        computed: true,
        cellClass: 'count',
        value: (row) => groupCounts[row],
      },
      ...statColumnsFrom((row) => groupStatsList[row], isPerUnit ? 'ratio' : 'quantity'),
    ];

    return {
      id: 'generator',
      label: 'Generator',
      rows: groupedRefs,
      columns,
      notes: [
        byCase
          ? "Rows are cases: each is the sum of every unit the case carries, after this tab's " +
            'column filters. A case row and any unit row inside it cannot be stacked.'
          : `Grouped by ${effectiveTargetColumn}. Ticking a row draws the aggregate hourly series.`,
        ...caplessNote(capless, 'a row'),
        ...notes,
      ],
    };
  }
  return undefined;
}

// ------------------------------------------------------------ the rows
//
// Scope first, plane arithmetic second: a row the scope dropped costs nothing.
function ungroupedRows(ctx: GeneratorTabCtx): BrowseTab {
  const {
    tables,
    list,
    areas,
    scratch: inputScratch,
    memo,
    notes,
    isPerUnit,
    effectiveUnit,
    canGroup,
    spatialReason,
    attributeReason,
    columnOf,
    areaColumn,
    maxCapColumn,
    capsFor,
  } = ctx;
  const caseLabelOf = caseLabelsOf(tables);
  const keyColumn = columnOf(GENERATOR_LIST.keyColumn);
  const listRows: number[] = [];
  const listNames: string[] = [];
  const known = new Set<string>();
  if (list && keyColumn) {
    for (let row = 0; row < list.rowCount; row++) {
      const name = String(cellValue(keyColumn, row) ?? '');
      known.add(name);
      if (areas !== null && areaColumn) {
        const area = cellValue(areaColumn, row);
        if (typeof area !== 'string' || !areas.has(area)) continue;
      }
      listRows.push(row);
      listNames.push(name);
    }
  }

  const refs: BrowseRowRef[] = [];
  const joinedRows: number[] = [];
  const rowCounts: number[] = [];
  let hidden = 0;

  for (const table of tables) {
    const before = refs.length;
    const tableQty = table.data.quantity;
    const axis = new Map(table.data.generators.map((name, index) => [name, index] as const));
    /** This table's axis index for a name, or -1 when it has no hours for it
     * (the row the tab drops). */
    const carried = (name: string): number => {
      const index = axis.get(name);
      return index !== undefined && table.data.presence[index] === 1 ? index : -1;
    };
    const push = (name: string, axisIndex: number, listRow: number): void => {
      refs.push(
        withRowId({
          kind: 'generator',
          caseId: table.caseId,
          slotKey: table.slotKey,
          entity: name,
          variable: tableQty,
          unit: effectiveUnit,
          axisIndex,
          perUnit: isPerUnit,
        }),
      );
      joinedRows.push(listRow);
    };

    for (let i = 0; i < listNames.length; i++) {
      const axisIndex = carried(listNames[i]);
      if (axisIndex < 0) {
        hidden++;
        continue;
      }
      push(listNames[i], axisIndex, listRows[i]);
    }
    for (const [name, index] of axis) {
      if (known.has(name)) continue;
      if (table.data.presence[index] !== 1) {
        hidden++;
        continue;
      }
      push(name, index, -1);
    }
    rowCounts.push(refs.length - before);
  }

  if (hidden > 0) {
    notes.push(
      `${hidden} unit${hidden === 1 ? '' : 's'} hidden: no hours loaded for ${hidden === 1 ? 'it' : 'them'} in the selected case${tables.length === 1 ? '' : 's'}.`,
    );
  }

  // ------------------------------------------------------- the stat pass
  const ranked = rankScopedRows({
    tables,
    rowCounts,
    axisIndexOf: (row) => refs[row].axisIndex,
    planesOf: (data) => ({ presence: data.presence, planeStart }),
    scratch: inputScratch ?? createScratch(),
    memo,
    ...(isPerUnit
      ? { rangeOf: (row: number) => capsFor(joinedRows[row] < 0 ? [] : [joinedRows[row]]) }
      : {}),
  });

  // ---------------------------------------------------------- the columns
  const columns: BrowseColumn[] = [
    {
      key: CASE_COLUMN_KEY,
      category: true,
      label: 'Case',
      kind: 'text',
      computed: false,
      // The Case bucket needs no list; only the quantity can refuse it.
      groupable: spatialReason === undefined,
      groupDisabledReason: spatialReason,
      value: (row) => caseLabelOf(refs[row].caseId),
    },
    {
      key: 'entity',
      label: 'Generator',
      kind: 'text',
      computed: false,
      value: (row) => refs[row].entity,
    },
  ];

  // One column per derived attribute. The three fuel columns are one question
  // at three depths (broad category, cleaned vocabulary, five buckets).
  if (columnOf('FuelType') ?? columnOf('Technology') ?? columnOf('SubType')) {
    for (const attribute of GENERATOR_DERIVED) {
      columns.push({
        key: `computed.${attribute.key}`,
        label: attribute.label,
        kind: 'text',
        computed: true,
        // Only the cleaned fuel is on by default; two fuel columns crowd the
        // statistics.
        defaultHidden: attribute.key !== 'fuelClean',
        category: true,
        groupable: canGroup,
        groupDisabledReason: attributeReason,
        value: (row) => {
          if (joinedRows[row] < 0) return null;
          return attribute.labelOf((name) => {
            const column = columnOf(name);
            return column ? cellValue(column, joinedRows[row]) : '';
          });
        },
      });
    }
  }

  for (const column of list?.columns ?? []) {
    if (column.name === GENERATOR_LIST.keyColumn) continue;
    // A non-category column gets no group control at all (see `isBucketable`):
    // `Long Name` would bucket a fleet into one row per unit.
    const bucketable = isBucketable(column);
    columns.push({
      key: `list.${column.name}`,
      label: column.name,
      kind: column.kind === 'int' || column.kind === 'float' ? 'number' : 'text',
      computed: false,
      defaultHidden: !DEFAULT_ON_LIST_COLUMNS.has(column.name),
      category: bucketable,
      defaultSlicer: column.name === 'FuelType',
      groupable: bucketable && canGroup,
      groupDisabledReason: bucketable ? attributeReason : undefined,
      // An int here is an id or code, so no thousands separator.
      cellClass: column.kind === 'int' ? 'count' : undefined,
      value: (row) => (joinedRows[row] < 0 ? null : cellValue(column, joinedRows[row])),
    });
  }

  columns.push(
    // "% of range" stats are ratios (whole percent); absolute ones are quantities.
    ...statColumns(ranked, isPerUnit ? 'ratio' : 'quantity'),
  );

  if (maxCapColumn) {
    columns.push({
      key: 'stat.cf',
      label: 'Cap factor (%)',
      kind: 'number',
      computed: true,
      cellClass: 'ratio',
      value: (row) => {
        if (joinedRows[row] < 0) return null;
        const cap = cellValue(maxCapColumn, joinedRows[row]);
        const mean = ranked[row * RANKED_FIELDS + RANKED.mean];
        if (typeof cap !== 'number' || cap === 0 || Number.isNaN(mean)) return null;
        return mean / cap;
      },
    });
  }

  // The group-editor hand-off lives on the ungrouped tab only: grouped rows
  // are buckets, not units. "Filter and sort until the table IS the set, then
  // file it" uses columns a small modal cannot offer.
  const actions = [{ id: 'add-shown-to-group', label: 'Add shown to a group…' }];
  return { id: 'generator', label: 'Generator', rows: refs, columns, notes, actions };
}

/** What a declared Generator tab reads. Structural, so the kind never imports
 *  the scoping that produces it. */
export interface GeneratorTabScope {
  readonly tables: readonly GeneratorBrowseTable[];
  readonly variable: string;
  readonly variables: readonly string[];
  readonly signature: string;
}

/**
 * Generator's tabs: the units, and the units by injection group. The
 * GeneratorList is passed in because its session-wide lifetime lives
 * elsewhere.
 */
export function declareGeneratorTabs(
  entity: GeneratorTabScope,
  groups: GeneratorTabScope,
  list: LookupTable | undefined,
  scratch: Float32Array | undefined,
  memo?: RankMemo,
) {
  return [
    {
      id: 'generator',
      label: 'Generator',
      scope: entity,
      offersRange: true,
      build: (groupBy?: string | null, perUnit?: boolean, keep?: ReadonlySet<string>) =>
        buildGeneratorTab({
          tables: entity.tables,
          list,
          areas: null,
          scratch,
          memo,
          groupBy,
          perUnit,
          keep,
        }),
    },
    {
      id: 'generator-groups',
      label: 'Generator Groups',
      scope: groups,
      offersRange: true,
      build: (_groupBy?: string | null, perUnit?: boolean) =>
        buildGeneratorTab({
          tables: groups.tables,
          list,
          areas: null,
          scratch,
          memo,
          isGroupTab: true,
          perUnit,
        }),
    },
  ];
}
