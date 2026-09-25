// src/ui/browse-popovers.ts
//
// The filter popover and the column chooser, sharing one lifecycle: one open
// at a time, dismissed by outside click, Escape, table scroll or resize,
// written once so neither can miss a trigger. The chooser writes through
// `setColumnVisible`, so hiding always clears the column's filter; the
// context and group-by columns are never offered.
//
// `activeId`, `activeTab` and the COLUMN are read when a click runs, never
// captured: a header cell can outlive its tab (the header repaints only when
// its signature moves), and a captured column would offer the previous
// variable's rows.

import { distinctValues, mountValueChecklist } from './value-checklist';
import {
  columnVisible,
  orderedColumns,
  setColumnVisible,
  type BrowseTab,
  type ColumnFilter,
  type ViewState,
} from './browse-model';

export interface BrowsePopoverDeps {
  readonly root: HTMLElement;
  readonly columnsButton: HTMLButtonElement;
  readonly browseScroll: HTMLElement;
  readonly viewOf: (tabId: string) => ViewState;
  readonly setView: (tabId: string, next: ViewState) => void;
  readonly activeId: () => string;
  readonly activeTab: () => BrowseTab | undefined;
  /** Whether a column shows as a slicer, and the toggle, per tab. Absent: no
   * "Show as slicer" button. */
  readonly slicers?: {
    isSliced(tabId: string, key: string): boolean;
    setSliced(tabId: string, key: string, on: boolean): void;
  };
}

export interface BrowsePopovers {
  readonly closePopover: () => void;
  readonly toggleFilterPopover: (columnKey: string, button: HTMLElement) => void;
  readonly toggleColumnsPopover: () => void;
}

export function createBrowsePopovers(deps: BrowsePopoverDeps): BrowsePopovers {
  const { root, columnsButton, browseScroll, viewOf, setView } = deps;

  let activePopoverColumn: string | null = null;
  let activePopoverElement: HTMLElement | null = null;
  let activePopoverCleanup: (() => void) | null = null;

  function closePopover(): void {
    if (activePopoverCleanup) {
      activePopoverCleanup();
      activePopoverCleanup = null;
    }
    if (activePopoverElement) {
      activePopoverElement.remove();
      activePopoverElement = null;
    }
    activePopoverColumn = null;
  }

  /** The dismissal every popover shares. */
  function attachPopoverDismissal(popover: HTMLElement, anchor: HTMLElement): void {
    const clickOutside = (e: MouseEvent) => {
      if (!popover.contains(e.target as Node) && !anchor.contains(e.target as Node)) {
        closePopover();
      }
    };
    const escKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePopover();
    };
    const onScroll = () => closePopover();

    document.addEventListener('click', clickOutside);
    document.addEventListener('keydown', escKey);
    // Capture: the table scrolls its own body inside this element, and scroll
    // does not bubble.
    browseScroll.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    activePopoverCleanup = () => {
      document.removeEventListener('click', clickOutside);
      document.removeEventListener('keydown', escKey);
      browseScroll.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', onScroll);
    };
  }

  function toggleFilterPopover(columnKey: string, button: HTMLElement): void {
    const activeId = deps.activeId();
    if (activePopoverColumn === columnKey) {
      closePopover();
      return;
    }
    closePopover();

    // Read at the click. A key with no column on the current tab has nothing
    // to filter.
    const tab = deps.activeTab();
    const column = tab?.columns.find((entry) => entry.key === columnKey);
    if (!tab || !column) return;

    activePopoverColumn = columnKey;
    const popover = document.createElement('div');
    popover.className = 'browse-filter-popover';

    const header = document.createElement('div');
    header.className = 'browse-filter-popover-header';
    const title = document.createElement('span');
    title.textContent = column.label;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'browse-filter-popover-close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', closePopover);
    header.appendChild(title);
    header.appendChild(closeBtn);
    popover.appendChild(header);

    const body = document.createElement('div');
    body.className = 'browse-filter-popover-body';

    const current = viewOf(activeId).filters.get(column.key);

    const write = (filter: ColumnFilter | null): void => {
      const view = viewOf(activeId);
      const next = new Map(view.filters);
      if (filter === null) next.delete(column.key);
      else next.set(column.key, filter);
      setView(activeId, { ...view, filters: next });
    };

    // With a group-by active, a filter applies on commit (blur or Enter):
    // each application is a full grouped rebuild. Ungrouped filters live-type.
    const commitOnly = viewOf(activeId).groupBy != null;

    if (column.kind === 'text') {
      // Two filters behind one popover: the box is `text` (contains), the
      // ticks are `values` (exact). Any tick wins, and the box then only
      // narrows the list; with none ticked the box is the filter.
      const apply = (): void => {
        const ticked = checklist.ticked();
        if (ticked.length > 0) write({ kind: 'values', values: [...ticked] });
        else write(input.value.trim() === '' ? null : { kind: 'text', text: input.value });
      };
      // The column's distinct values over the rows on screen.
      const checklist = mountValueChecklist(body, {
        values: distinctValues(column, tab.rows.length),
        ticked: current?.kind === 'values' ? current.values : [],
        text: current?.kind === 'text' ? current.text : '',
        placeholder: 'Contains or comma-separated list…',
        onTicks: () => apply(),
      });
      const { input } = checklist;

      if (column.category && deps.slicers) {
        const slicers = deps.slicers;
        const shown = slicers.isSliced(activeId, column.key);
        const slicerBtn = document.createElement('button');
        slicerBtn.type = 'button';
        slicerBtn.className = 'browse-filter-action-btn browse-filter-slicer';
        slicerBtn.textContent = shown ? 'Hide slicer' : 'Show as slicer';
        slicerBtn.title = shown
          ? 'Take this list out of the Slicers pane. The filter stays.'
          : 'Keep this list open in the Slicers pane beside the charts';
        slicerBtn.addEventListener('click', () => {
          slicers.setSliced(activeId, column.key, !shown);
          closePopover();
        });
        body.appendChild(slicerBtn);
      }

      if (commitOnly) {
        input.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          apply();
          closePopover();
        });
        popover.addEventListener('focusout', (e) => {
          if (e.relatedTarget && popover.contains(e.relatedTarget as Node)) return;
          apply();
        });
      } else {
        // Only the write; the checklist narrows its list on the same event.
        // With a tick present the box only narrows, so there is nothing to
        // write.
        input.addEventListener('input', () => {
          if (checklist.ticked().length === 0) apply();
        });
      }
    } else {
      // Two bounds on one column and nothing more: a menu of operators would
      // be a filter expression language.
      const bound = (
        labelTxt: string,
        placeholder: string,
        read: (filter: ColumnFilter) => number | null,
      ) => {
        const row = document.createElement('div');
        row.className = 'browse-filter-popover-row';
        const lbl = document.createElement('label');
        lbl.textContent = labelTxt;
        const input = document.createElement('input');
        input.type = 'number';
        input.placeholder = placeholder;
        const value = current ? read(current) : null;
        input.value = value === null ? '' : String(value);
        row.appendChild(lbl);
        row.appendChild(input);
        return { row, input };
      };

      const minInfo = bound('Min', 'min', (filter) =>
        filter.kind === 'range' ? filter.min : null,
      );
      const maxInfo = bound('Max', 'max', (filter) =>
        filter.kind === 'range' ? filter.max : null,
      );

      const push = (): void => {
        const low = minInfo.input.value === '' ? null : Number(minInfo.input.value);
        const high = maxInfo.input.value === '' ? null : Number(maxInfo.input.value);
        write(low === null && high === null ? null : { kind: 'range', min: low, max: high });
      };

      if (commitOnly) {
        for (const input of [minInfo.input, maxInfo.input]) {
          input.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            push();
            closePopover();
          });
        }
        // Moving between the two bounds is editing; leaving (or Enter) commits.
        popover.addEventListener('focusout', (e) => {
          if (e.relatedTarget && popover.contains(e.relatedTarget as Node)) return;
          push();
        });
      } else {
        minInfo.input.addEventListener('input', push);
        maxInfo.input.addEventListener('input', push);
      }

      body.appendChild(minInfo.row);
      body.appendChild(maxInfo.row);
    }

    const footer = document.createElement('div');
    footer.className = 'browse-filter-popover-footer';
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'browse-filter-popover-clear';
    clearBtn.textContent = 'Clear filter';
    clearBtn.addEventListener('click', () => {
      write(null);
      closePopover();
    });
    footer.appendChild(clearBtn);

    popover.appendChild(body);
    popover.appendChild(footer);

    root.appendChild(popover);
    activePopoverElement = popover;

    const btnRect = button.getBoundingClientRect();
    const drawerRect = root.getBoundingClientRect();
    const popRect = popover.getBoundingClientRect();
    let left = btnRect.left - drawerRect.left;
    left = Math.max(8, Math.min(left, drawerRect.width - popRect.width - 8));

    popover.style.top = `${btnRect.bottom - drawerRect.top + 4}px`;
    popover.style.left = `${left}px`;

    attachPopoverDismissal(popover, button);

    const firstInput = popover.querySelector('input');
    if (firstInput) firstInput.focus();
  }

  function toggleColumnsPopover(): void {
    if (activePopoverElement?.classList.contains('browse-columns-popover')) {
      closePopover();
      return;
    }
    closePopover();
    const tab = deps.activeTab();
    if (!tab) return;
    const view = viewOf(tab.id);
    const offered = orderedColumns(tab, view).filter(
      (column) => !column.context && column.key !== view.groupBy,
    );
    if (offered.length === 0) return;

    const popover = document.createElement('div');
    popover.className = 'browse-columns-popover';

    const header = document.createElement('div');
    header.className = 'browse-columns-popover-header';
    const title = document.createElement('span');
    title.textContent = 'Columns';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'browse-columns-popover-close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', closePopover);
    header.appendChild(title);
    header.appendChild(closeBtn);
    popover.appendChild(header);

    const body = document.createElement('div');
    body.className = 'browse-columns-popover-body';
    for (const column of offered) {
      const item = document.createElement('label');
      item.className = 'browse-columns-popover-item';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = columnVisible(column, view);
      box.addEventListener('change', () => {
        // Re-read `viewOf`: the previous checkbox already replaced the view.
        setView(tab.id, setColumnVisible(viewOf(tab.id), column.key, box.checked));
      });
      const label = document.createElement('span');
      label.textContent = column.label;
      // Marked as computed, as in the header.
      if (column.computed) label.classList.add('browse-computed');
      item.appendChild(box);
      item.appendChild(label);
      body.appendChild(item);
    }
    popover.appendChild(body);

    root.appendChild(popover);
    activePopoverElement = popover;

    const btnRect = columnsButton.getBoundingClientRect();
    const drawerRect = root.getBoundingClientRect();
    const popRect = popover.getBoundingClientRect();
    let left = btnRect.left - drawerRect.left;
    left = Math.max(8, Math.min(left, drawerRect.width - popRect.width - 8));

    popover.style.top = `${btnRect.bottom - drawerRect.top + 4}px`;
    popover.style.left = `${left}px`;

    attachPopoverDismissal(popover, columnsButton);
  }

  return { closePopover, toggleFilterPopover, toggleColumnsPopover };
}
