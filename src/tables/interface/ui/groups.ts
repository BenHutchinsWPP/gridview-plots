// src/tables/interface/ui/groups.ts
//
// What the shared membership editor needs to edit INTERFACE groups (pattern:
// src/tables/generator/ui/groups.ts). `memberMark` is the DIRECTION, held per
// (group, member) so one path may count forward in one boundary and reversed
// in another (why: src/tables/interface/groups.ts). No `detail` and no
// `candidateSubsets`: an interface name is its own identity and has no
// attributes to narrow by.

import { readCsvHeader, showGroupingsMapping } from '../../../ui/groupings-mapping';
import {
  showMembershipEditor,
  type CandidateSubset,
  type EditorApplied,
} from '../../../ui/membership-editor';
import type { MarkKey } from '../../../ui/membership-model';
import {
  EDITOR_CSV_HEADERS,
  interfaceGroupNames,
  membersOfGroup,
  planInterfaceGroups,
  type InterfaceMember,
} from '../groups';

export interface InterfaceGroupEditorInput {
  /** Interface names that carry data in at least one loaded case, for the
   * "offered but no data" flag. Empty before any case is loaded, which
   * switches that flag off rather than flagging everything. */
  present: ReadonlySet<string>;
  /** Every interface name the editor may offer on the right: every name on
   * any loaded table's axis. There is no list file to widen it with. */
  universe: readonly string[];
  /** The Interface tab's kept set; see Generator's for why `open` is separate. */
  fromBrowse?: { names: ReadonlySet<string>; open: boolean };
}

/** The editor's answer on Apply: the full membership, each member with the
 * direction it counts in. */
export interface InterfaceGroupEdit {
  members: ReadonlyMap<string, readonly InterfaceMember[]>;
}

/** The edited membership with its directions and source, or null on cancel. */
export function showInterfaceGroupEditor(
  input: InterfaceGroupEditorInput,
): Promise<EditorApplied<InterfaceGroupEdit> | null> {
  const axis = [...new Set(input.universe)].sort((a, b) => a.localeCompare(b));
  const offerable = new Set(axis);

  const initial = new Map<string, readonly string[]>();
  const marks: MarkKey[] = [];
  for (const group of interfaceGroupNames()) {
    const members = membersOfGroup(group);
    initial.set(
      group,
      members.map((member) => member.name),
    );
    for (const member of members) {
      if (member.direction === 'reversed') marks.push([group, member.name]);
    }
  }

  const present = input.present;
  const subsets: CandidateSubset[] =
    present.size === 0
      ? []
      : [
          { label: 'With data in the loaded cases', keep: (name) => present.has(name) },
          { label: 'No data in the loaded cases', keep: (name) => !present.has(name) },
        ];

  const fromBrowse = input.fromBrowse;
  if (fromBrowse !== undefined) {
    const names = fromBrowse.names;
    subsets.unshift({
      label: `From the Interface tab (${names.size} interface(s))`,
      keep: (name) => names.has(name),
      open: fromBrowse.open,
    });
  }

  return showMembershipEditor<InterfaceGroupEdit>({
    title: 'Edit interface groups',
    subtitle:
      fromBrowse?.open === true
        ? `${fromBrowse.names.size} interface(s) from the Interface tab are on the right. ` +
          `Choose or create a group, then “Add all shown”. Set each member's direction on its ` +
          `own row. Nothing moves until you apply.`
        : `${axis.length} interface(s) to offer. An interface can belong to any number of ` +
          `groups — drag it across, or double-click it. Each member counts forward or ` +
          `reversed: reverse a path that is measured the opposite way round from the boundary ` +
          `you are building, or its flow will cancel the rest instead of adding to it.`,
    noun: { one: 'interface', many: 'interfaces' },
    candidatesHead: 'Interfaces in this study',
    candidateDragType: 'x-from/interface',
    axis,
    initial,
    confirmLabel: 'Apply groups',
    downloadName: 'InterfaceGroups.csv',
    csvHeader: () => EDITOR_CSV_HEADERS[0].join(','),
    requireGroups: true,
    memberMark: {
      label: (marked) => (marked ? 'reversed' : 'forward'),
      title: (marked) =>
        marked
          ? 'Counted × −1: this path is measured the opposite way round from the group. ' +
            'Click to count it as exported.'
          : 'Counted as exported. Click to reverse it, for a path measured the opposite way ' +
            'round from the rest of this group.',
      csv: (marked) => (marked ? 'reversed' : 'forward'),
      initial: marks,
    },
    /** Why a member cannot be plotted, or null when it can. Two problems, and
     * the order matters: a name no loaded export carries is a different fix
     * from one monitored in a run that carried no data for it. */
    problem(name) {
      if (!offerable.has(name)) return 'not in the loaded data';
      if (present.size > 0 && !present.has(name)) return 'no data in the loaded cases';
      return null;
    },
    candidateSubsets: subsets,
    extraReadout: () => '',
    /** As Generator's; directions are replaced with the membership, so a file
     * never lands wearing the previous membership's. */
    async onLoadCsv(text, api, file) {
      const mapping = await showGroupingsMapping({
        fileName: file.name,
        header: readCsvHeader(text),
        hasGeneratorList: false,
        entity: 'interface',
      });
      if (mapping === null || mapping.entity !== 'interface') return;
      try {
        const plan = planInterfaceGroups(text, mapping.mapping);
        const loaded = new Map<string, readonly string[]>();
        const loadedMarks: MarkKey[] = [];
        for (const [group, members] of plan.members) {
          loaded.set(
            group,
            members.map((member) => member.name),
          );
          for (const member of members) {
            if (member.direction === 'reversed') loadedMarks.push([group, member.name]);
          }
        }
        api.replace(loaded, loadedMarks);
      } catch (error) {
        api.complain(error instanceof Error ? error.message : String(error));
      }
      api.repaint();
    },
    result: (model) => {
      // Back to members-with-directions at the boundary: the editor's marks
      // are a display form, and the map's member type is what every reader of
      // it depends on.
      const members = new Map<string, InterfaceMember[]>();
      for (const [group, names] of model.snapshot()) {
        members.set(
          group,
          names.map((name) => ({
            name,
            direction: model.isMarked(group, name) ? ('reversed' as const) : ('forward' as const),
          })),
        );
      }
      return { members };
    },
  });
}
