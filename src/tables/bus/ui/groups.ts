// src/tables/bus/ui/groups.ts
//
// What the shared membership editor needs to edit BUS groups (pattern:
// src/tables/generator/ui/groups.ts). Two differences, both because names
// repeat: the editor's axis is the bus NUMBER as text, with the name in
// `detail`; and the rows that ride along untouched are NAME rows that
// resolved to no single id.

import { readCsvHeader, showGroupingsMapping } from '../../../ui/groupings-mapping';
import {
  showMembershipEditor,
  type CandidateSubset,
  type EditorApplied,
} from '../../../ui/membership-editor';
import { cellValue } from '../../../lookups/merge';
import { lookupFor } from '../../../lookups/store';
import { BUS_LIST } from '../../../lookups/schema';
import type { LookupTable } from '../../../lookups/types';
import {
  EDITOR_CSV_HEADERS,
  busGroupNames,
  busesInGroup,
  indexForBusMapping,
  planBusGroups,
  unresolvedBusMembershipRows,
  type UnresolvedNameRow,
} from '../groups';

export interface BusGroupEditorInput {
  /** Bus ids that carry data in at least one loaded case, for the "listed but
   * no data" flag. Empty before any case is loaded, which switches that flag
   * off rather than flagging everything. */
  present: ReadonlySet<number>;
  /** Every bus id the editor may offer on the right: the loaded BusList's ids
   * plus every id on any loaded table's axis. */
  universe: readonly number[];
  /** The loaded BusList's own ids, or undefined when none is loaded -- the
   * difference between "not in BusList" and "unchecked". */
  listed: ReadonlySet<number> | undefined;
  /** The buses the Bus tab's filters keep; narrows the candidate column only. */
  fromBrowse?: { buses: ReadonlySet<number>; open: boolean };
}

/** The editor's answer on Apply: the full membership as ids, plus the
 * kept-unresolved name rows that ride along because no loaded list resolves
 * them to one bus. */
export interface BusGroupEdit {
  members: ReadonlyMap<string, readonly number[]>;
  unresolved: readonly UnresolvedNameRow[];
}

/** Bus id (text) -> name for every id the BusList claims, built once per
 * editor (the list is tens of thousands of rows). */
function namesFrom(list: LookupTable | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (list === undefined) return out;
  const nameIndex = list.byName.get('Name');
  if (nameIndex === undefined) return out;
  const nameColumn = list.columns[nameIndex];
  for (const [key, row] of list.index) {
    const name = cellValue(nameColumn, row);
    if (typeof name === 'string' && name.trim() !== '') out.set(String(key), name.trim());
  }
  return out;
}

/** Resolve to the edited membership and its source, or to null on cancel. */
export function showBusGroupEditor(
  input: BusGroupEditorInput,
): Promise<EditorApplied<BusGroupEdit> | null> {
  // Sorted NUMERICALLY, then written as text: the axis is a column of bus
  // numbers, and sorting it as text would file 10002 between 1000 and 1001.
  const ids = [...new Set(input.universe)].sort((a, b) => a - b);
  const axis = ids.map(String);
  const offerable = new Set(axis);

  const initial = new Map<string, readonly string[]>();
  for (const group of busGroupNames()) {
    initial.set(
      group,
      busesInGroup(group).map((id) => String(id)),
    );
  }

  // Rows no loaded list resolves. They are not membership and cannot be
  // edited, so they sit beside the model rather than in it, and Apply returns
  // them untouched.
  let kept: UnresolvedNameRow[] = unresolvedBusMembershipRows().map((row) => ({ ...row }));

  const names = namesFrom(lookupFor('buslist'));
  const listed = input.listed;
  const present = input.present;

  const subsets: CandidateSubset[] =
    present.size === 0
      ? []
      : [
          { label: 'With data in the loaded cases', keep: (id) => present.has(Number(id)) },
          { label: 'No data in the loaded cases', keep: (id) => !present.has(Number(id)) },
        ];

  const fromBrowse = input.fromBrowse;
  if (fromBrowse !== undefined) {
    const buses = fromBrowse.buses;
    subsets.unshift({
      label: `From the Bus tab (${buses.size} bus(es))`,
      keep: (id) => buses.has(Number(id)),
      open: fromBrowse.open,
    });
  }

  return showMembershipEditor<BusGroupEdit>({
    title: 'Edit bus groups',
    subtitle:
      fromBrowse?.open === true
        ? `${fromBrowse.buses.size} bus(es) from the Bus tab are on the right. Choose or ` +
          `create a group, then “Add all shown” — or switch the dropdown back to every bus. ` +
          `Nothing moves until you apply.`
        : `${axis.length} bus number(s) to offer. A bus can belong to any number of groups — ` +
          `drag it across, or double-click it. Buses are stored by ${BUS_LIST.keyColumn} ` +
          `because a bus name may repeat; the filter box also matches the name.`,
    noun: { one: 'bus', many: 'buses' },
    candidatesHead: 'Buses in this study',
    candidateDragType: 'x-from/bus',
    axis,
    initial,
    confirmLabel: 'Apply groups',
    downloadName: 'BusGroups.csv',
    csvHeader: () => EDITOR_CSV_HEADERS[0].join(','),
    requireGroups: true,
    /** Why a member cannot be plotted, or null when it can. Checked in this
     * order: an id no list carries is a different fix from one no case
     * exported. */
    problem(id) {
      const busId = Number(id);
      if (listed !== undefined && !listed.has(busId)) return `not in ${BUS_LIST.banner}`;
      if (!offerable.has(id)) return 'not in the loaded data';
      if (present.size > 0 && !present.has(busId)) return 'no data in the loaded cases';
      return null;
    },
    detail: (id) => names.get(id) ?? '',
    candidateSubsets: subsets,
    extraReadout: () =>
      kept.length > 0
        ? ` · ${kept.length} row(s) name a bus no ${BUS_LIST.banner} resolves to one id; ` +
          'they ride along'
        : '',
    /** As Generator's: the pane asks, the plan resolves, the in-progress
     * membership is REPLACED, and a refusal changes nothing here. */
    async onLoadCsv(text, api, file) {
      const list = lookupFor('buslist');
      const mapping = await showGroupingsMapping({
        fileName: file.name,
        header: readCsvHeader(text),
        hasGeneratorList: lookupFor('generatorlist') !== undefined,
        hasBusList: list !== undefined,
        entity: 'bus',
      });
      if (mapping === null || mapping.entity !== 'bus') return;
      try {
        const plan = planBusGroups(text, mapping.mapping, indexForBusMapping(list));
        api.replace(
          new Map([...plan.members].map(([group, members]) => [group, members.map(String)])),
        );
        kept = plan.kept.map((row) => ({ ...row }));
      } catch (error) {
        api.complain(error instanceof Error ? error.message : String(error));
      }
      api.repaint();
    },
    result: (model) => ({
      // Back to numbers at the boundary: the editor's strings are a display
      // form, and the map's key type is what every reader of it depends on.
      members: new Map(
        [...model.snapshot()].map(([group, members]) => [group, members.map(Number)]),
      ),
      unresolved: kept,
    }),
  });
}
