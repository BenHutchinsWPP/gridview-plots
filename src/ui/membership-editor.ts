// src/ui/membership-editor.ts
//
// The three-column membership modal: groups, the selected group's members,
// and candidates, dragged across. Not per kind: it is chrome over a
// name -> group map, like the browse drawer, so its rules cannot drift
// between kinds. A kind supplies nouns, axis, `problem`, `detail`,
// `candidateSubsets`, what a CSV load does, and what Apply returns; nothing
// here names a kind. The rules live in the DOM-free `membership-model.ts`.

import { LoadTracker, MembershipModel, type LoadSource, type MarkKey } from './membership-model';
import { saveBlob } from './download';

/** One candidate-subset dropdown entry. The editor adds "all" itself. */
export interface CandidateSubset {
  label: string;
  keep(name: string): boolean;
  /** The subset the column OPENS on (at most one), when the editor was opened
   * from a narrowed set. */
  open?: boolean;
}

/**
 * A per-member setting shown as a button on each member row: an interface
 * member counts forward or reversed. What the states MEAN is the kind's; the
 * state lives in `MembershipModel`.
 */
export interface MemberMark {
  /** The button text per state; the unmarked default must read as a setting. */
  label(marked: boolean): string;
  /** The tooltip per state. */
  title(marked: boolean): string;
  /** What the saved CSV's third column carries for each state. */
  csv(marked: boolean): string;
  /** The pairs the editor opens with marked. */
  initial: readonly MarkKey[];
}

/** The file a membership came from, when Apply took one loaded in the
 * editor: what the Contents strip names. */
export type EditorSource = LoadSource<File>;

/** What Apply resolves to: the kind's own answer and where it came from. */
export interface EditorApplied<T> {
  value: T;
  /** The last file loaded in the editor that became the membership, or null
   * when none was. */
  source: EditorSource | null;
  /** The membership differs from the one the editor opened with. */
  changed: boolean;
}

/** What a kind's `onLoadCsv` may do to an open editor. */
export interface MembershipEditorApi<T> {
  close(result: T | null): void;
  /** Replace the in-progress membership and its marks, as a load does. */
  replace(members: ReadonlyMap<string, readonly string[]>, marks?: readonly MarkKey[]): void;
  /** A message shown in the readout until the next thing happens. */
  complain(message: string): void;
  repaint(): void;
}

export interface MembershipEditorSpec<T> {
  title: string;
  subtitle: string;
  /** Singular and plural, for every sentence the editor writes. */
  noun: { one: string; many: string };
  /** Heading over the right-hand column. */
  candidatesHead: string;
  /** The drag type of a row dragged FROM the candidate column, so a member
   * dragged out is never read as a candidate dragged in. */
  candidateDragType: string;
  /** Every name the right-hand column may offer, sorted for reading. */
  axis: readonly string[];
  initial: ReadonlyMap<string, readonly string[]>;
  /** Group names the editor must refuse to create. */
  reserved?: ReadonlySet<string>;
  confirmLabel: string;
  downloadName: string;
  /** The saved file's header, asked at SAVE time: it may depend on what is
   * loaded now. */
  csvHeader(): string;
  /** One pair's cells when the file has more than two columns; the WHOLE row,
   * since column order is the file's meaning. Default `[name, group]`, plus
   * the mark as a third column for a kind with `memberMark`. */
  csvCells?(name: string, group: string, marked: boolean): readonly string[];
  /** Rows the file must keep that are not editable membership (unresolved
   * generator pairs), so a save never shrinks the fleet. */
  csvExtraRows?(): readonly (readonly string[])[];
  /** Why a member cannot be plotted, or null when it can. */
  problem(name: string): string | null;
  /** Identifiers a name does not carry (a generator's bus number and unit
   * ID), shown on every row and searched by the filter box. */
  detail?(name: string): string;
  /** Candidate-column subsets for a dropdown (e.g. has data / has none). The
   * subset narrows "Add all shown" too, so a fleet's loaded half is one gesture. */
  candidateSubsets?: readonly CandidateSubset[];
  /** Appended to the readout, for whatever else a kind has to say. */
  extraReadout?(): string;
  /** A per-member setting shown as a button on each member row. */
  memberMark?: MemberMark;
  /** When set, Apply is disabled while there are no groups at all. */
  requireGroups?: boolean;
  /** `file` is the chosen file, for its name in a prompt; the editor itself
   * tracks whether its content became the membership. */
  onLoadCsv(text: string, api: MembershipEditorApi<T>, file: File): void | Promise<void>;
  result(model: MembershipModel): T;
}

/** Resolve to the kind's own answer with its source, or to null if the user
 * cancels. */
export function showMembershipEditor<T>(
  spec: MembershipEditorSpec<T>,
): Promise<EditorApplied<T> | null> {
  return new Promise((resolve) => {
    const model = new MembershipModel(spec.initial, spec.reserved, spec.memberMark?.initial ?? []);
    let complaint = '';
    const loads = new LoadTracker<File>(model);

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'modal modal-wide';
    backdrop.appendChild(modal);

    const title = document.createElement('h2');
    title.textContent = spec.title;
    modal.appendChild(title);

    const subtitle = document.createElement('p');
    subtitle.className = 'modal-subtitle';
    subtitle.textContent = spec.subtitle;
    modal.appendChild(subtitle);

    const columns = document.createElement('div');
    columns.className = 'groups-grid';
    modal.appendChild(columns);

    // ---------------------------------------------------------- groups column
    const groupsColumn = document.createElement('div');
    groupsColumn.className = 'groups-column';
    const groupsHead = document.createElement('div');
    groupsHead.className = 'groups-head';
    groupsHead.textContent = 'Groups';
    groupsColumn.appendChild(groupsHead);
    const groupsList = document.createElement('div');
    groupsList.className = 'groups-list';
    groupsColumn.appendChild(groupsList);

    const newGroupRow = document.createElement('div');
    newGroupRow.className = 'groups-newrow';
    const newGroup = document.createElement('input');
    newGroup.type = 'text';
    newGroup.placeholder = 'New group…';
    newGroup.className = 'modal-filter';
    const addGroup = document.createElement('button');
    addGroup.type = 'button';
    addGroup.className = 'btn';
    addGroup.textContent = 'Add';
    newGroupRow.append(newGroup, addGroup);
    groupsColumn.appendChild(newGroupRow);
    columns.appendChild(groupsColumn);

    // --------------------------------------------------------- members column
    const membersColumn = document.createElement('div');
    membersColumn.className = 'groups-column';
    const membersHead = document.createElement('div');
    membersHead.className = 'groups-head';
    membersColumn.appendChild(membersHead);
    const membersList = document.createElement('div');
    membersList.className = 'groups-list drop-target';
    membersColumn.appendChild(membersList);
    columns.appendChild(membersColumn);

    // ------------------------------------------------------ candidates column
    const axisColumn = document.createElement('div');
    axisColumn.className = 'groups-column';
    const axisHead = document.createElement('div');
    axisHead.className = 'groups-head';
    axisHead.textContent = spec.candidatesHead;
    axisColumn.appendChild(axisHead);
    const filter = document.createElement('input');
    filter.type = 'search';
    filter.placeholder = `Filter ${spec.noun.many}…`;
    filter.className = 'modal-filter';
    axisColumn.appendChild(filter);
    // Mounted only when a kind offers subsets. The value is an INDEX, with ''
    // for "all" (hence the '' test rather than Number('') === 0).
    const subsets = spec.candidateSubsets ?? [];
    const subset = document.createElement('select');
    subset.className = 'modal-filter';
    if (subsets.length > 0) {
      const all = document.createElement('option');
      all.value = '';
      all.textContent = `All ${spec.noun.many}`;
      subset.appendChild(all);
      subsets.forEach((entry, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = entry.label;
        subset.appendChild(option);
      });
      const opensOn = subsets.findIndex((entry) => entry.open === true);
      if (opensOn >= 0) subset.value = String(opensOn);
      subset.addEventListener('change', () => paint());
      axisColumn.appendChild(subset);
    }
    const axisList = document.createElement('div');
    axisList.className = 'groups-list drop-target';
    axisColumn.appendChild(axisList);
    const addShown = document.createElement('button');
    addShown.type = 'button';
    addShown.className = 'btn';
    addShown.textContent = 'Add all shown';
    axisColumn.appendChild(addShown);
    columns.appendChild(axisColumn);

    const readout = document.createElement('p');
    readout.className = 'modal-readout';
    modal.appendChild(readout);

    // --------------------------------------------------------------- actions
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const fromFile = document.createElement('input');
    fromFile.type = 'file';
    fromFile.accept = '.csv,text/csv';
    fromFile.style.display = 'none';
    const load = document.createElement('button');
    load.type = 'button';
    load.className = 'btn';
    load.textContent = 'Load CSV…';
    load.addEventListener('click', () => fromFile.click());
    fromFile.addEventListener('change', () => {
      const file = fromFile.files?.[0];
      if (!file) return;
      // Re-armed so picking the SAME file again fires, and a fixed file can
      // be retried.
      fromFile.value = '';
      void file
        .text()
        .then(async (text) => {
          loads.begin(file);
          try {
            await spec.onLoadCsv(text, api, file);
          } finally {
            loads.end(file);
          }
        })
        .catch((error: unknown) => {
          complaint = error instanceof Error ? error.message : String(error);
          paint();
        });
    });
    // Saves without closing, in the shape the editor loads.
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn';
    save.textContent = 'Save CSV…';
    save.addEventListener('click', () => {
      const mark = spec.memberMark;
      const cells =
        spec.csvCells ??
        ((name: string, group: string, marked: boolean) =>
          mark === undefined ? [name, group] : [name, group, mark.csv(marked)]);
      const blob = new Blob([model.toCsv(spec.csvHeader(), cells, spec.csvExtraRows?.() ?? [])], {
        type: 'text/csv',
      });
      saveBlob(blob, spec.downloadName);
    });
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = 'Cancel';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'btn btn-primary';
    confirm.textContent = spec.confirmLabel;
    actions.append(load, save, fromFile, cancel, confirm);
    modal.appendChild(actions);

    // ------------------------------------------------------------- behaviour
    function item(name: string, inGroup: boolean): HTMLElement {
      const row = document.createElement('div');
      row.className = 'groups-item';
      row.draggable = true;
      row.dataset.name = name;

      const label = document.createElement('span');
      label.textContent = name;
      row.appendChild(label);

      const identifiers = spec.detail?.(name) ?? '';
      if (identifiers !== '') {
        const detail = document.createElement('span');
        detail.className = 'groups-detail';
        detail.textContent = identifiers;
        detail.title = identifiers;
        row.appendChild(detail);
      }

      if (inGroup && spec.memberMark) {
        // On the member row only: the setting belongs to the membership.
        const mark = spec.memberMark;
        const group = model.selected;
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'btn groups-mark';
        const paintToggle = (): void => {
          const marked = model.isMarked(group, name);
          toggle.textContent = mark.label(marked);
          toggle.title = mark.title(marked);
          toggle.classList.toggle('active', marked);
        };
        paintToggle();
        // A double-click on the button is two flips, never a removal.
        toggle.addEventListener('dblclick', (event) => event.stopPropagation());
        toggle.addEventListener('click', (event) => {
          event.stopPropagation();
          model.toggleMark(group, name);
          complaint = '';
          paint();
        });
        row.appendChild(toggle);
      }

      if (inGroup) {
        const why = spec.problem(name);
        if (why) {
          row.classList.add('groups-item-missing');
          const flag = document.createElement('span');
          flag.className = 'groups-flag';
          flag.textContent = why;
          row.appendChild(flag);
        }
      } else {
        const count = model.groupsContaining(name);
        if (count > 0) {
          const badge = document.createElement('span');
          badge.className = 'groups-badge';
          badge.textContent = `in ${count}`;
          badge.title = `Already in ${count} group${count === 1 ? '' : 's'}`;
          row.appendChild(badge);
        }
      }

      row.addEventListener('dblclick', () => {
        if (inGroup) model.remove(name);
        else model.add(name);
        complaint = '';
        paint();
      });
      row.addEventListener('dragstart', (event) => {
        event.dataTransfer?.setData('text/plain', name);
        event.dataTransfer?.setData(inGroup ? 'x-from/member' : spec.candidateDragType, '1');
      });
      return row;
    }

    /** The candidate column as shown; "Add all shown" files exactly this. */
    function shown(): string[] {
      const chosen = subset.value === '' ? undefined : subsets[Number(subset.value)];
      return model.candidates(spec.axis, filter.value, {
        detail: spec.detail,
        keep: chosen === undefined ? undefined : (name: string) => chosen.keep(name),
      });
    }

    function paint(): void {
      groupsList.replaceChildren();
      for (const { group, count } of model.ordered()) {
        const row = document.createElement('div');
        row.className =
          'groups-item groups-group' + (group === model.selected ? ' groups-selected' : '');
        const label = document.createElement('span');
        label.textContent = group;
        row.appendChild(label);
        const badge = document.createElement('span');
        badge.className = 'groups-badge';
        badge.textContent = String(count);
        row.appendChild(badge);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'case-remove';
        remove.textContent = '×';
        remove.title = 'Delete this group';
        remove.addEventListener('click', (event) => {
          event.stopPropagation();
          model.deleteGroup(group);
          paint();
        });
        row.appendChild(remove);
        row.addEventListener('click', () => {
          model.select(group);
          paint();
        });
        // Dropping onto a group row files the name without switching groups.
        row.addEventListener('dragover', (event) => event.preventDefault());
        row.addEventListener('drop', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const name = event.dataTransfer?.getData('text/plain');
          if (!name) return;
          model.addTo(group, name);
          paint();
        });
        groupsList.appendChild(row);
      }

      membersHead.textContent = model.selected ? `In “${model.selected}”` : 'No group selected';
      membersList.replaceChildren();
      for (const name of model.sortedMembers()) membersList.appendChild(item(name, true));
      if (model.selected && model.members().length === 0) {
        const empty = document.createElement('div');
        empty.className = 'groups-empty';
        empty.textContent = `Empty — drag ${spec.noun.many} here.`;
        membersList.appendChild(empty);
      }

      axisList.replaceChildren();
      const candidates = shown();
      for (const name of candidates) axisList.appendChild(item(name, false));
      axisHead.textContent = `${spec.candidatesHead} · ${candidates.length} shown`;

      const unplottable = model.members().filter((name) => spec.problem(name) !== null).length;
      readout.textContent =
        `${model.size} group(s) · “${model.selected}” has ` +
        `${model.members().length} ${spec.noun.one}(s)` +
        (unplottable > 0 ? ` · ${unplottable} of them cannot be plotted` : '') +
        (spec.extraReadout?.() ?? '') +
        (complaint !== '' ? ` · ${complaint}` : '');
      if (spec.requireGroups) confirm.disabled = model.size === 0;
    }

    /** A column accepting one drag direction, so a drag cannot undo itself. */
    function dropZone(element: HTMLElement, accept: string, act: (name: string) => void): void {
      element.addEventListener('dragover', (event) => {
        if (!event.dataTransfer?.types.includes(accept)) return;
        event.preventDefault();
        element.classList.add('groups-dropping');
      });
      element.addEventListener('dragleave', () => element.classList.remove('groups-dropping'));
      element.addEventListener('drop', (event) => {
        event.preventDefault();
        element.classList.remove('groups-dropping');
        const name = event.dataTransfer?.getData('text/plain');
        if (name) act(name);
      });
    }
    dropZone(membersList, spec.candidateDragType, (name) => {
      model.add(name);
      complaint = '';
      paint();
    });
    dropZone(axisList, 'x-from/member', (name) => {
      model.remove(name);
      complaint = '';
      paint();
    });

    function addNewGroup(): void {
      if (!model.addGroup(newGroup.value)) return;
      newGroup.value = '';
      complaint = '';
      paint();
    }

    addGroup.addEventListener('click', addNewGroup);
    newGroup.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') addNewGroup();
    });
    filter.addEventListener('input', paint);
    addShown.addEventListener('click', () => {
      for (const name of shown()) model.add(name);
      complaint = '';
      paint();
    });

    function close(result: T | null): void {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      if (result === null) {
        resolve(null);
        return;
      }
      resolve({ value: result, ...loads.applied() });
    }

    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') close(null);
    }

    const api: MembershipEditorApi<T> = {
      close,
      replace(members, marks) {
        model.replace(members, marks ?? []);
        loads.replaced();
        complaint = '';
      },
      complain(message) {
        complaint = message;
      },
      repaint: paint,
    };

    cancel.addEventListener('click', () => close(null));
    confirm.addEventListener('click', () => close(spec.result(model)));
    document.addEventListener('keydown', onKey);

    paint();
    document.body.appendChild(backdrop);
    filter.focus();
  });
}
