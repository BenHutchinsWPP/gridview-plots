// src/tables/interface/ui/browse.ts
//
// The Interface tab of the browse drawer (pattern:
// src/tables/generator/ui/browse.ts). Its rows are the interface axis; there
// is no lookup list and no area, so an area scope cannot apply and the tab
// says so. No capacity factor (no nameplate) and, by DECISION, no attribute
// group-by: an arbitrary bucket of paths is not a boundary (double-counting,
// cancelling directions). Only authored groups combine, on the Interface
// Groups tab.
//
// "% of range" divides each path by its monthly limit, which `main.ts` hands
// in as hourly numbers (`limitsOf`): this kind never reads the limits store.
// A boundary divides by its members' limits summed in its directions
// (`../limits.ts`).

import { HOURS_PER_YEAR } from '../../../model/calendar';
import { applyMask, createScratch, quantiles, stats, type RankMemo } from '../../../kernels';
import { reduceSignedMembers } from '../../../lookups/reduce';
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
import { INTERFACE_GROUP_BY, interfaceGroupNames, membersOfGroup, signOf } from '../groups';
import { isDirectional, isRated, spatialOf, spatialRefusal, unitOf } from '../rules';
import type { InterfaceTable } from '../types';
import { normalizedCopy, type RangeLimits } from '../../../series/range';
import { summedLimits } from '../limits';

const PATH_NOUN = { one: 'path', many: 'paths' };

/** One interface table in scope, as the drawer's caller already has it. */
export interface InterfaceBrowseTable {
  caseId: string;
  caseName: string;
  caseLabel: string;
  slotKey: string;
  data: InterfaceTable;
  /** The hours the Hours block keeps, for THIS table. */
  mask: Uint8Array;
}

export interface InterfaceBrowseInput {
  /** The (case, slot) tables the CASE scope kept, all of one quantity. */
  tables: readonly InterfaceBrowseTable[];
  /** Areas the scope keeps, or null for all of them. */
  areas: ReadonlySet<string> | null;
  /** Reused across rows. */
  scratch?: Float32Array;
  memo?: RankMemo;
  /** The interface-groups tab: rows are authored boundaries from the session
   * map (`src/tables/interface/groups.ts`). */
  isGroupTab?: boolean;
  /** See `keptRowKeys` in src/ui/browse-model.ts. */
  keep?: ReadonlySet<string>;
  /** "% of range": stats of each path over its limit, else its peak. */
  perUnit?: boolean;
  /** One path's hourly limits in one Case; absent means none anywhere. */
  limitsOf?: (caseId: string, interfaceName: string, year: number) => RangeLimits;
}

export function buildInterfaceTab(input: InterfaceBrowseInput): BrowseTab {
  const { tables, areas } = input;
  const caseLabelOf = caseLabelsOf(tables);
  const notes: string[] = [];

  if (areas !== null) {
    notes.push('Interfaces do not belong to an Area, so the area scope is not applied.');
  }

  if (input.isGroupTab) return groupTabRows(input, notes);

  const refs: BrowseRowRef[] = [];
  const rowCounts: number[] = [];
  const perUnit = Boolean(input.perUnit);
  /** Parallel to `refs`: the table each row came from, for its limits. */
  const tableOf: InterfaceBrowseTable[] = [];

  for (const table of tables) {
    const before = refs.length;
    const quantity = table.data.quantity;
    const unit = table.data.unit;

    for (let i = 0; i < table.data.interfaces.length; i++) {
      const name = table.data.interfaces[i];
      refs.push(
        withRowId({
          kind: 'interface',
          caseId: table.caseId,
          slotKey: table.slotKey,
          entity: name,
          variable: quantity,
          unit: perUnit ? '%' : unit,
          axisIndex: i,
          ...(perUnit ? { perUnit: true } : {}),
        }),
      );
      tableOf.push(table);
    }
    rowCounts.push(refs.length - before);
  }

  // The stat pass: one entity is one plane.
  const ranked = rankScopedRows({
    tables,
    rowCounts,
    axisIndexOf: (row) => refs[row].axisIndex,
    planesOf: (data) => ({
      presence: data.presence,
      planeStart: (axisIndex) => axisIndex * HOURS_PER_YEAR,
    }),
    scratch: input.scratch ?? createScratch(),
    memo: input.memo,
    ...(perUnit ? { rangeOf: rangeOfRow } : {}),
  });

  /** A path's limits, for MW/MWh only: a limit is a flow rating. */
  function rangeOfRow(row: number): RangeLimits {
    const { data, caseId } = tableOf[row];
    if (!input.limitsOf || !isRated(data.unit)) return {};
    return input.limitsOf(caseId, String(refs[row].entity), data.year);
  }

  // ---------------------------------------------------------- the columns
  const columns: BrowseColumn[] = [
    {
      key: CASE_COLUMN_KEY,
      label: 'Case',
      kind: 'text',
      computed: false,
      value: (row) => caseLabelOf(refs[row].caseId),
    },
    {
      key: 'entity',
      label: 'Interface',
      kind: 'text',
      computed: false,
      groupable: false,
      groupDisabledReason:
        'An arbitrary set of interfaces is not a boundary: paths across one corridor ' +
        'double-count and paths measured in opposite directions cancel. Build a group on the ' +
        'Interface Groups tab, where each member states its direction.',
      value: (row) => refs[row].entity,
    },
  ];

  columns.push(...statColumns(ranked, perUnit ? 'ratio' : 'quantity'));

  // The group-editor hand-off, as on Generator's tab.
  return {
    id: 'interface',
    label: 'Interface',
    rows: refs,
    columns,
    notes,
    actions: [{ id: 'add-shown-to-group', label: 'Add shown to a group…' }],
  };
}

// ------------------------------------------------------ user-authored groups
//
// A row is one BOUNDARY: the signed sum of its member paths at ±1
// (`reduceSignedMembers`).
function groupTabRows(input: InterfaceBrowseInput, notes: string[]): BrowseTab {
  const { tables, keep } = input;
  const caseLabelOf = caseLabelsOf(tables);
  const actions = [{ id: 'edit-groups', label: 'Edit Groups…' }];
  const groupsTabId = 'interface-groups';
  const groupsTabLabel = 'Interface Groups';

  const quantity = tables[0]?.data.quantity ?? '';
  const unit = tables[0]?.data.unit ?? unitOf(quantity);

  const groupedRefs: BrowseRowRef[] = [];
  const groupCounts: number[] = [];
  const reversedCounts: number[] = [];
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
      key: 'group.interfaces',
      label: 'Paths',
      kind: 'number',
      computed: true,
      cellClass: 'count',
      value: (row) => groupCounts[row] ?? null,
    },
    {
      // Its own column: how many paths count backwards flips the sign of what
      // the row shows, and the label cannot carry it.
      key: 'group.reversed',
      label: 'Reversed',
      kind: 'number',
      computed: true,
      cellClass: 'count',
      value: (row) => reversedCounts[row] ?? null,
    },
  ];

  if (spatialOf(unit) === 'REFUSE') {
    return {
      id: groupsTabId,
      label: groupsTabLabel,
      rows: [],
      columns,
      notes: [
        spatialRefusal(quantity, unit) ?? `"${quantity}" cannot be combined across interfaces.`,
      ],
      actions,
    };
  }

  const groups = interfaceGroupNames();
  if (groups.length === 0) {
    return {
      id: groupsTabId,
      label: groupsTabLabel,
      rows: [],
      columns,
      notes: [
        'No interface groups are loaded yet — Edit Groups… builds them, or loads a ' +
          'membership CSV.',
      ],
      actions,
    };
  }

  const seriesScratch = input.scratch ?? createScratch();
  const gatheredScratch = createScratch();
  const rangeScratch = createScratch();
  const narrowed = keep !== undefined;
  const perUnit = Boolean(input.perUnit);
  const limited = perUnit && isRated(unit);
  let reversedOnNonFlow = 0;

  for (const table of tables) {
    const axisIndex = new Map(table.data.interfaces.map((name, index) => [name, index] as const));
    for (const groupName of groups) {
      // Keep-set and presence gate members, as in the other kinds.
      const scopedMembers = membersOfGroup(groupName).filter((member) => {
        const index = axisIndex.get(member.name);
        if (index === undefined || table.data.presence[index] === 0) return false;
        if (
          keep !== undefined &&
          !keep.has(browseJoinKey(table.caseId, table.slotKey, member.name))
        ) {
          return false;
        }
        return true;
      });
      if (scopedMembers.length === 0) continue;

      const coefficients = new Map<string | number, number>(
        scopedMembers.map((member) => [member.name, signOf(member.direction)] as const),
      );
      const contributing = reduceSignedMembers(
        table.data.cube,
        table.data.presence,
        table.data.interfaces,
        coefficients,
        seriesScratch,
      );
      if (contributing === 0) continue;

      const reversed = scopedMembers.filter((member) => member.direction === 'reversed').length;
      if (reversed > 0 && !isDirectional(unit)) reversedOnNonFlow++;

      let series = seriesScratch;
      if (perUnit) {
        // Every scoped member is present, so each one entered the sum.
        const { limitsOf } = input;
        const limits =
          limited && limitsOf
            ? summedLimits(
                scopedMembers.map((member) => ({
                  sign: signOf(member.direction),
                  limits: limitsOf(table.caseId, member.name, table.data.year),
                })),
              )
            : {};
        series = normalizedCopy(seriesScratch, limits, rangeScratch);
      }
      const n = applyMask(series, table.mask, gatheredScratch);
      const s = stats(gatheredScratch, n);
      const q = quantiles(gatheredScratch, n);

      groupedRefs.push(
        withRowId({
          kind: 'interface',
          caseId: table.caseId,
          slotKey: table.slotKey,
          entity: groupName,
          // No direction count in the label: a pin freezes the label but the
          // line re-reads directions from the map (`../series.ts`).
          label: groupRowLabel(groupName, narrowed ? contributing : undefined, PATH_NOUN),
          variable: quantity,
          unit: perUnit ? '%' : unit,
          axisIndex: -1,
          groupBy: INTERFACE_GROUP_BY,
          groupValue: groupName,
          ...(narrowed ? { members: scopedMembers.map((member) => member.name) } : {}),
          ...(perUnit ? { perUnit: true } : {}),
        }),
      );
      groupCounts.push(contributing);
      reversedCounts.push(reversed);
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

  const groupNotes = [
    'Ticking a group row draws its boundary: the member paths summed, each counted forward ' +
      'or reversed as the group says. A path can sit in several groups, so these rows do not ' +
      'add up to anything.',
  ];
  if (limited) {
    groupNotes.push(
      "% of range divides a boundary by its paths' limits summed in the group's directions, " +
        "else by its peak in an hour any path has none. The sum is a best case: a boundary's " +
        "own rating can be below its paths' summed ratings.",
    );
  }
  // Reversing a member of a non-flow quantity subtracts it; say so.
  if (reversedOnNonFlow > 0) {
    groupNotes.push(
      `"${quantity}" is not a directional quantity (${unit}), but ${reversedOnNonFlow} row(s) ` +
        'have reversed members, which SUBTRACT here. Directions belong to the group, so they ' +
        'are applied as written rather than silently ignored.',
    );
  }

  return {
    id: groupsTabId,
    label: groupsTabLabel,
    rows: groupedRefs,
    columns: [
      ...columns,
      ...statColumnsFrom((row) => groupStatsList[row], perUnit ? 'ratio' : 'quantity'),
    ],
    notes: [...groupNotes, ...notes],
    actions,
  };
}

/** What a declared Interface tab reads; structural, so the kind imports no
 *  scoping. */
export interface InterfaceTabScope {
  readonly tables: readonly InterfaceBrowseTable[];
  readonly variable: string;
  readonly variables: readonly string[];
  readonly signature: string;
}

/** Interface's tabs: the paths, and the boundaries built from them. No
 * reference list: an interface name is its own identity. */
export function declareInterfaceTabs(
  entity: InterfaceTabScope,
  groups: InterfaceTabScope,
  scratch: Float32Array | undefined,
  memo: RankMemo | undefined,
  limitsOf: InterfaceBrowseInput['limitsOf'],
) {
  return [
    {
      id: 'interface',
      label: 'Interface',
      scope: entity,
      offersRange: true,
      build: (_groupBy?: string | null, perUnit?: boolean) =>
        buildInterfaceTab({
          tables: entity.tables,
          areas: null,
          scratch,
          memo,
          perUnit,
          limitsOf,
        }),
    },
    {
      id: 'interface-groups',
      label: 'Interface Groups',
      scope: groups,
      offersRange: true,
      build: (_groupBy?: string | null, perUnit?: boolean) =>
        buildInterfaceTab({
          tables: groups.tables,
          areas: null,
          scratch,
          memo,
          isGroupTab: true,
          perUnit,
          limitsOf,
        }),
    },
  ];
}
