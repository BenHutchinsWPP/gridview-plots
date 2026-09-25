// src/ui/browse-table.ts
//
// The drawer's table, painted by Tabulator: a pure function of (tab, view,
// order) on every draw. Tabulator is a renderer here and nothing more. It
// never sorts, filters or groups; the model in `./browse-model.ts` does, and
// the header's controls write back through the host. What it adds is what a
// hand-built <table> could not afford: every row in scope scrolls (virtual
// rows), columns resize and reorder, and a dragged cell range copies with
// Ctrl+C as tab-separated text that pastes into Excel.
//
//   * Copy is not paint: cells copy as the full-precision double, a ratio as
//     0–1 (the form the engineers who paste it work in), as `./browse-csv.ts`
//     exports them. The painted text is carried on the row beside the value.
//   * A row carries its own ref and painted text, so nothing painted from the
//     previous tab indexes the current one while the next tab's rows load.
//   * Field names are positional (`c0`, `d0`, ...): a column key may contain
//     a dot, which Tabulator reads as a nested path.
//   * A drag makes a cell range, never a text selection: Tabulator's Ctrl+C
//     copies a live text selection in place of the range (`styles.css`).
//   * A header control (the Selected tab's "Switch all" row) is a native
//     `<select>` on the header's second line. It keeps its mouse and key
//     events from Tabulator, whose sort, column drag and range keys would
//     otherwise take them, and a change that rebuilds the header hands focus
//     to the new control, or the next arrow press lands nowhere.
//   * Tabulator resets the range to the top-left cell and takes focus on
//     every data load. So a draw whose rows are unchanged (a preview, a tick)
//     restyles rows in place, and one that does replace them puts the range
//     back by row id. Focus is never taken: a filter box typed into would
//     lose every keystroke after the first.
//
// Elements arrive on a host record, since only `main.ts` resolves global ids
// (`tests/test_dom_contract.mjs`).

import {
  Tabulator,
  ClipboardModule,
  EditModule,
  ExportModule,
  FormatModule,
  FrozenColumnsModule,
  InteractionModule,
  KeybindingsModule,
  MoveColumnsModule,
  ResizeColumnsModule,
  SelectRangeModule,
  type CellComponent,
  type ColumnDefinition,
} from 'tabulator-tables';
import 'tabulator-tables/dist/css/tabulator_simple.min.css';
import {
  cellClassOf,
  displayCell,
  filteringColumnLabels,
  headerSignature,
  moveColumnTo,
  setGroupBy,
  visibleColumns,
  type BrowseRowRef,
  type BrowseTab,
  type SelectionEntry,
  type SelectionStore,
  type SortState,
  type ViewState,
} from './browse-model';

// Clipboard's Ctrl+C binding reads the edit module's state, so Edit is
// registered although no cell is editable.
Tabulator.registerModule([
  ClipboardModule,
  EditModule,
  ExportModule,
  FormatModule,
  FrozenColumnsModule,
  InteractionModule,
  KeybindingsModule,
  MoveColumnsModule,
  ResizeColumnsModule,
  SelectRangeModule,
]);

/** The table's element, view, selection and the drawer state it writes to. */
export interface BrowseTableHost {
  mount: HTMLElement;
  countLine: HTMLElement;
  selection: SelectionStore;
  outOfScope: ReadonlySet<string>;
  view(): ViewState;
  setView(next: ViewState): void;
  /** By KEY: the handler outlives the paint, and the drawer re-resolves the
   * key against the tab on screen. */
  toggleFilterPopover(columnKey: string, button: HTMLElement): void;
  onSelectionChange(pinned: readonly SelectionEntry[], previewed: BrowseRowRef | null): void;
  redraw(): void;
}

export interface BrowseTable {
  paint(tab: BrowseTab, view: ViewState, order: Int32Array): void;
  clear(): void;
}

type GridRow = Record<string, unknown> & { _id: string; _ref: BrowseRowRef };

/** The group-by control's glyph: rows gathered under a bracket. An icon, not
 * the word, so a header is not widened by a control on every column. The
 * button's title carries the words. */
function groupByIcon(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M3 1.5H1.5v9H3M5 3h5.5M5 6h5.5M5 9h5.5');
  svg.appendChild(path);
  return svg;
}

const arrowOf = (view: ViewState, key: string): string =>
  view.sort?.key === key ? (view.sort.direction === 'asc' ? '▲' : '▼') : '';

/** One Tabulator in `host.mount`, repainted on every draw. */
export function createBrowseTable(host: BrowseTableHost): BrowseTable {
  const { mount } = host;
  let built = false;
  let pending: (() => void) | null = null;
  let signature = '';
  let tabId = '';
  let current: BrowseTab | null = null;
  /** Positional field to column key, for the painted columns. */
  let keyOfField = new Map<string, string>();
  /** Widths the user dragged, by column key, so a header rebuild keeps them. */
  const widths = new Map<string, number>();
  /** The rows on screen, so a draw that would load the same rows loads none. */
  let shownTab: BrowseTab | null = null;
  let shownOrder: Int32Array | null = null;
  /** The range to put back, recorded by the first of loads still in
   * flight. Tabulator resets the range to the top-left cell as a load's data
   * is processed, before that load settles, so a second draw in the same
   * moment (a click's preview, then the chart render) would read the reset
   * range and put back the top-left cell. */
  let inFlightAnchor: ReturnType<typeof rangeAnchor> = null;
  let loading = 0;
  /** Row id to the pin/preview state its row was last formatted with. */
  const painted = new Map<string, string>();
  const rowState = (id: string): string => {
    const { selection } = host;
    return `${selection.isPinned(id)}|${selection.colorOf(id) ?? ''}|${selection.previewed()?.id === id}|${host.outOfScope.has(id)}`;
  };

  const grid = new Tabulator(mount, {
    height: '100%',
    // Columns fit their data and the table fills the drawer, so a table
    // wider than the drawer scrolls inside it rather than being clipped.
    layout: 'fitData',
    index: '_id',
    renderVertical: 'virtual',
    movableColumns: true,
    selectableRange: 1,
    selectableRangeColumns: false,
    selectableRangeRows: true,
    // The typings lag this option as well.
    ...({ selectableRangeAutoFocus: false } as object),
    clipboard: 'copy',
    clipboardCopyRowRange: 'range',
    clipboardCopyStyled: false,
    clipboardCopyConfig: { columnHeaders: true, rowHeaders: false, columnGroups: false },
    // The typings lag the option: a rowHeader takes a column definition.
    rowHeader: {
      field: '_id',
      resizable: false,
      frozen: true,
      clipboard: false,
      formatter: (cell: CellComponent) => tickCell((cell.getData() as GridRow)._ref),
    } as unknown as boolean,
    rowFormatter: (row) => {
      const id = (row.getData() as GridRow)._id;
      painted.set(id, rowState(id));
      const el = row.getElement();
      el.classList.add('browse-row');
      el.classList.toggle('previewed', host.selection.previewed()?.id === id);
      // Still drawn but out of scope, and marked as such.
      el.classList.toggle('out-of-scope', host.outOfScope.has(id));
    },
    columns: [],
    data: [],
  });

  grid.on('tableBuilt', () => {
    built = true;
    pending?.();
    pending = null;
  });

  const selectionChanged = (): void => {
    host.onSelectionChange(host.selection.list(), host.selection.previewed());
    host.redraw();
  };

  // A click previews (grey, dashed, replaced by the next click); the checkbox
  // pins. A drag across cells makes a range, and fires no click on one row.
  grid.on('rowClick', (event, row) => {
    if ((event.target as HTMLElement).closest('.browse-tick')) return;
    const ref = (row.getData() as GridRow)._ref;
    const { selection } = host;
    selection.preview(selection.previewed()?.id === ref.id ? null : ref);
    selectionChanged();
  });

  // The preview follows the active cell as the arrow keys move it, one row
  // at a time: a Shift-extended range spans rows and previews none. Coalesced
  // to a frame, so a held key redraws the chart once per frame.
  let keyFrame = 0;
  mount.addEventListener('keydown', (event) => {
    if (!/^(Arrow(Up|Down)|Page(Up|Down)|Home|End)$/.test(event.key)) return;
    if ((event.target as HTMLElement).closest('input, textarea, select')) return;
    cancelAnimationFrame(keyFrame);
    keyFrame = requestAnimationFrame(() => {
      const rows = grid.getRanges()[0]?.getRows() ?? [];
      if (rows.length !== 1) return;
      const ref = (rows[0].getData() as GridRow)._ref;
      const { selection } = host;
      if (selection.previewed()?.id === ref.id) return;
      selection.preview(ref);
      selectionChanged();
    });
  });

  // The arrangement is the view's, written through `moveColumnTo` so hidden
  // columns keep their place; Tabulator's own move is only the gesture.
  grid.on('columnMoved', (column) => {
    const key = keyOfField.get(column.getField());
    if (!current || key === undefined) return;
    const keys = grid
      .getColumns()
      .map((c) => keyOfField.get(c.getField()))
      .filter((k): k is string => k !== undefined);
    host.setView(moveColumnTo(current, host.view(), key, keys.indexOf(key)));
  });

  grid.on('columnResized', (column) => {
    const key = keyOfField.get(column.getField());
    if (key !== undefined) widths.set(key, column.getWidth());
  });

  function tickCell(ref: BrowseRowRef): HTMLElement {
    const { selection } = host;
    const wrap = document.createElement('span');
    wrap.className = 'browse-tick';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = selection.isPinned(ref.id);
    // Neither a range start nor a preview.
    box.addEventListener('mousedown', (event) => event.stopPropagation());
    box.addEventListener('click', (event) => event.stopPropagation());
    box.addEventListener('change', () => {
      selection.toggle(ref);
      selectionChanged();
    });
    const swatch = document.createElement('span');
    swatch.className = 'browse-swatch';
    const color = selection.colorOf(ref.id);
    swatch.style.background = color ?? 'transparent';
    swatch.hidden = color === undefined;
    wrap.append(box, swatch);
    return wrap;
  }

  /** A header button is neither a column move nor a sort. */
  function headerButton(className: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.addEventListener('mousedown', (event) => event.stopPropagation());
    return button;
  }

  /** A header's second line: its control, and on the first column the row's
   * name. Every header of a tab with switches gets one, so they align. */
  function switchLine(tab: BrowseTab, key: string, first: boolean): HTMLElement {
    const line = document.createElement('span');
    line.className = 'browse-switch-line';
    if (first) {
      const name = document.createElement('span');
      name.className = 'browse-switch-name';
      name.textContent = 'Switch all';
      line.appendChild(name);
    }
    const control = tab.switches?.get(key);
    if (!control) return line;
    const select = document.createElement('select');
    select.className = 'browse-switch';
    select.dataset.column = key;
    select.title = control.title;
    select.disabled = control.refusal !== undefined;
    for (const entry of control.options) {
      const option = document.createElement('option');
      option.value = entry.value;
      option.textContent = entry.label;
      option.disabled = entry.disabled !== undefined;
      if (entry.disabled !== undefined) option.title = entry.disabled;
      option.selected = entry.value === control.value;
      select.appendChild(option);
    }
    for (const type of ['mousedown', 'click', 'keydown'] as const) {
      select.addEventListener(type, (event) => event.stopPropagation());
    }
    select.addEventListener('change', () => control.onChange(select.value));
    line.appendChild(select);
    return line;
  }

  function titleOf(tab: BrowseTab, view: ViewState, key: string, first: boolean): HTMLElement {
    const column = tab.columns.find((c) => c.key === key);
    const head = document.createElement('span');
    head.className = 'browse-head';
    if (!column) return head;
    // With switches the header is two lines: the title row, then the control.
    const wrap = tab.switches ? document.createElement('span') : head;
    if (tab.switches) {
      head.classList.add('browse-head-switched');
      wrap.className = 'browse-head-title';
      head.append(wrap, switchLine(tab, key, first));
    }
    const label = document.createElement('span');
    wrap.appendChild(label);
    // A context column restates a constraint: no controls under it.
    if (column.context) {
      label.textContent = column.label;
      return head;
    }
    label.className = 'browse-sort';
    label.dataset.column = key;
    label.textContent = column.label;
    // A slot of its own width, so a sort that adds the arrow never truncates
    // a label the column was fitted to without it.
    const arrow = document.createElement('span');
    arrow.className = 'browse-sort-arrow';
    arrow.dataset.column = key;
    arrow.textContent = arrowOf(view, key);
    label.appendChild(arrow);

    if (column.groupable || column.groupDisabledReason) {
      const groupBtn = headerButton('browse-groupby');
      const isGrouped = view.groupBy === key;
      groupBtn.classList.toggle('active', isGrouped);
      groupBtn.title =
        column.groupDisabledReason ?? `${isGrouped ? 'Ungroup' : 'Group'} by ${column.label}`;
      groupBtn.setAttribute('aria-label', groupBtn.title);
      groupBtn.appendChild(groupByIcon());
      groupBtn.disabled = Boolean(column.groupDisabledReason);
      groupBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        const now = host.view();
        host.setView(setGroupBy(now, now.groupBy === key ? null : key));
      });
      wrap.appendChild(groupBtn);
    }

    const filterBtn = headerButton('browse-col-filter-btn');
    filterBtn.dataset.column = key;
    filterBtn.innerHTML = '&#x25BE;';
    filterBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      host.toggleFilterPopover(key, filterBtn);
    });
    wrap.appendChild(filterBtn);
    return head;
  }

  /** Sort arrows and filter marks, repainted in place: a rebuild would drop
   * the button an open filter popover is anchored to. */
  function markHeader(view: ViewState): void {
    for (const arrow of mount.querySelectorAll<HTMLElement>('.browse-sort-arrow')) {
      arrow.textContent = arrowOf(view, arrow.dataset.column ?? '');
    }
    for (const btn of mount.querySelectorAll<HTMLElement>('.browse-col-filter-btn')) {
      const hasFilter = view.filters.has(btn.dataset.column ?? '');
      btn.classList.toggle('active', hasFilter);
      btn.title = hasFilter ? 'Filter active' : 'Filter';
    }
  }

  function columnsOf(tab: BrowseTab, view: ViewState): ColumnDefinition[] {
    const columns = visibleColumns(tab, view);
    keyOfField = new Map(columns.map((column, i) => [`c${i}`, column.key]));
    return columns.map((column, i) => ({
      title: column.label,
      field: `c${i}`,
      width: widths.get(column.key),
      hozAlign: column.kind === 'number' ? 'right' : 'left',
      cssClass: column.computed ? 'browse-computed' : undefined,
      titleFormatter: () => titleOf(tab, view, column.key, i === 0),
      formatter: (cell) => String((cell.getData() as GridRow)[`d${i}`] ?? ''),
      formatterClipboard: (cell) => {
        const value = cell.getValue();
        if (value === null || value === undefined) return '';
        if (typeof value === 'number') return Number.isFinite(value) ? value : '';
        return value;
      },
      headerClick: (event) => {
        if (column.context || (event.target as HTMLElement).closest('button, select')) return;
        const now = host.view();
        // Numbers sort DESC first ("which is biggest"); text A-Z.
        const direction: SortState['direction'] =
          now.sort?.key === column.key
            ? now.sort.direction === 'asc'
              ? 'desc'
              : 'asc'
            : column.kind === 'number'
              ? 'desc'
              : 'asc';
        host.setView({ ...now, sort: { key: column.key, direction } });
      },
    }));
  }

  function rowsOf(tab: BrowseTab, view: ViewState, order: Int32Array): GridRow[] {
    const columns = visibleColumns(tab, view);
    const rows: GridRow[] = new Array(order.length);
    for (let i = 0; i < order.length; i++) {
      const rowIndex = order[i];
      const ref = tab.rows[rowIndex];
      const row: GridRow = { _id: ref.id, _ref: ref };
      for (let c = 0; c < columns.length; c++) {
        const value = columns[c].value(rowIndex);
        row[`c${c}`] = value;
        row[`d${c}`] = displayCell(value, cellClassOf(columns[c], rowIndex));
      }
      rows[i] = row;
    }
    return rows;
  }

  const sameOrder = (a: Int32Array | null, b: Int32Array): boolean =>
    a !== null && a.length === b.length && a.every((row, i) => row === b[i]);

  /** Reformat only the rows whose pin or preview moved: loading the same
   * rows again would reset the range and scroll. */
  function restyle(): void {
    for (const row of grid.getRows()) {
      const id = (row.getData() as GridRow)._id;
      const was = painted.get(id);
      if (was !== undefined && was !== rowState(id)) row.reformat();
    }
  }

  /** The range's corners, by row id and field, to put back after a load. */
  function rangeAnchor(): { top: string; bottom: string; left: string; right: string } | null {
    const range = grid.getRanges()[0];
    if (!range) return null;
    const rows = range.getRows();
    const columns = range.getColumns();
    if (rows.length === 0 || columns.length === 0) return null;
    return {
      top: (rows[0].getData() as GridRow)._id,
      bottom: (rows[rows.length - 1].getData() as GridRow)._id,
      left: columns[0].getField(),
      right: columns[columns.length - 1].getField(),
    };
  }

  /** Put the range back where its rows and columns still are. A row that
   * left (filtered out) collapses the range to the other corner. */
  function restoreRange(anchor: NonNullable<ReturnType<typeof rangeAnchor>>): void {
    // `getRow` answers `false`, not undefined, for a row that left.
    const top = grid.getRow(anchor.top) || undefined;
    const bottom = grid.getRow(anchor.bottom) || undefined;
    const start = (top || bottom)?.getCell(anchor.left);
    const end = (bottom || top)?.getCell(anchor.right);
    if (!start || !end) return;
    grid.getRanges()[0]?.setBounds(start, end);
  }

  function apply(tab: BrowseTab, view: ViewState, order: Int32Array): void {
    current = tab;
    const nextSignature = headerSignature(tab, view);
    const rebuilt = nextSignature !== signature;
    if (rebuilt) {
      const held = focusedSwitch();
      grid.setColumns(columnsOf(tab, view));
      signature = nextSignature;
      refocusSwitch(held);
    } else {
      markHeader(view);
    }
    writeCount(tab, view, order);
    if (!rebuilt && tab === shownTab && sameOrder(shownOrder, order)) {
      restyle();
      return;
    }
    shownTab = tab;
    shownOrder = order;
    // The same tab keeps its scroll, so ticking a row does not jump to row 1;
    // a new tab starts at the top.
    const holder = mount.querySelector<HTMLElement>('.tabulator-tableholder');
    const sameTab = tabId === tab.id;
    const keepTop = sameTab && holder ? holder.scrollTop : 0;
    const keepLeft = sameTab && holder ? holder.scrollLeft : 0;
    const anchor = sameTab && !rebuilt ? (loading > 0 ? inFlightAnchor : rangeAnchor()) : null;
    inFlightAnchor = anchor;
    loading++;
    tabId = tab.id;
    painted.clear();
    void grid.replaceData(rowsOf(tab, view, order)).then(() => {
      if (--loading === 0) inFlightAnchor = null;
      // New columns were measured against the old rows: fit them to these.
      if (rebuilt) grid.redraw(true);
      if (holder) {
        holder.scrollTop = keepTop;
        holder.scrollLeft = keepLeft;
      }
      if (anchor) restoreRange(anchor);
    });
  }

  /** The column key of the header control holding focus, if one does. */
  function focusedSwitch(): string | undefined {
    const active = document.activeElement;
    return active instanceof HTMLSelectElement &&
      active.classList.contains('browse-switch') &&
      mount.contains(active)
      ? active.dataset.column
      : undefined;
  }

  /** Focus the rebuilt control above the same column. */
  function refocusSwitch(key: string | undefined): void {
    if (key === undefined) return;
    for (const select of mount.querySelectorAll<HTMLSelectElement>('.browse-switch')) {
      if (select.dataset.column === key && !select.disabled) {
        select.focus({ preventScroll: true });
        return;
      }
    }
  }

  function writeCount(tab: BrowseTab, view: ViewState, order: Int32Array): void {
    // Say why a table is empty: a per-tab filter can keep nothing after a
    // variable change, and "0 rows" would read as a study with no data.
    const emptiedBy = order.length === 0 ? filteringColumnLabels(tab, view) : [];
    host.countLine.textContent =
      emptiedBy.length > 0
        ? `0 of ${tab.rows.length.toLocaleString()} row${tab.rows.length === 1 ? '' : 's'} in scope: ` +
          `the filter${emptiedBy.length === 1 ? '' : 's'} on ${emptiedBy.join(', ')} ` +
          `match${emptiedBy.length === 1 ? 'es' : ''} nothing here.`
        : `${order.length.toLocaleString()} row${order.length === 1 ? '' : 's'} in scope` +
          ' · drag across cells and press Ctrl+C to copy them';
  }

  return {
    paint(tab, view, order) {
      if (built) apply(tab, view, order);
      else pending = () => apply(tab, view, order);
    },
    clear() {
      current = null;
      signature = '';
      tabId = '';
      pending = null;
      shownTab = null;
      shownOrder = null;
      painted.clear();
      if (built) {
        grid.setColumns([]);
        void grid.replaceData([]);
      }
    },
  };
}
