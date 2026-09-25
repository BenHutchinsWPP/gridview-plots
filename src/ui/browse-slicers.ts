// src/ui/browse-slicers.ts
//
// The Slicers pane in the section's left rail: the active Browse tab's
// category filters as standing checklists, the way an Excel slicer shows a
// Table column's filter. It narrows the browse tables only; pins and the
// chart are untouched.
//
//   * **A slicer IS the column's filter**, read from and written to the
//     tab's view like the column dropdown's ticks, so either shows the
//     other's change. A rail scope was rejected: it would drop rows before
//     the tab saw them, so an unticked value would vanish from the
//     dropdown's checklist and could not be ticked back from there.
//   * **Its values come from the tab's UNGROUPED form**, where a grouped
//     build evaluates its filters: a list column exists only there.
//   * **Painted in place.** The drawer draws on every tick and preview; a
//     slicer whose values are unchanged only has its ticks updated, so a
//     search typed into it and its scroll survive.
//
// Kind-neutral chrome, handed its mount: only `main.ts` resolves an element,
// and it finds this one inside the section clone.

import { distinctValues, mountValueChecklist, type ValueChecklist } from './value-checklist';
import {
  filterConstraint,
  slicerColumns,
  type BrowseTab,
  type ColumnFilter,
  type ViewState,
} from './browse-model';

export interface SlicerWrites {
  /** Replace one column's filter on the tab, or clear it with `null`. */
  filter(key: string, filter: ColumnFilter | null): void;
  /** Stop showing one column as a slicer. Its filter stays. */
  unslice(key: string): void;
}

export interface SlicerPane {
  /** `tab` undefined: nothing to slice, and `why` says so. */
  paint(tab: BrowseTab | undefined, view: ViewState, writes: SlicerWrites, why: string): void;
}

interface Mounted {
  readonly element: HTMLElement;
  /** The tab and values the checklist was built from. */
  readonly signature: string;
  readonly checklist: ValueChecklist;
  readonly note: HTMLElement;
}

export function createSlicerPane(mount: HTMLElement): SlicerPane {
  const heading = document.createElement('p');
  heading.className = 'slicer-heading';
  const empty = document.createElement('p');
  empty.className = 'slicer-empty';
  const list = document.createElement('div');
  list.className = 'slicer-list';
  mount.replaceChildren(heading, empty, list);

  /** By tab id and column key. */
  const mounted = new Map<string, Mounted>();
  /** The writes of the latest paint: a slicer outlives the paint that built it. */
  let writes: SlicerWrites = { filter() {}, unslice() {} };

  function build(tab: BrowseTab, key: string, label: string, values: string[]): Mounted {
    const element = document.createElement('div');
    element.className = 'slicer';
    const head = document.createElement('div');
    head.className = 'slicer-head';
    const title = document.createElement('span');
    title.className = 'slicer-title';
    title.textContent = label;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'slicer-close';
    close.textContent = '✕';
    close.title = `Take ${label} out of the Slicers pane. Its filter stays.`;
    close.setAttribute('aria-label', close.title);
    close.addEventListener('click', () => writes.unslice(key));
    head.append(title, close);
    const note = document.createElement('p');
    note.className = 'slicer-note';
    const body = document.createElement('div');
    body.className = 'slicer-body';
    element.append(head, note, body);
    // The box only narrows the list here: a `contains` filter is the
    // dropdown's, and a slicer is its ticks.
    const checklist = mountValueChecklist(body, {
      values,
      ticked: [],
      text: '',
      placeholder: 'Search…',
      onTicks: (ticked) =>
        writes.filter(key, ticked.length > 0 ? { kind: 'values', values: [...ticked] } : null),
    });
    return {
      element,
      signature: `${tab.id}\u0000${values.join('\u0000')}`,
      checklist,
      note,
    };
  }

  return {
    paint(tab, view, next, why) {
      writes = next;
      heading.textContent = tab ? `On the ${tab.label} tab` : '';
      heading.hidden = !tab;
      const columns = tab ? slicerColumns(tab, view) : [];
      empty.hidden = tab !== undefined && columns.length > 0;
      empty.textContent = tab
        ? 'Choose "Show as slicer" in a category column’s filter to keep its list here.'
        : why;
      const shown: HTMLElement[] = [];
      const keep = new Set<string>();
      for (const column of columns) {
        const id = `${tab!.id}\u0000${column.key}`;
        keep.add(id);
        const values = distinctValues(column, tab!.rows.length);
        let held = mounted.get(id);
        if (!held || held.signature !== `${tab!.id}\u0000${values.join('\u0000')}`) {
          held = build(tab!, column.key, column.label, values);
          mounted.set(id, held);
        }
        const filter = view.filters.get(column.key);
        held.checklist.setTicked(filter?.kind === 'values' ? filter.values : []);
        // A dropdown's `contains` filter has no ticks to show; say it.
        held.note.textContent =
          filter && filter.kind !== 'values' ? `Filtered: ${filterConstraint(filter)}` : '';
        held.note.hidden = held.note.textContent === '';
        shown.push(held.element);
      }
      for (const id of [...mounted.keys()]) if (!keep.has(id)) mounted.delete(id);
      // Moved, not rebuilt, when the order is unchanged.
      if (
        shown.length !== list.children.length ||
        shown.some((element, i) => list.children[i] !== element)
      ) {
        list.replaceChildren(...shown);
      }
    },
  };
}
