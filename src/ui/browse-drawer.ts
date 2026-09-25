// src/ui/browse-drawer.ts
//
// FIND: the drawer at the bottom of the chart area. The core loop is "sort by
// max, click, look at the shape, click the next one", which needs the chart
// and the table on screen together, hence an overlay and a half detent.
//
// Kind-neutral chrome: tabs, sort, column filters, selection, column
// visibility and order, and one height. Every row, column and refusal comes
// from a kind's adapter (e.g. `src/tables/generator/ui/browse.ts`), so a new
// kind is one adapter and no edit here.
//
// A grouped tab's sums depend on the filters, so the drawer computes a
// keep-set from the ungrouped tab and hands it to the build. That is also why
// a grouped tab's filter commits on blur or Enter (one rebuild per decision)
// while an ungrouped tab filters as you type.

import { within } from './dom';
import { browseDescriptor, browseTableCsv } from './browse-csv';
import { longNote, wideWithheld, type HourlyLayout } from './hourly-csv';
import { createBrowsePopovers } from './browse-popovers';
import { createBrowseDetent, type Detent } from './browse-detent';
import { createBrowseTable } from './browse-table';
import { subjectLabel } from '../series/label';
import type { PercentSwitch, VariableSwitch } from './browse-retarget';
import {
  STAT_COLUMNS,
  builtView,
  carryFilterContext,
  declinedGroupBy,
  dropRescaledBounds,
  cellClassOf,
  pinnedConstraint,
  createSelection,
  keptRowKeys,
  rowSubject,
  viewChips,
  visibleRows,
  type BrowseColumn,
  type BrowseRowRef,
  type BrowseTab,
  type CellClass,
  type ColumnFilter,
  type SelectionEntry,
  type ViewState,
} from './browse-model';
import { saveBlob } from './download';

export type { Detent };

/**
 * One kind's tab source. `build` is expensive (it ranks every scoped row), so
 * a tab is built only when it is ACTIVE and the drawer OPEN, and cached until
 * the signature changes.
 */
export interface BrowseTabSource {
  readonly id: string;
  readonly label: string;
  /** `keep` is the keep-set (`browseJoinKey`s of ungrouped rows that passed
   * the filters), passed only with a group-by. Not a filter map, so no kind
   * re-implements filter semantics. */
  build(groupBy?: string | null, perUnit?: boolean, keep?: ReadonlySet<string>): BrowseTab;
  /** The tab honours `perUnit` ("% of range"). A kind's own answer, so the
   * drawer names no kind to decide it. */
  readonly offersRange?: boolean;
}

export interface BrowseDrawerState {
  /** One tab per kind with something to list, in bar order. The drawer adds
   * the Selected tab itself. */
  readonly tabs: readonly BrowseTabSource[];
  /** Changes exactly when a rebuilt tab would differ. Built tabs are held
   * until it does, so sorting and filtering re-read the same numbers. */
  readonly signature: string;
  /** The quantities loaded for the active tab's kind. */
  readonly variables: readonly string[];
  readonly variable: string;
  /** The hour filter the stats were computed under, as a sentence for the
   * CSV export's descriptor line. */
  readonly hourFilter: string;
  /** A Case's label (`caseLabel` in src/model/case-model.ts), for the
   * Selected tab and the CSV descriptor, which list pins from every Case. */
  readonly caseLabel: (caseId: string) => string;
  /** The Selected tab's Variable dropdown. A function, since only the
   * Selected tab reads it and every preview renders. */
  readonly selectedVariable: () => VariableSwitch;
  /** The Selected tab's "% of range" button, lazily for the same reason. */
  readonly selectedPercent: () => PercentSwitch;
}

export interface BrowseDrawerHandlers {
  /**
   * The pinned series (in pin order) or the preview changed. Never fired by a
   * re-scope: a drawn series that falls out of scope stays drawn.
   */
  onSelectionChange(pinned: readonly SelectionEntry[], preview: BrowseRowRef | null): void;
  /** A VIEW control: re-list and re-rank, never clear the selection. */
  onVariableChange(variable: string): void;
  /** A variable picked on the Selected tab: move every pin to it. */
  onSelectedVariableChange(variable: string): void;
  /** A VIEW change, like the variable. The Selected tab reports its own id,
   * which is not a kind. */
  onTabChange(tabId: string): void;
  onPerUnitChange?(perUnit: boolean): void;
  /** "% of range" clicked on the Selected tab: switch every pin to `on`. The
   * drawer's mode moves only through `setPerUnit`. */
  onSelectedPercent(on: boolean): void;
  /**
   * A tab action was clicked, with the rows the tab is SHOWING (filtered,
   * sorted), captured at the click: re-deriving them later could act on a
   * different set than the analyst saw.
   */
  onAction?(tabId: string, actionId: string, shown: readonly BrowseRowRef[]): void;
  /**
   * An hourly download was picked, with the rows the tab is SHOWING in sort
   * order, its descriptor lines and its notes, all captured at the click like
   * a tab action's rows.
   */
  onDownloadHourly?(download: HourlyDownload): void;
  /** Optional semantic color resolver for pinned rows. */
  resolveColor?(ref: BrowseRowRef): string | undefined;
}

/** What an hourly download writes, as the tab showed it at the click. */
export interface HourlyDownload {
  readonly tabId: string;
  readonly layout: HourlyLayout;
  readonly refs: readonly BrowseRowRef[];
  readonly descriptor: readonly string[];
  readonly notes: readonly string[];
}

export interface BrowseDrawer {
  render(state: BrowseDrawerState): void;
  /** The pinned series, for a caller that needs them outside a change event. */
  selection(): SelectionEntry[];
  /** Restore pinned rows from a saved selection. */
  setSelection(entries: readonly SelectionEntry[]): void;
  /** Replace the pinned rows with rewritten ones (a Selected-tab switch).
   * Colours come from the entries; the preview is dropped, and so are the
   * Selected tab's stat bounds, which the switch rescaled. */
  replacePins(entries: readonly SelectionEntry[]): void;
  /** The tab on screen, or `''` before the first render. It can move without
   * a click (its last table removed), so read it rather than mirror it. */
  activeTabId(): string;
  /**
   * The rows a tab's filters keep, ungrouped, in display order, for ANY tab
   * (an editor opened from a groups tab reuses the units tab's filtering).
   * Undefined when the tab has no active filter: "every row" would be a
   * narrowing that narrows nothing.
   */
  filteredRows(tabId: string): readonly BrowseRowRef[] | undefined;
  isPerUnit(): boolean;
  /** Move the "% of range" mode without firing its handler, dropping the
   * bounds it rescales as a click does. */
  setPerUnit(on: boolean): void;
  detent(): Detent;
  setDetent(detent: Detent): void;
  /** The dragged height in pixels, or null on a detent. Saved in the bundle
   * so the height survives a reload. */
  heightPx(): number | null;
  /** Adopt a saved height, clamped to this screen. Never opens the drawer. */
  restoreHeight(px: number): void;
}

/** The Selected tab's id. It is not a kind, and no adapter may claim it. */
const SELECTED = 'selected';

export function createBrowseDrawer(
  root: HTMLElement,
  handlers: BrowseDrawerHandlers,
): BrowseDrawer {
  const tabBar = within(root, '#browse-tabs');
  const variableSelect = within<HTMLSelectElement>(root, '#browse-variable');
  const perUnitToggle = within<HTMLButtonElement>(root, '#browse-per-unit');
  const columnsButton = within<HTMLButtonElement>(root, '#browse-columns');
  const downloadButton = within<HTMLButtonElement>(root, '#browse-download');
  const downloadMenu = within(root, '#browse-download-menu');
  const wideItem = within<HTMLButtonElement>(root, '[data-download="wide"]');
  const wideNote = within(root, '[data-note="wide"]');
  const longItem = within<HTMLButtonElement>(root, '[data-download="long"]');
  const longNoteLine = within(root, '[data-note="long"]');
  const expandButton = within<HTMLButtonElement>(root, '#browse-expand');
  const collapseButton = within<HTMLButtonElement>(root, '#browse-collapse');
  const handle = within<HTMLButtonElement>(root, '#browse-handle');
  const handleLabel = within<HTMLSpanElement>(root, '#browse-handle-label');
  const resizeStrip = within(root, '#browse-resize');
  const notesRow = within(root, '#browse-notes-row');
  const notesLine = within(root, '#browse-notes');
  const actionsContainer = within(root, '#browse-actions');
  const chipsContainer = within(root, '#browse-chips');
  const countLine = within(root, '#browse-count');
  const gridMount = within(root, '#browse-grid');
  const browseScroll = within(root, '.browse-scroll');

  const selection = createSelection(undefined, handlers.resolveColor);
  /** Sort and filters per tab, kept across tab switches. */
  const views = new Map<string, ViewState>();
  let activeId = '';
  let perUnit = false;
  let latest: BrowseDrawerState = {
    tabs: [],
    signature: '',
    variables: [],
    variable: '',
    hourFilter: '',
    caseLabel: (caseId) => caseId,
    selectedVariable: () => ({ variables: [], variable: '' }),
    selectedPercent: () => ({ on: false, next: true }),
  };
  /** Built tabs, held until the caller's signature changes. */
  const built = new Map<string, BrowseTab>();
  /** Pinned rows the current scope does not list, set by the Selected tab. */
  let outOfScope = new Set<string>();

  const viewOf = (tabId: string): ViewState =>
    views.get(tabId) ?? { sort: null, filters: new Map<string, ColumnFilter>() };

  /** Content equality: an unchanged commit must not cost a rebuild. */
  const sameFilter = (a: ColumnFilter, b: ColumnFilter): boolean => {
    if (a.kind === 'text' && b.kind === 'text') return a.text === b.text;
    if (a.kind === 'values' && b.kind === 'values') {
      return a.values.length === b.values.length && a.values.every((v, i) => v === b.values[i]);
    }
    if (a.kind === 'range' && b.kind === 'range') return a.min === b.min && a.max === b.max;
    return false;
  };
  const sameFilters = (
    a: ReadonlyMap<string, ColumnFilter>,
    b: ReadonlyMap<string, ColumnFilter>,
  ): boolean => {
    if (a.size !== b.size) return false;
    for (const [key, filter] of a) {
      const other = b.get(key);
      if (!other || !sameFilter(filter, other)) return false;
    }
    return true;
  };

  /** Drop a tab's GROUPED builds when its filters change: they were summed
   * from a keep-set the new filters no longer produce. The ungrouped build
   * does not depend on filters and stays. */
  const evictGrouped = (tabId: string): void => {
    for (const key of built.keys()) {
      const bar = key.indexOf('|');
      // Key is `${id}|${groupBy ?? ''}|...`; an empty groupBy is ungrouped.
      if (key.slice(0, bar) === tabId && key.charAt(bar + 1) !== '|') built.delete(key);
    }
  };

  const setView = (tabId: string, next: ViewState): void => {
    const prev = views.get(tabId);
    // Sort and group-by keep the same filters object; filter writes replace it.
    if (prev && prev.filters !== next.filters && !sameFilters(prev.filters, next.filters)) {
      evictGrouped(tabId);
    }
    views.set(tabId, next);
    draw();
  };

  variableSelect.addEventListener('change', () => {
    if (activeId === SELECTED) handlers.onSelectedVariableChange(variableSelect.value);
    else handlers.onVariableChange(variableSelect.value);
  });
  /** The mode, and the bounds it rescales dropped: a MW bound against a %
   * cell empties the table. */
  const dropBounds = (tabId: string): void => {
    const view = views.get(tabId);
    if (!view) return;
    const next = dropRescaledBounds(view);
    if (next === view) return;
    evictGrouped(tabId);
    views.set(tabId, next);
  };
  const applyPerUnit = (on: boolean): void => {
    perUnit = on;
    for (const tabId of views.keys()) if (offersRange(tabId)) dropBounds(tabId);
  };

  perUnitToggle.addEventListener('click', () => {
    if (activeId === SELECTED) {
      const pins = latest.selectedPercent();
      if (pins.refusal === undefined) handlers.onSelectedPercent(pins.next);
      return;
    }
    applyPerUnit(!perUnit);
    draw();
    handlers.onPerUnitChange?.(perUnit);
  });

  // The export IS the screen: active tab, its view and kept rows, derived at
  // click time so file and paint cannot disagree.
  function downloadStats(): void {
    const tab = activeTab();
    if (!tab) return;
    const csv = browseTableCsv(tab, builtView(tab, viewOf(tab.id)), csvMeta());
    saveBlob(new Blob([csv], { type: 'text/csv' }), `browse-${tab.id}.csv`);
  }

  const csvMeta = () => ({
    hourFilter: latest.hourFilter,
    variable: shownVariables().variable,
    caseLabel: latest.caseLabel,
  });

  /** The rows the active tab shows, in sort order, and the view they are
   * shown under. */
  function shownRows(): { tab: BrowseTab; view: ViewState; refs: BrowseRowRef[] } | undefined {
    const tab = activeTab();
    if (!tab) return undefined;
    const view = builtView(tab, viewOf(tab.id));
    return { tab, view, refs: Array.from(visibleRows(tab, view), (row) => tab.rows[row]) };
  }

  function downloadHourly(layout: HourlyLayout): void {
    const shown = shownRows();
    if (!shown || shown.refs.length === 0) return;
    handlers.onDownloadHourly?.({
      tabId: shown.tab.id,
      layout,
      refs: shown.refs,
      descriptor: browseDescriptor(shown.tab, shown.view, csvMeta()),
      notes: shown.tab.notes,
    });
  }

  const onMenuOutside = (event: MouseEvent): void => {
    const target = event.target as Node;
    if (!downloadMenu.contains(target) && !downloadButton.contains(target)) closeDownloadMenu();
  };
  const onMenuKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closeDownloadMenu();
  };
  function closeDownloadMenu(): void {
    if (downloadMenu.hidden) return;
    downloadMenu.hidden = true;
    downloadButton.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onMenuOutside);
    document.removeEventListener('keydown', onMenuKey);
  }
  /** Each item says, before it is picked, whether it can write this tab. */
  function openDownloadMenu(): void {
    const count = shownRows()?.refs.length ?? 0;
    const withheld = wideWithheld(count);
    wideItem.disabled = count === 0 || withheld !== '';
    wideNote.textContent = withheld;
    wideItem.title =
      withheld ||
      (count === 0
        ? 'This tab shows no rows.'
        : `One row per hour, one column per series: ${count.toLocaleString()} series`);
    const note = longNote(count);
    longItem.disabled = count === 0;
    longNoteLine.textContent = note;
    longItem.title =
      count === 0
        ? 'This tab shows no rows.'
        : note ||
          `One row per series and hour, under a Series column: ${count.toLocaleString()} series`;
    downloadMenu.hidden = false;
    downloadButton.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', onMenuOutside);
    document.addEventListener('keydown', onMenuKey);
  }

  downloadButton.addEventListener('click', () => {
    if (downloadMenu.hidden) openDownloadMenu();
    else closeDownloadMenu();
  });
  downloadMenu.addEventListener('click', (event) => {
    const item = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-download]');
    if (!item || item.disabled) return;
    closeDownloadMenu();
    const layout = item.dataset.download;
    if (layout === 'stats') downloadStats();
    else if (layout === 'wide' || layout === 'long') downloadHourly(layout);
  });

  // ------------------------------------------------------------ the tabs

  /** What the Variable dropdown lists: the active kind's quantities, or on
   * the Selected tab what every pin can move to. */
  function shownVariables(): VariableSwitch {
    if (activeId !== SELECTED) return { variables: latest.variables, variable: latest.variable };
    return latest.selectedVariable();
  }

  function offersRange(id: string): boolean {
    return latest.tabs.find((entry) => entry.id === id)?.offersRange === true;
  }

  /** The tab's UNGROUPED form, cached like any other. A grouped build's
   * keep-set is evaluated over it, the only place filtered columns exist. */
  function ungroupedTabFor(id: string): BrowseTab | undefined {
    const activePu = perUnit && offersRange(id);
    const key = `${id}||${activePu ? 'pu' : 'abs'}`;
    const held = built.get(key);
    if (held) return held;
    const source = latest.tabs.find((entry) => entry.id === id);
    if (!source) return undefined;
    const tab = source.build(null, activePu);
    built.set(key, tab);
    return tab;
  }

  /** One tab, built at most once per signature, group-by, and per-unit setting. */
  function tabFor(id: string): BrowseTab | undefined {
    const view = viewOf(id);
    const activePu = perUnit && offersRange(id);
    const key = `${id}|${view.groupBy ?? ''}|${activePu ? 'pu' : 'abs'}`;
    const held = built.get(key);
    if (held) return held;
    const source = latest.tabs.find((entry) => entry.id === id);
    if (!source) return undefined;
    let tab: BrowseTab;
    if (view.groupBy) {
      // The tab's own view, not the active tab's: the Selected tab builds
      // every kind's tab in one pass.
      const base = ungroupedTabFor(id);
      const keep = base ? keptRowKeys(base, view) : undefined;
      tab = source.build(view.groupBy, activePu, keep);
      if (declinedGroupBy(tab)) {
        // The build declined the group-by (the quantity cannot be summed, or
        // the column is gone). Nothing was consumed, and the tab says why in
        // its Group button's own words.
        const column = base?.columns.find((entry) => entry.key === view.groupBy);
        tab = {
          ...tab,
          notes: [
            ...tab.notes,
            `Not grouped by ${column?.label ?? view.groupBy}: ` +
              (column?.groupDisabledReason ?? 'this tab cannot group by it now.') +
              ' Each unit is listed, and the grouping returns when it can.',
          ],
        };
      } else if (base) {
        tab = carryFilterContext(tab, base, view);
      }
    } else {
      tab = source.build(null, activePu);
    }
    built.set(key, tab);
    return tab;
  }

  /** The tab now on screen. */
  function activeTab(): BrowseTab | undefined {
    if (activeId !== SELECTED) return tabFor(activeId);
    // The Selected tab reads stat cells from the kind tabs, so it builds them.
    // It is not cached itself: pins do not move the signature.
    const listed: BrowseTab[] = [];
    for (const source of latest.tabs) {
      const tab = tabFor(source.id);
      if (tab) listed.push(tab);
    }
    return buildSelectedTab(listed);
  }

  function renderTabs(tabs: readonly BrowseTabSource[]): void {
    // Rebuilt every render: the set is small, so rebuilding beats reconciling.
    tabBar.replaceChildren();
    const entries = [
      ...tabs.map((tab) => ({ id: tab.id, label: tab.label })),
      { id: SELECTED, label: 'Selected' },
    ];
    if (!entries.some((entry) => entry.id === activeId)) activeId = entries[0].id;
    for (const entry of entries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'browse-tab';
      button.textContent =
        entry.id === SELECTED ? `Selected (${selection.list().length})` : entry.label;
      button.classList.toggle('active', entry.id === activeId);
      button.addEventListener('click', () => {
        if (activeId === entry.id) return;
        popovers.closePopover();
        activeId = entry.id;
        draw();
        // After the paint, so the old kind's rows never flash under the new tab.
        handlers.onTabChange(entry.id);
      });
      tabBar.appendChild(button);
    }
  }

  // -------------------------------------------------------- Selected tab
  //
  // The register of what is drawn, and the only grid where kinds meet: its
  // columns are kind-neutral, and its stats are read from each row's kind tab
  // by the shared `STAT_COLUMNS` keys.

  function buildSelectedTab(tabs: readonly BrowseTab[]): BrowseTab {
    const entries = selection.list();
    /** Row id -> where that row is currently listed, for its stat cells. */
    const listed = new Map<string, { tab: BrowseTab; row: number }>();
    for (const tab of tabs) {
      for (let row = 0; row < tab.rows.length; row++) {
        if (selection.isPinned(tab.rows[row].id)) listed.set(tab.rows[row].id, { tab, row });
      }
    }

    const refs = entries.map((entry) => entry.ref);
    const text = (label: string, read: (ref: BrowseRowRef) => string): BrowseColumn => ({
      key: `selected.${label}`,
      label,
      kind: 'text',
      computed: false,
      value: (row) => read(refs[row]),
    });

    const columns: BrowseColumn[] = [
      text('Case', (ref) => latest.caseLabel(ref.caseId)),
      text('Kind', (ref) => ref.kind),
      // The label where the kind has one (a bus id alone is unreadable), and
      // for a bucket the column that made it: `SOUTH` by Zone is not `SOUTH`
      // by Owner.
      text('Entity', (ref) =>
        subjectLabel({
          caseLabel: latest.caseLabel(ref.caseId),
          kind: ref.kind,
          variable: ref.variable,
          unit: ref.unit,
          subject: rowSubject(ref, latest.caseLabel),
          ...(ref.groupBy ? { groupBy: ref.groupBy } : {}),
        }),
      ),
      text('Variable', (ref) => ref.variable),
      text('Unit', (ref) => ref.unit),
      {
        key: 'selected.scope',
        label: 'In scope',
        kind: 'text',
        computed: false,
        value: (row) => (listed.has(refs[row].id) ? 'yes' : 'out of scope'),
      },
      // The filters a pinned group was built under, frozen at tick time. Shown
      // only when some pin carries context.
      ...(refs.some((ref) => ref.filterContext && ref.filterContext.length > 0)
        ? [
            {
              key: 'selected.filters',
              label: 'Filters',
              kind: 'text' as const,
              computed: false,
              value: (row: number) => {
                const ref = refs[row];
                return (ref.filterContext ?? [])
                  .map((entry) => `${entry.label}: ${pinnedConstraint(entry, ref)}`)
                  .join('; ');
              },
            },
          ]
        : []),
      ...STAT_COLUMNS.map((stat) => ({
        key: stat.key,
        label: stat.label,
        kind: 'number' as const,
        computed: true,
        // Each row's class comes from its own kind tab, so percent and MW can
        // share a column.
        cellClass: (row: number): CellClass => {
          const at = listed.get(refs[row].id);
          const column = at?.tab.columns.find((candidate) => candidate.key === stat.key);
          return column ? cellClassOf(column, at!.row) : 'quantity';
        },
        value: (row: number) => {
          const at = listed.get(refs[row].id);
          const column = at?.tab.columns.find((candidate) => candidate.key === stat.key);
          return column ? column.value(at!.row) : null;
        },
      })),
    ];

    outOfScope = new Set(refs.filter((ref) => !listed.has(ref.id)).map((ref) => ref.id));
    const missing = outOfScope.size;
    const notes = missing
      ? [
          `${missing} of ${refs.length} selected series ${missing === 1 ? 'is' : 'are'} outside ` +
            'the current scope. They stay drawn; their stats are blank because the scope did not rank them.',
        ]
      : [];
    return { id: SELECTED, label: 'Selected', rows: refs, columns, notes };
  }

  const popovers = createBrowsePopovers({
    root,
    columnsButton,
    browseScroll,
    viewOf,
    setView,
    activeId: () => activeId,
    activeTab,
  });

  columnsButton.addEventListener('click', popovers.toggleColumnsPopover);

  const height = createBrowseDetent({
    root,
    handle,
    resizeStrip,
    expandButton,
    collapseButton,
    closePopover: () => popovers.closePopover(),
    // Renders are skipped while closed, so redraw on open.
    onOpen: () => draw(),
  });

  /** The table in `./browse-table.ts` reaches this closure's state only
   * through this host record. */
  const grid = createBrowseTable({
    mount: gridMount,
    countLine,
    selection,
    get outOfScope() {
      return outOfScope;
    },
    view: () => viewOf(activeId),
    setView: (next) => setView(activeId, next),
    toggleFilterPopover: popovers.toggleFilterPopover,
    onSelectionChange: (pinned, previewed) => handlers.onSelectionChange(pinned, previewed),
    redraw: () => draw(),
  });

  function draw(): void {
    renderTabs(latest.tabs);
    // Closed, only the handle paints, and its pin count comes from memory:
    // closing the drawer must never cost a ranking pass.
    const pinned = selection.list().length;
    handleLabel.textContent = pinned > 0 ? `Browse · ${pinned}` : 'Browse';
    const detent = height.detent();
    if (detent === 'closed') {
      return;
    }
    const tab = activeTab();
    if (!tab) {
      grid.clear();
      notesLine.textContent = 'Nothing loaded yet. Drop a GridView export to browse it.';
      notesLine.hidden = false;
      actionsContainer.replaceChildren();
      chipsContainer.replaceChildren();
      notesRow.hidden = false;
      countLine.textContent = '';
      return;
    }

    // The variables loaded for this kind, or on the Selected tab the ones
    // every pin can move to.
    const shown = shownVariables();
    variableSelect.replaceChildren();
    for (const variable of shown.variables) {
      const option = document.createElement('option');
      option.value = variable;
      option.textContent = variable;
      option.selected = variable === shown.variable;
      variableSelect.appendChild(option);
    }
    variableSelect.disabled = shown.refusal !== undefined || shown.variables.length === 0;
    variableSelect.title =
      activeId !== SELECTED ? '' : (shown.refusal ?? 'Switch every pinned series to this variable');

    if (activeId === SELECTED) {
      // The pins' state, not the drawer's mode: the button describes the chart.
      const pins = latest.selectedPercent();
      perUnitToggle.disabled = pins.refusal !== undefined;
      perUnitToggle.classList.toggle('active', pins.on);
      perUnitToggle.title =
        pins.refusal ??
        (pins.next
          ? 'Show every pin as a % of its limit, else of its own peak'
          : 'Show every pin in its own unit');
    } else {
      const canPerUnit = offersRange(activeId);
      perUnitToggle.disabled = !canPerUnit;
      perUnitToggle.classList.toggle('active', perUnit && canPerUnit);
      perUnitToggle.title = !canPerUnit
        ? 'This tab has no % of range.'
        : perUnit
          ? 'Each series as a % of its limit (summed, for a group), else of its own peak'
          : 'Absolute values';
    }

    // The view the tab was BUILT under, so a declined group-by does not show
    // an active "ungroup" control.
    const view = builtView(tab, viewOf(tab.id));
    grid.paint(tab, view, visibleRows(tab, view));

    const hasNotes = tab.notes.length > 0;
    const hasActions = Boolean(tab.actions && tab.actions.length > 0);
    notesLine.textContent = tab.notes.join(' ');
    notesLine.hidden = !hasNotes;

    actionsContainer.replaceChildren();
    if (tab.actions) {
      for (const action of tab.actions) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn browse-action';
        btn.textContent = action.label;
        btn.addEventListener('click', () => {
          // Read at the click: filters re-list without rebuilding the tab.
          const shown = visibleRows(tab, builtView(tab, viewOf(tab.id)));
          handlers.onAction?.(
            tab.id,
            action.id,
            Array.from(shown, (row) => tab.rows[row]),
          );
        });
        actionsContainer.appendChild(btn);
      }
    }

    // The view states shaping these rows, each a click from cleared. Through
    // `setView`, so a clear re-lists and re-ranks and never touches the
    // selection, and only on this tab.
    const chips = viewChips(tab, viewOf(tab.id));
    chipsContainer.replaceChildren();
    for (const chip of chips) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'browse-chip';
      btn.dataset.chip = chip.key;
      btn.textContent = `${chip.label} ✕`;
      btn.title = chip.key === 'filters' ? 'Clear these filters' : 'Ungroup';
      btn.addEventListener('click', () => setView(tab.id, chip.clear(viewOf(tab.id))));
      chipsContainer.appendChild(btn);
    }
    chipsContainer.hidden = chips.length === 0;
    notesRow.hidden = !hasNotes && !hasActions && chips.length === 0;
  }

  height.setDetent('closed');

  function adoptPins(entries: readonly SelectionEntry[]): void {
    selection.restore(entries);
    handlers.onSelectionChange(selection.list(), selection.previewed());
    draw();
  }

  return {
    render(state) {
      if (state.signature !== latest.signature) {
        built.clear();
        // An open popover describes the old rows; close it on rebuild.
        popovers.closePopover();
      }
      latest = state;
      draw();
    },
    selection: () => selection.list(),
    setSelection: adoptPins,
    replacePins(entries) {
      dropBounds(SELECTED);
      adoptPins(entries);
    },
    activeTabId: () => activeId,
    filteredRows(tabId) {
      // The UNGROUPED form holds the filtered columns; built on demand and
      // cached as a visit would.
      const base = ungroupedTabFor(tabId);
      if (base === undefined) return undefined;
      const view = viewOf(tabId);
      // `keptRowKeys` is undefined exactly when no filter is active.
      if (keptRowKeys(base, view) === undefined) return undefined;
      return Array.from(visibleRows(base, view), (row) => base.rows[row]);
    },
    isPerUnit: () => perUnit,
    setPerUnit: applyPerUnit,
    detent: height.detent,
    setDetent: height.setDetent,
    heightPx: height.heightPx,
    restoreHeight: height.restoreHeight,
  };
}
