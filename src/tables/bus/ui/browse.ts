// src/tables/bus/ui/browse.ts
//
// The Bus tab of the browse drawer: rows, columns and the ranking pass. A
// deliberate twin of `src/tables/generator/ui/browse.ts` (the worked
// example), differing where the kinds differ:
//
//   * **The axis is the ID, not the name.** Bus names may repeat, so a row's
//     `entity` is the `BusNumber` and its `label` is `busLabel(name, id)`.
//   * No capacity factor: a bus has no nameplate. "% of range" divides each
//     row by its own unfiltered peak/trough, in any unit, grouped rows after
//     they are summed.
//
// Buses combine on the terms `spatialOf` states (EXTENSIVE and RATE sum; LMP
// and kV refuse by unit). Group controls follow AGENTS.md's two-owner rule:
// the quantity (`spatialOf`) and the column (`isBucketable`).

import { applyMask, createScratch, quantiles, stats, type RankMemo } from '../../../kernels';
import { cellValue } from '../../../lookups/merge';
import { BUS_LIST } from '../../../lookups/schema';
import {
  bucketLabelFor,
  bucketedReduce,
  isBucketable,
  reduceMembers,
} from '../../../lookups/reduce';
import type { LookupColumn, LookupTable } from '../../../lookups/types';
import { CASE_GROUP_BY } from '../../../series/model';
import { normalizedCopy } from '../../../series/range';
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
import { planeStart } from '../kernels';
import { BUS_GROUP_BY, busGroupNames, busesInGroup } from '../groups';
import { busLabel, spatialOf, spatialRefusal, unitOf, type SpatialRule } from '../rules';
import type { BusTable } from '../types';
import { MEMBER_NOUN as BUS_NOUN } from '../series';

/** The BusList column the area scope joins through. `LoadArea` (where a bus
 * settles), not `PSSEArea` (the power-flow model's area): one "area" control. */
const AREA_COLUMN = 'LoadArea';

/**
 * The BusList columns the tab opens without: power-flow solution and map
 * fields an analyst rarely ranks by. Named as the hidden set, unlike the
 * Generator tab's shown set, because BusList is short and a column it gains
 * (a zone, an owner) is more likely a category worth seeing.
 */
const DEFAULT_OFF_LIST_COLUMNS: ReadonlySet<string> = new Set([
  'Type',
  'VM',
  'VA',
  'Latitude',
  'Longitude',
]);

/** One bus table in scope, as the drawer's caller already has it. */
export interface BusBrowseTable {
  caseId: string;
  caseName: string;
  caseLabel: string;
  slotKey: string;
  data: BusTable;
  /** The hours kept, for THIS table (one mask per table). */
  mask: Uint8Array;
}

export interface BusBrowseInput {
  /** The (case, slot) tables in scope, all of one quantity. */
  tables: readonly BusBrowseTable[];
  /** The session's BusList, or undefined when none is loaded. */
  list: LookupTable | undefined;
  /** Areas the scope keeps, or null for all of them. */
  areas: ReadonlySet<string> | null;
  /** Reused across rows. */
  scratch?: Float32Array;
  memo?: RankMemo;
  /** The BusList column to collapse rows by, or null. */
  groupBy?: string | null;
  /** The bus-groups tab: rows are authored groups from the session map
   * (`src/tables/bus/groups.ts`), which needs no list. */
  isGroupTab?: boolean;
  /** See `keptRowKeys` in src/ui/browse-model.ts. */
  keep?: ReadonlySet<string>;
  /** "% of range": stats of each series over its own peak, as ratios. */
  perUnit?: boolean;
}

interface GroupStats {
  n: number;
  min: number;
  max: number;
  mean: number;
  sd: number;
  p25: number;
  p75: number;
}

/** Each bucket's members after a filter (label -> ids, axis order), for
 * freezing onto rows. */
function membersByLabel(
  data: BusTable,
  list: LookupTable | undefined,
  column: string,
  filter: (id: string | number) => boolean,
  labelOf?: (id: string | number) => string,
): Map<string, number[]> {
  const byLabel = new Map<string, number[]>();
  for (let i = 0; i < data.buses.length; i++) {
    if (data.presence[i] === 0) continue;
    const id = data.buses[i];
    if (!filter(id)) continue;
    const label = labelOf ? labelOf(id) : bucketLabelFor(id, list, column);
    const held = byLabel.get(label);
    if (held) held.push(id);
    else byLabel.set(label, [id]);
  }
  return byLabel;
}

/** Build the tab. Deterministic order: tables as given, then BusList's order,
 * then export-only ids in axis order. A row is a bus the table has hours for;
 * BusList only names and describes it. */
export function buildBusTab(input: BusBrowseInput): BrowseTab {
  const { tables, list, areas } = input;
  const caseLabelOf = caseLabelsOf(tables);
  const notes: string[] = [];

  const quantity = tables[0]?.data.quantity ?? '';
  const tabUnit = unitOf(quantity);
  const perUnit = Boolean(input.perUnit);
  const spatial = spatialOf(tabUnit);
  // Two refusals: the quantity's (absolute; nothing makes an LMP addable) and
  // the missing list's. Only the quantity's blocks a group-by BY CASE, whose
  // membership is the table's own axis.
  const spatialReason =
    spatial === 'REFUSE'
      ? (spatialRefusal(quantity, tabUnit) ?? `"${quantity}" cannot be combined across buses.`)
      : undefined;
  const listReason = list ? undefined : `Grouping buses needs ${BUS_LIST.banner} to be loaded.`;
  const attributeReason = spatialReason ?? listReason;
  const canGroup = attributeReason === undefined;

  const columnOf = (name: string) => {
    const index = list?.byName.get(name);
    return index === undefined || !list ? undefined : list.columns[index];
  };
  const areaColumn = columnOf(AREA_COLUMN);
  if (areas !== null && !areaColumn) {
    notes.push(
      `Area scope needs ${BUS_LIST.banner} (${AREA_COLUMN}); it is not loaded, so every area ` +
        'is listed.',
    );
  }
  if (!list) {
    notes.push('No BusList loaded: names come from the export, and attribute columns are empty.');
  }

  if (input.isGroupTab) {
    return groupTabRows(input, notes, quantity, tabUnit, spatial, areaColumn);
  }
  if (input.groupBy && spatialReason === undefined) {
    const grouped = groupByRows(input, input.groupBy, notes, quantity, tabUnit, areaColumn);
    if (grouped) return grouped;
  }

  // ------------------------------------------------------------ the rows
  const keyColumn = columnOf(BUS_LIST.keyColumn);
  const nameColumn = columnOf('Name');
  const listRows: number[] = [];
  const listIds: number[] = [];
  /** EVERY id the list carries, scoped or not, so a scoped-out bus cannot
   * reappear through the export-only pass looking unjoinable. */
  const known = new Set<number>();
  if (list && keyColumn) {
    for (let row = 0; row < list.rowCount; row++) {
      const id = cellValue(keyColumn, row);
      // A blank or non-numeric BusID is not a bus; never join it to id 0.
      if (typeof id !== 'number') continue;
      known.add(id);
      if (areas !== null && areaColumn) {
        const area = cellValue(areaColumn, row);
        if (typeof area !== 'string' || !areas.has(area)) continue;
      }
      listRows.push(row);
      listIds.push(id);
    }
  }

  const refs: BrowseRowRef[] = [];
  /** Parallel to `refs`: the BusList row each one joined to, or -1. */
  const joinedRows: number[] = [];
  const rowCounts: number[] = [];
  let hidden = 0;

  for (const table of tables) {
    const before = refs.length;
    const quantity = table.data.quantity;
    const unit = unitOf(quantity);
    /** Only the buses this table has hours for: a BusList runs to tens of
     * thousands of rows, and a table listing every one is mostly blanks. */
    const axis = new Map<number, number>();
    table.data.buses.forEach((id, index) => {
      if (axis.has(id)) return;
      if (table.data.presence[index] === 0) hidden++;
      else axis.set(id, index);
    });
    const push = (id: number, axisIndex: number, listRow: number): void => {
      // The export's name where it carries the bus, else the list's.
      const exported = axisIndex >= 0 ? table.data.names[axisIndex] : '';
      const listed = listRow >= 0 && nameColumn ? cellValue(nameColumn, listRow) : null;
      const name = exported || (typeof listed === 'string' ? listed : '');
      refs.push(
        withRowId({
          kind: 'bus',
          caseId: table.caseId,
          slotKey: table.slotKey,
          entity: id,
          label: busLabel(name, id),
          variable: quantity,
          unit: perUnit ? '%' : unit,
          axisIndex,
          ...(perUnit ? { perUnit: true } : {}),
        }),
      );
      joinedRows.push(listRow);
    };

    for (let i = 0; i < listIds.length; i++) {
      const axisIndex = axis.get(listIds[i]);
      if (axisIndex !== undefined) push(listIds[i], axisIndex, listRows[i]);
    }
    // Export-only buses: never dropped or folded into a list row, and not
    // hidden by the area scope, which cannot speak about them.
    for (const [id, index] of axis) {
      if (!known.has(id)) push(id, index, -1);
    }
    rowCounts.push(refs.length - before);
  }
  if (hidden > 0) {
    notes.push(
      `${hidden} bus${hidden === 1 ? '' : 'es'} hidden: no hours loaded for ${hidden === 1 ? 'it' : 'them'} in the selected case${tables.length === 1 ? '' : 's'}.`,
    );
  }

  // The stat pass: one bus is one plane.
  const ranked = rankScopedRows({
    tables,
    rowCounts,
    axisIndexOf: (row) => refs[row].axisIndex,
    planesOf: (data) => ({ presence: data.presence, planeStart }),
    scratch: input.scratch ?? createScratch(),
    memo: input.memo,
    ...(perUnit ? { rangeOf: () => ({}) } : {}),
  });

  // ---------------------------------------------------------- the columns
  const columns: BrowseColumn[] = [
    {
      key: CASE_COLUMN_KEY,
      label: 'Case',
      kind: 'text',
      computed: false,
      // The Case bucket needs no BusList (the system figure runs are compared
      // on); only the quantity can refuse it.
      groupable: spatialReason === undefined,
      groupDisabledReason: spatialReason,
      value: (row) => caseLabelOf(refs[row].caseId),
    },
    {
      key: 'entity',
      label: 'Bus',
      kind: 'text',
      // The label, sorted as text; the id has its own numeric column.
      computed: false,
      value: (row) => refs[row].label ?? String(refs[row].entity),
    },
    {
      key: 'busid',
      label: BUS_LIST.keyColumn,
      kind: 'number',
      // The export's own axis, present with no BusList.
      computed: false,
      // An id: no thousands separator.
      cellClass: 'count',
      value: (row) => Number(refs[row].entity),
    },
  ];

  for (const column of list?.columns ?? []) {
    // The key column and `Name` are already shown above.
    if (column.name === BUS_LIST.keyColumn || column.name === 'Name') continue;
    // No group control at all for a non-category (see `isBucketable`).
    const bucketable = isBucketable(column);
    columns.push({
      key: `list.${column.name}`,
      label: column.name,
      kind: column.kind === 'int' || column.kind === 'float' ? 'number' : 'text',
      computed: false,
      defaultHidden: DEFAULT_OFF_LIST_COLUMNS.has(column.name),
      groupable: bucketable && canGroup,
      groupDisabledReason: bucketable ? attributeReason : undefined,
      // An int here is an id or code.
      cellClass: column.kind === 'int' ? 'count' : undefined,
      value: (row) => (joinedRows[row] < 0 ? null : cellValue(column, joinedRows[row])),
    });
  }

  columns.push(...statColumns(ranked, perUnit ? 'ratio' : 'quantity'));

  // The group-editor hand-off lives on the ungrouped tab only.
  return {
    id: 'bus',
    label: 'Bus',
    rows: refs,
    columns,
    notes,
    actions: [{ id: 'add-shown-to-group', label: 'Add shown to a group…' }],
  };
}

// ------------------------------------------------------ user-authored groups
//
// As Generator's `groupTabRows`, but members are bus ids, so `list` serves
// only the area scope.
function groupTabRows(
  input: BusBrowseInput,
  notes: string[],
  quantity: string,
  unit: string,
  spatial: SpatialRule,
  areaColumn: LookupColumn | undefined,
): BrowseTab {
  const { tables, list, areas, keep } = input;
  const caseLabelOf = caseLabelsOf(tables);
  const actions = [{ id: 'edit-groups', label: 'Edit Groups…' }];
  const groupsTabId = 'bus-groups';
  const groupsTabLabel = 'Bus Groups';

  const groupedRefs: BrowseRowRef[] = [];
  const groupCounts: number[] = [];
  const groupStatsList: GroupStats[] = [];
  const columns: BrowseColumn[] = [
    {
      key: CASE_COLUMN_KEY,
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
      groupable: false,
      value: (row) => groupedRefs[row]?.entity ?? '',
    },
    {
      key: 'group.buses',
      label: 'Buses',
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
      notes: [spatialRefusal(quantity, unit) ?? `"${quantity}" cannot be combined across buses.`],
      actions,
    };
  }

  const groups = busGroupNames();
  if (groups.length === 0) {
    return {
      id: groupsTabId,
      label: groupsTabLabel,
      rows: [],
      columns,
      notes: [
        'No bus groups are loaded yet — Edit Groups… builds them, or loads a membership CSV.',
      ],
      actions,
    };
  }

  const seriesScratch = input.scratch ?? createScratch();
  const gatheredScratch = createScratch();
  const rangeScratch = createScratch();
  const perUnit = Boolean(input.perUnit);
  // A narrowed group freezes its membership, as a narrowed bucket does.
  const narrowed = keep !== undefined || areas !== null;

  for (const table of tables) {
    const axisIndex = new Map<number, number>();
    table.data.buses.forEach((id, index) => {
      if (!axisIndex.has(id)) axisIndex.set(id, index);
    });
    for (const groupName of groups) {
      // The same three gates as Generator's.
      const scopedMembers = busesInGroup(groupName).filter((id) => {
        const index = axisIndex.get(id);
        if (index === undefined || table.data.presence[index] === 0) return false;
        if (areas !== null && areaColumn) {
          const row = list?.index.get(id);
          if (row !== undefined) {
            const area = cellValue(areaColumn, row);
            if (typeof area !== 'string' || !areas.has(area)) return false;
          }
        }
        if (keep !== undefined && !keep.has(browseJoinKey(table.caseId, table.slotKey, id))) {
          return false;
        }
        return true;
      });
      if (scopedMembers.length === 0) continue;

      const contributing = reduceMembers(
        table.data.cube,
        table.data.presence,
        table.data.buses,
        new Set<string | number>(scopedMembers),
        seriesScratch,
      );
      if (contributing === 0) continue;

      // After the sum: the peak of the group, as a bucket's is.
      const series = perUnit ? normalizedCopy(seriesScratch, {}, rangeScratch) : seriesScratch;
      const n = applyMask(series, table.mask, gatheredScratch);
      const s = stats(gatheredScratch, n);
      const q = quantiles(gatheredScratch, n);

      groupedRefs.push(
        withRowId({
          kind: 'bus',
          caseId: table.caseId,
          slotKey: table.slotKey,
          entity: groupName,
          label: groupRowLabel(groupName, narrowed ? contributing : undefined, BUS_NOUN),
          variable: quantity,
          unit: perUnit ? '%' : unit,
          axisIndex: -1,
          groupBy: BUS_GROUP_BY,
          groupValue: groupName,
          ...(narrowed ? { members: scopedMembers } : {}),
          ...(perUnit ? { perUnit: true } : {}),
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
      ...statColumnsFrom((row) => groupStatsList[row], perUnit ? 'ratio' : 'quantity'),
    ],
    notes: [
      'Ticking a group row draws the aggregate series across its member buses. A bus can sit ' +
        'in several groups, so these rows do not sum to the system.',
      ...notes,
    ],
    actions,
  };
}

// -------------------------------------------------------- group-by mode
//
// Reached only once the QUANTITY agrees to combine. Returns undefined when
// the column is not the list's (or there is no list and the bucket is not
// Case), so the caller falls through to ungrouped rows. A Case bucket is just
// a `labelOf` that answers the case's name for every bus.
function groupByRows(
  input: BusBrowseInput,
  groupBy: string,
  notes: string[],
  quantity: string,
  unit: string,
  areaColumn: LookupColumn | undefined,
): BrowseTab | undefined {
  const { tables, list, areas, keep } = input;
  const caseLabelOf = caseLabelsOf(tables);
  const byCase = groupBy === CASE_COLUMN_KEY;
  const targetColumn = byCase
    ? CASE_GROUP_BY
    : groupBy.startsWith('list.')
      ? groupBy.slice(5)
      : groupBy;
  if (!byCase && (!list || !list.byName.has(targetColumn))) return undefined;

  const groupedRefs: BrowseRowRef[] = [];
  const groupCounts: number[] = [];
  const groupStatsList: GroupStats[] = [];
  const gatheredScratch = createScratch();
  const rangeScratch = createScratch();
  const perUnit = Boolean(input.perUnit);

  for (const table of tables) {
    const areaFilter =
      areas !== null && areaColumn && list
        ? (id: string | number) => {
            const row = list.index.get(id);
            if (row === undefined) return true;
            const a = cellValue(areaColumn, row);
            return typeof a === 'string' && areas.has(a);
          }
        : undefined;
    // Area scope and keep-set are one predicate from here.
    const busFilter =
      keep === undefined
        ? areaFilter
        : (id: string | number) =>
            keep.has(browseJoinKey(table.caseId, table.slotKey, id)) &&
            (areaFilter === undefined || areaFilter(id));
    const labelOf = byCase ? () => table.caseName : undefined;
    // Frozen only when narrowed.
    const frozen = busFilter
      ? membersByLabel(table.data, list, targetColumn, busFilter, labelOf)
      : undefined;

    const { buckets } = bucketedReduce(
      table.data.cube,
      table.data.presence,
      table.data.buses,
      list,
      targetColumn,
      busFilter,
      labelOf,
    );

    for (const bucket of buckets) {
      const members = frozen?.get(bucket.label);
      // After the sum: the peak of the bucket, not of its members.
      const series = perUnit ? normalizedCopy(bucket.series, {}, rangeScratch) : bucket.series;
      const n = applyMask(series, table.mask, gatheredScratch);
      const s = stats(gatheredScratch, n);
      const q = quantiles(gatheredScratch, n);
      groupedRefs.push(
        withRowId({
          kind: 'bus',
          caseId: table.caseId,
          slotKey: table.slotKey,
          entity: bucket.label,
          label: groupRowLabel(bucket.label, members ? bucket.count : undefined, BUS_NOUN),
          variable: quantity,
          unit: perUnit ? '%' : unit,
          axisIndex: -1,
          groupBy: targetColumn,
          groupValue: bucket.label,
          ...(members ? { members } : {}),
          ...(perUnit ? { perUnit: true } : {}),
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

  return {
    id: 'bus',
    label: 'Bus',
    rows: groupedRefs,
    columns: [
      // No Case column when the bucket IS the case.
      ...(byCase
        ? []
        : [
            {
              key: CASE_COLUMN_KEY,
              label: 'Case',
              kind: 'text' as const,
              computed: false,
              value: (row: number) =>
                groupedRefs[row] ? caseLabelOf(groupedRefs[row].caseId) : '',
            },
          ]),
      {
        // Keyed on the Case column when that is the bucket, so this header's
        // button is UNGROUP.
        key: byCase ? CASE_COLUMN_KEY : 'entity',
        label: targetColumn,
        kind: 'text',
        computed: false,
        groupable: true,
        // A Case bucket's value is the Case's name (in the row id); it reads
        // as the Case's label.
        value: (row) =>
          groupedRefs[row] === undefined
            ? ''
            : byCase
              ? caseLabelOf(groupedRefs[row].caseId)
              : groupedRefs[row].entity,
      },
      {
        key: 'group.buses',
        label: 'Buses',
        kind: 'number',
        computed: true,
        cellClass: 'count',
        value: (row) => groupCounts[row] ?? null,
      },
      ...statColumnsFrom((row) => groupStatsList[row], perUnit ? 'ratio' : 'quantity'),
    ],
    notes: [
      byCase
        ? "Rows are cases: each is the sum of every bus the case carries, after this tab's " +
          'column filters. A case row and any bus row inside it cannot be stacked.'
        : `Rows are ${targetColumn} groups: each is the sum of its member buses' planes.`,
      ...notes,
    ],
  };
}

/** What a declared Bus tab reads; structural, so the kind imports no scoping. */
export interface BusTabScope {
  readonly tables: readonly BusBrowseTable[];
  readonly variable: string;
  readonly variables: readonly string[];
  readonly signature: string;
}

/** Bus's tabs: the buses, and the buses by authored group. The BusList is
 * passed in because its session-wide lifetime lives elsewhere. */
export function declareBusTabs(
  entity: BusTabScope,
  groups: BusTabScope,
  list: LookupTable | undefined,
  scratch: Float32Array | undefined,
  memo?: RankMemo,
) {
  return [
    {
      id: 'bus',
      label: 'Bus',
      scope: entity,
      offersRange: true,
      build: (groupBy?: string | null, perUnit?: boolean, keep?: ReadonlySet<string>) =>
        buildBusTab({
          tables: entity.tables,
          list,
          areas: null,
          scratch,
          memo,
          groupBy,
          keep,
          perUnit,
        }),
    },
    {
      id: 'bus-groups',
      label: 'Bus Groups',
      scope: groups,
      offersRange: true,
      build: (_groupBy?: string | null, perUnit?: boolean) =>
        buildBusTab({
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
