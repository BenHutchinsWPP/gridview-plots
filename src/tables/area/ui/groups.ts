// src/tables/area/ui/groups.ts
//
// What the shared membership editor needs to know to edit AREA groupings.
//
// The editor itself is `src/ui/membership-editor.ts` -- it is chrome over a
// name -> group map rather than anything of this kind's, the same argument
// that put the map in `src/lookups/groupings.ts`. What is here is only what
// Area decides.
//
// The editor cannot add or remove AREAS. The axis comes from the loaded data
// (see `../groupings.ts`), not from anything editable here. A mapping that
// names areas the data does not have still loads, and those names show up
// flagged rather than silently truncated -- a Groupings.csv written for a
// bigger study is worth keeping.
//
// A CSV chosen inside the editor CLOSES it and hands the text up unparsed:
// the caller already owns the one path that applies a Groupings.csv, and a
// second parse here would be a second set of refusals to keep in step.

import {
  allAreas,
  areasIn,
  groupingNames,
  isOffAxis,
  ALL_AREAS,
  EDITOR_CSV_HEADERS,
} from '../groupings';
import { showMembershipEditor, type EditorApplied } from '../../../ui/membership-editor';

export interface GroupEditorInput {
  /** Areas that carry data in the loaded cases. Empty before any case is
   * loaded, which switches the "no data" flag off rather than flagging
   * everything. */
  present: Set<string>;
}

/** Resolve to a Groupings.csv and the file it came from, or to null if the
 * user cancels. */
export function showGroupEditor(input: GroupEditorInput): Promise<EditorApplied<string> | null> {
  // Sorted for reading. The cube's axis order lives in groupings.ts and is
  // not what this list is for.
  const axis = [...allAreas()].sort((a, b) => a.localeCompare(b));

  const initial = new Map<string, readonly string[]>();
  for (const name of groupingNames()) {
    // ALL_AREAS is computed from the axis, so it is not a group to edit.
    if (name !== ALL_AREAS) initial.set(name, areasIn(name).slice());
  }

  return showMembershipEditor<string>({
    title: 'Edit groupings',
    subtitle:
      `${axis.length} areas, read from the loaded data. An area can belong to any number of ` +
      `groups — drag it across, or double-click it. "${ALL_AREAS}" is computed from the axis ` +
      'and is not edited here.',
    noun: { one: 'area', many: 'areas' },
    candidatesHead: 'Areas in this data',
    candidateDragType: 'x-from/area',
    axis,
    initial,
    reserved: new Set([ALL_AREAS]),
    confirmLabel: 'Apply groupings',
    downloadName: 'Groupings.csv',
    csvHeader: () => EDITOR_CSV_HEADERS[0].join(','),
    /** Why an area cannot be plotted, or null when it can. Two different
     * problems that both read as "this name is in the group and nothing comes
     * out of it", so they are told apart in the flag itself. */
    problem(area) {
      if (isOffAxis(area)) return 'not in the loaded data';
      if (input.present.size > 0 && !input.present.has(area)) return 'no data in the loaded cases';
      return null;
    },
    onLoadCsv(text, api) {
      api.close(text);
    },
    result: (model) => model.toCsv(EDITOR_CSV_HEADERS[0].join(',')),
  });
}
