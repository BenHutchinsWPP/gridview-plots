// src/tables/area/ui/browse.ts
//
// The Area tab of the browse drawer (see src/tables/generator/ui/browse.ts
// for the pattern). Area differs: its rows are the area AXIS, not a lookup
// list; the variable selects which metric plane to rank; and group-by
// collapses into the defined Groupings. Grouped stats are stats of the
// aggregate (`buildSeries`), filters arrive as a keep-set, and a narrowed
// group freezes its membership onto its row. "% of range" divides each row by
// its own unfiltered peak/trough (an area has no limit), a group after it is
// combined.

import { HOURS_PER_YEAR } from '../../../model/calendar';
import { createScratch, type RankMemo } from '../../../kernels';
import { rankScopedRows } from '../../../ui/browse-planes';
import { normalizedCopy } from '../../../series/range';
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
import { areasIn, groupingNames } from '../../../lookups/groupings';
import { applyMask, buildSeries, quantiles, stats } from '../kernels';
import { ruleFor, RATIO_METRICS, withheldFromGroups } from '../rules';
import type { AreaTable } from '../types';
import { MEMBER_NOUN as AREA_NOUN } from '../series';

/** One area table in scope, as the drawer's caller already has it. */
export interface AreaBrowseTable {
  caseId: string;
  caseName: string;
  caseLabel: string;
  slotKey: string;
  data: AreaTable;
  /** The hours kept, for THIS table. */
  mask: Uint8Array;
}

export interface AreaBrowseInput {
  /** The (case, slot) tables the CASE scope kept. */
  tables: readonly AreaBrowseTable[];
  variable: string;
  /** Areas the scope keeps, or null for all of them. */
  areas: ReadonlySet<string> | null;
  /** Reused across every row. */
  scratch?: Float32Array;
  memo?: RankMemo;
  /** The attribute column to collapse rows by, or null. */
  groupBy?: string | null;
  isGroupTab?: boolean;
  /** Loaded metrics the groups tab does not offer. The Area tab names the one
   * it shows, since an empty groups tab is not on the bar to say so. */
  withheld?: readonly string[];
  /** See `keptRowKeys` in src/ui/browse-model.ts. */
  keep?: ReadonlySet<string>;
  /** "% of range": stats of each series over its own peak, as ratios. */
  perUnit?: boolean;
}

export function buildAreaTab(input: AreaBrowseInput): BrowseTab {
  const { tables, variable, areas, groupBy, keep } = input;
  const caseLabelOf = caseLabelsOf(tables);
  const notes: string[] = [];
  for (const metric of input.withheld ?? []) {
    if (!input.isGroupTab && metric !== variable) continue;
    const reason = withheldFromGroups(metric);
    if (reason) notes.push(reason);
  }

  const rule = ruleFor(variable);
  const perUnit = Boolean(input.perUnit);
  const unit = perUnit ? '%' : (rule?.unit ?? '');
  // Ratio or quantity, from Area's own rules (MW, MWh, k$ and $/MWh are all
  // quantities); any metric divided by its range is a ratio.
  const statClass = perUnit || RATIO_METRICS.has(variable.trim()) ? 'ratio' : 'quantity';
  const rangeTag = perUnit ? { perUnit: true } : {};

  let canGroup = false;
  let groupRefusal: string | undefined;

  if (rule?.series === 'SUM') {
    canGroup = true;
  } else if (rule?.series === 'WEIGHTED_MEAN') {
    const weightMetric = rule.weight;
    const hasWeight = weightMetric && tables.every((t) => t.data.metrics.includes(weightMetric));
    if (hasWeight) {
      canGroup = true;
    } else {
      groupRefusal = `"${variable}" needs "${weightMetric}" loaded to compute group weighted mean.`;
    }
  } else {
    groupRefusal = `"${variable}" has no aggregation rule for combining areas.`;
  }

  const actions = input.isGroupTab ? [{ id: 'edit-groups', label: 'Edit Groups…' }] : undefined;

  // -------------------------------------------------------- group-by mode
  if (
    input.isGroupTab ||
    (canGroup && (groupBy === 'entity' || groupBy === 'group' || groupBy === 'Group'))
  ) {
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
        groupable: !input.isGroupTab,
        value: (row) => groupedRefs[row]?.entity ?? '',
      },
      {
        key: 'group.areas',
        label: 'Areas',
        kind: 'number',
        computed: true,
        cellClass: 'count',
        value: (row) => groupCounts[row] ?? null,
      },
      ...statColumnsFrom((row) => groupStatsList[row], statClass),
    ];

    if (input.isGroupTab && !canGroup) {
      return {
        id: 'area-groups',
        label: 'Area Groups',
        rows: [],
        columns,
        notes: [groupRefusal ?? 'Cannot group this variable.', ...notes],
        actions,
      };
    }
    const seriesScratch = input.scratch ?? createScratch();
    const weightsScratch = createScratch();
    const gatheredScratch = createScratch();
    const rangeScratch = createScratch();

    const groups = groupingNames();
    // Only a narrowed group freezes its membership; an unnarrowed one
    // re-derives exactly, and freezing it would change its row id.
    const narrowed = keep !== undefined || areas !== null;

    for (const table of tables) {
      for (const groupName of groups) {
        const members = areasIn(groupName);
        // A group with no surviving areas is no row at all.
        const scopedMembers = members.filter(
          (m) =>
            table.data.areas.includes(m) &&
            (areas === null || areas.has(m)) &&
            (keep === undefined || keep.has(browseJoinKey(table.caseId, table.slotKey, m))),
        );
        if (scopedMembers.length === 0) continue;

        const built = buildSeries(
          table.data,
          variable,
          scopedMembers,
          seriesScratch,
          weightsScratch,
          table.caseLabel,
        );
        if (built.values === null) continue;
        // The aggregate's caveats (plain-mean fallback, zero-weight hours)
        // belong on the tab that ranks it, before anything is pinned.
        for (const warning of built.warnings) if (!notes.includes(warning)) notes.push(warning);

        // After the combine: the peak of the sum or weighted mean.
        const series = perUnit ? normalizedCopy(built.values, {}, rangeScratch) : built.values;
        const n = applyMask(series, table.mask, gatheredScratch);
        const s = stats(gatheredScratch, n);
        const q = quantiles(gatheredScratch, n);

        groupedRefs.push(
          withRowId({
            kind: 'area',
            caseId: table.caseId,
            slotKey: table.slotKey,
            entity: groupName,
            label: groupRowLabel(groupName, narrowed ? scopedMembers.length : undefined, AREA_NOUN),
            variable,
            unit,
            axisIndex: -1,
            groupBy: 'Group',
            groupValue: groupName,
            ...(narrowed ? { members: scopedMembers } : {}),
            ...rangeTag,
          }),
        );
        groupCounts.push(scopedMembers.length);
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
      id: input.isGroupTab ? 'area-groups' : 'area',
      label: input.isGroupTab ? 'Area Groups' : 'Area',
      rows: groupedRefs,
      columns,
      notes: [
        input.isGroupTab
          ? 'Ticking a group row draws the aggregate series across its member areas.'
          : 'Grouped by Grouping. Ticking a row draws the aggregate series.',
        ...notes,
      ],
      actions,
    };
  }

  // ------------------------------------------------------------ individual areas
  const refs: BrowseRowRef[] = [];
  const rowCounts: number[] = [];

  for (const table of tables) {
    const before = refs.length;
    for (let i = 0; i < table.data.areas.length; i++) {
      const name = table.data.areas[i];
      if (areas !== null && !areas.has(name)) continue;
      refs.push(
        withRowId({
          kind: 'area',
          caseId: table.caseId,
          slotKey: table.slotKey,
          entity: name,
          variable,
          unit,
          axisIndex: i,
          ...rangeTag,
        }),
      );
    }
    rowCounts.push(refs.length - before);
  }

  // The stat pass. The cube is entity x METRIC x hours, so the metric index is
  // folded into the plane start, and presence is flattened to this metric.
  const ranked = rankScopedRows({
    tables,
    rowCounts,
    axisIndexOf: (row) => refs[row].axisIndex,
    planesOf: (data) => {
      const metricIndex = data.metrics.indexOf(variable);
      const numMetrics = data.metrics.length;
      const presence = new Uint8Array(data.areas.length);
      if (metricIndex >= 0) {
        for (let a = 0; a < data.areas.length; a++) {
          presence[a] = data.presence[a * numMetrics + metricIndex];
        }
      }
      return {
        presence,
        planeStart: (axisIndex) => (axisIndex * numMetrics + metricIndex) * HOURS_PER_YEAR,
      };
    },
    scratch: input.scratch ?? createScratch(),
    memo: input.memo,
    ...(perUnit ? { rangeOf: () => ({}) } : {}),
  });

  // ---------------------------------------------------------- the columns
  const columns: BrowseColumn[] = [
    {
      key: CASE_COLUMN_KEY,
      category: true,
      label: 'Case',
      kind: 'text',
      computed: false,
      value: (row) => caseLabelOf(refs[row].caseId),
    },
    {
      key: 'entity',
      label: 'Area',
      kind: 'text',
      computed: false,
      groupable: canGroup,
      groupDisabledReason: groupRefusal,
      value: (row) => refs[row].entity,
    },
  ];

  columns.push(...statColumns(ranked, statClass));

  return { id: 'area', label: 'Area', rows: refs, columns, notes };
}

/** Area's tabs: the axis, and the axis grouped. Declared here so the drawer's
 * cache key (derived in `src/app/browse-tabs.ts`) always covers them. The
 * drawer applies the area scope itself, hence `areas: null`. */
export function declareAreaTabs(
  entity: AreaTabScope,
  groups: AreaTabScope,
  scratch: Float32Array | undefined,
  memo?: RankMemo,
) {
  return [
    {
      id: 'area',
      label: 'Area',
      scope: entity,
      offersRange: true,
      build: (groupBy?: string | null, perUnit?: boolean, keep?: ReadonlySet<string>) =>
        buildAreaTab({
          tables: entity.tables,
          variable: entity.variable,
          areas: null,
          scratch,
          memo,
          groupBy,
          keep,
          perUnit,
          withheld: groups.withheld,
        }),
    },
    {
      id: 'area-groups',
      label: 'Area Groups',
      scope: groups,
      offersRange: true,
      build: (_groupBy?: string | null, perUnit?: boolean) =>
        buildAreaTab({
          tables: groups.tables,
          variable: groups.variable,
          areas: null,
          scratch,
          memo,
          groupBy: 'Group',
          isGroupTab: true,
          withheld: groups.withheld,
          perUnit,
        }),
    },
  ];
}

/** What a declared Area tab reads; structural, so the kind imports no
 * scoping. */
export interface AreaTabScope {
  readonly tables: readonly AreaBrowseTable[];
  readonly variable: string;
  readonly variables: readonly string[];
  readonly withheld: readonly string[];
  readonly signature: string;
}
