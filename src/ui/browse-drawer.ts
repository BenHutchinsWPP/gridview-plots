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
import { createSlicerPane } from './browse-slicers';
import { subjectLabel } from '../series/label';
import { PERCENT } from '../series/range';
import type { CaseSwitch, PercentSwitch, VariableSwitch } from './browse-retarget';
import {
  STAT_COLUMNS,
  builtView,
  carryFilterContext,
  declinedGroupBy,
  boundsFollow,
  dropRescaledBounds,
  statsShownAs,
  cellClassOf,
  isSliced,
  setSliced,
  pinnedConstraint,
  createSelection,
  hasActiveFilter,
  keptRowKeys,
  sameFilters,
  tabIndex,
  rowSubject,
  statValue,
  viewChips,
  visibleRows,
  type BrowseColumn,
  type BrowseRowRef,
  type BrowseTab,
  type CaseNames,
  type CellClass,
  type ColumnFilter,
  type SwitchControl,
  type PinLine,
  type SelectionEntry,
  type StatFields,
  type ViewState,
} from './browse-model';
import { saveBlob } from './download';

/** The three switches' answers over some pins. */
export interface SwitchAnswers {
  readonly case: CaseSwitch;
  readonly variable: VariableSwitch;
  readonly percent: PercentSwitch;
}

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
  /** The Selected tab's Case dropdown, lazily for the same reason. */
  readonly selectedCase: () => CaseSwitch;
  /** One pin's own switches, by row id, for its row's controls. */
  readonly selectedRow: (rowId: string) => SwitchAnswers;
  /** For a pinned filter chosen in another Case. */
  readonly caseNames: CaseNames;
  /** A pin's line on the charts, by row id (`pinLines`): its stats when no
   * tab lists the pin under its current view, and why it is not drawn when it
   * is not. Undefined before the pin's first render. */
  readonly pinLine: (rowId: string) => PinLine | undefined;
}

export interface BrowseDrawerHandlers {
  /**
   * The pinned series (in pin order) or the preview changed. Never fired by a
   * re-scope: a pinned series stays drawn whatever the tabs list. The host
   * renders, which repaints the drawer, so the drawer does not paint again.
   */
  onSelectionChange(pinned: readonly SelectionEntry[], preview: BrowseRowRef | null): void;
  /** A VIEW control: re-list and re-rank, never clear the selection. */
  onVariableChange(variable: string): void;
  /** A variable picked on the Selected tab: move every pin to it. */
  onSelectedVariableChange(variable: string): void;
  /** A Case picked on the Selected tab: move every pin to it. */
  onSelectedCaseChange(caseId: string): void;
  /** A Case, variable or unit (`pct` / `own`) picked in one Selected row:
   * move that pin alone. */
  onSelectedRowChange(rowId: string, field: 'case' | 'variable' | 'unit', value: string): void;
  /** A VIEW change, like the variable. The Selected tab reports its own id,
   * which is not a kind. The host renders, which is the tab's one paint:
   * the frame reads the new tab's variables from `activeTabId`. */
  onTabChange(tabId: string): void;
  /** The toolbar's "% of range" moved. The host renders, as for a tab. */
  onPerUnitChange(perUnit: boolean): void;
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
   * Selected tab's stat bounds when the switch `rescaled` them: a variable
   * or unit switch does, a Case switch does not. Said by the caller, which
   * knows the switch; pins that merge (`firstPerId`) move no quantity. */
  replacePins(entries: readonly SelectionEntry[], rescaled: boolean): void;
  /** The tab on screen, or `''` while no kind has anything to list. It can
   * move without a click (its last table removed), so read it rather than
   * mirror it. */
  activeTabId(): string;
  /**
   * The rows a tab's filters keep, ungrouped, in display order, for ANY tab
   * (an editor opened from a groups tab reuses the units tab's filtering).
   * Undefined when the tab has no active filter: "every row" would be a
   * narrowing that narrows nothing.
   */
  filteredRows(tabId: string): readonly BrowseRowRef[] | undefined;
  /** Move the "% of range" mode without firing its handler. A tab's stat
   * bounds follow when it is next read, as after a click. */
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

/**
 * `slicerMount` is the Slicers pane in the section's rail. The drawer owns
 * the tab views a slicer reads and writes, so it paints the pane, though the
 * pane sits outside it.
 */
export function createBrowseDrawer(
  root: HTMLElement,
  handlers: BrowseDrawerHandlers,
  slicerMount: HTMLElement,
): BrowseDrawer {
  const tabBar = within(root, '#browse-tabs');
  const variableSelect = within<HTMLSelectElement>(root, '#browse-variable');
  const variableField = variableSelect.closest<HTMLElement>('.browse-field') ?? variableSelect;
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
    selectedCase: () => ({ cases: [], caseId: '' }),
    selectedRow: () => ({
      case: { cases: [], caseId: '' },
      variable: { variables: [], variable: '' },
      percent: { on: false, next: true },
    }),
    caseNames: { nameOf: () => undefined, labelOfName: (name) => name },
    pinLine: () => undefined,
  };
  /** Built tabs by `keyOf`, held until the caller's signature changes. */
  const built = new Map<string, { tabId: string; grouped: boolean; tab: BrowseTab }>();
  /** What each kind tab's stat cells were in when last read
   * (`statsShownAs`): the quantity its stat bounds were typed against. */
  const typedOn = new Map<string, string>();
  /** Pinned rows whose line is not drawn, read on every draw: every tab
   * greys them, not only the Selected tab. */
  let notDrawn = new Set<string>();
  /** The Selected tab as this draw built it, for its slicers to read rather
   * than build it a second time. */
  let selectedTab: BrowseTab | undefined;

  /** One cache key per build: tab, group-by and "% of range". */
  const keyOf = (tabId: string, groupBy: string | null | undefined, pu: boolean): string =>
    `${tabId}\u0000${groupBy ?? ''}\u0000${pu ? 'pu' : 'abs'}`;

  const viewOf = (tabId: string): ViewState =>
    views.get(tabId) ?? { sort: null, filters: new Map<string, ColumnFilter>() };

  /** Drop a tab's GROUPED builds when its filters change: they were summed
   * from a keep-set the new filters no longer produce. The ungrouped build
   * does not depend on filters and stays. */
  const evictGrouped = (tabId: string): void => {
    for (const [key, entry] of built) {
      if (entry.tabId === tabId && entry.grouped) built.delete(key);
    }
  };

  const setView = (tabId: string, next: ViewState): void => {
    const prev = views.get(tabId);
    // Sort and group-by keep the same filters object; filter writes replace
    // it. Content equality, so an unchanged commit costs no rebuild.
    if (prev && prev.filters !== next.filters && !sameFilters(prev.filters, next.filters)) {
      evictGrouped(tabId);
    }
    views.set(tabId, next);
    draw();
  };

  // On the Selected tab these two are hidden: its "Switch all" row rewrites
  // the pins, so one widget never means two things.
  variableSelect.addEventListener('change', () => {
    handlers.onVariableChange(variableSelect.value);
  });
  /** Rewrite a tab's view without a paint: it runs while a tab is read. */
  const replaceView = (tabId: string, change: (view: ViewState) => ViewState): void => {
    const view = views.get(tabId);
    if (!view) return;
    const next = change(view);
    if (next === view) return;
    evictGrouped(tabId);
    views.set(tabId, next);
  };
  /** The mode only. Each tab's bounds follow when it is next read, so a tab
   * off the bar drops them when it returns, and a mode set to what it is
   * drops nothing. */
  const applyPerUnit = (on: boolean): void => {
    perUnit = on;
  };

  perUnitToggle.addEventListener('click', () => {
    applyPerUnit(!perUnit);
    handlers.onPerUnitChange(perUnit);
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

  /** What the variable is: the active kind's quantities, or on the Selected
   * tab what every pin can move to (the CSV descriptor names it). */
  function shownVariables(): VariableSwitch {
    if (activeId !== SELECTED) return { variables: latest.variables, variable: latest.variable };
    return latest.selectedVariable();
  }

  const sourceOf = (id: string): BrowseTabSource | undefined =>
    latest.tabs.find((entry) => entry.id === id);

  /** Whether a tab builds as "% of range" now: the mode, where it offers it.
   * The one rule every cache key is written and read under. */
  const puOf = (source: BrowseTabSource | undefined): boolean =>
    perUnit && source?.offersRange === true;

  function offersRange(id: string): boolean {
    return sourceOf(id)?.offersRange === true;
  }

  /** A kind tab's rows say what its stat cells are in. Every row of one
   * tab lists one quantity, so the first row answers for all. The UNGROUPED
   * rows even on a grouped tab: a grouped build consumes the stat bounds
   * over them (`carryFilterContext`), so they are what a bound is tested on. */
  function readShown(id: string, tab: BrowseTab): void {
    const shown = statsShownAs(tab.rows.slice(0, 1));
    const typed = typedOn.get(id);
    replaceView(id, (view) => boundsFollow(view, typed, shown));
    if (shown !== undefined) typedOn.set(id, shown);
  }

  /** The tab's UNGROUPED form, cached like any other. A grouped build's
   * keep-set is evaluated over it, the only place filtered columns exist.
   * Read on every access, cached or not, is where its stat bounds follow
   * what it shows: toggling back to a held build is still a change. */
  function ungroupedTabFor(id: string): BrowseTab | undefined {
    const source = sourceOf(id);
    if (!source) return undefined;
    const pu = puOf(source);
    const key = keyOf(id, null, pu);
    let tab = built.get(key)?.tab;
    if (!tab) {
      tab = source.build(null, pu);
      built.set(key, { tabId: id, grouped: false, tab });
    }
    readShown(id, tab);
    return tab;
  }

  /** One tab, built at most once per signature, group-by, and per-unit setting. */
  function tabFor(id: string): BrowseTab | undefined {
    const base = ungroupedTabFor(id);
    // Read after the base, whose read may have dropped a bound.
    const view = viewOf(id);
    const source = sourceOf(id);
    if (!base || !source || !view.groupBy) return base;
    const pu = puOf(source);
    const key = keyOf(id, view.groupBy, pu);
    const held = built.get(key);
    if (held) return held.tab;
    // The tab's own view, not the active tab's: the Selected tab builds
    // every kind's tab in one pass.
    let tab = source.build(view.groupBy, pu, keptRowKeys(base, view));
    if (declinedGroupBy(tab)) {
      // The build declined the group-by (the quantity cannot be summed, or
      // the column is gone). Nothing was consumed, and the tab says why in
      // its Group button's own words.
      const column = base.columns.find((entry) => (entry.groupsAs ?? entry.key) === view.groupBy);
      tab = {
        ...tab,
        notes: [
          ...tab.notes,
          `Not grouped by ${column?.label ?? view.groupBy}: ` +
            (column?.groupDisabledReason ?? 'this tab cannot group by it now.') +
            ' Each unit is listed, and the grouping returns when it can.',
        ],
      };
    } else {
      tab = carryFilterContext(tab, base, view);
    }
    built.set(key, { tabId: id, grouped: true, tab });
    return tab;
  }

  /** The tab now on screen. */
  function activeTab(): BrowseTab | undefined {
    return activeId === SELECTED ? selectedNow() : tabFor(activeId);
  }

  /** The Selected tab, whichever tab is on screen. It reads stat cells from
   * the kind tabs, so it builds them. It is not cached across draws: pins do
   * not move the signature. */
  function selectedNow(): BrowseTab {
    const listed: BrowseTab[] = [];
    for (const source of latest.tabs) {
      const tab = tabFor(source.id);
      if (tab) listed.push(tab);
    }
    selectedTab = buildSelectedTab(listed);
    return selectedTab;
  }

  /** Pinned rows whose line the last render did not draw. */
  function notDrawnIds(): Set<string> {
    const ids = new Set<string>();
    for (const entry of selection.list()) {
      const line = latest.pinLine(entry.ref.id);
      if (line !== undefined && !line.drawn) ids.add(entry.ref.id);
    }
    return ids;
  }

  function renderTabs(tabs: readonly BrowseTabSource[]): void {
    // Rebuilt every render: the set is small, so rebuilding beats reconciling.
    tabBar.replaceChildren();
    const entries = [
      ...tabs.map((tab) => ({ id: tab.id, label: tab.label })),
      { id: SELECTED, label: 'Selected' },
    ];
    // The first kind tab, never Selected: with nothing loaded no tab is
    // active, so the drawer says so rather than showing an empty register.
    // Pins that outlived their tables keep Selected open, the one place
    // they can still be read and unpinned.
    const pins = selection.list().length;
    const selectedOpen = tabs.length > 0 || pins > 0;
    if (
      !entries.some((entry) => entry.id === activeId) ||
      (activeId === SELECTED && !selectedOpen)
    ) {
      activeId = tabs[0]?.id ?? (selectedOpen ? SELECTED : '');
    }
    for (const entry of entries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'browse-tab';
      button.textContent = entry.id === SELECTED ? `Selected (${pins})` : entry.label;
      button.classList.toggle('active', entry.id === activeId);
      if (entry.id === SELECTED && !selectedOpen) {
        button.disabled = true;
        button.title = 'Nothing is loaded or pinned.';
      }
      button.addEventListener('click', () => {
        if (activeId === entry.id) return;
        popovers.closePopover();
        activeId = entry.id;
        handlers.onTabChange(entry.id);
      });
      tabBar.appendChild(button);
    }
  }

  // -------------------------------------------------------- Selected tab
  //
  // The register of what is drawn, and the only grid where kinds meet: its
  // columns are kind-neutral. A pin's stats are its kind tab's row, by the
  // shared `STAT_COLUMNS` keys, when that tab lists it; otherwise its drawn
  // line's. A row is greyed only when its line is not drawn, and says why.

  function buildSelectedTab(tabs: readonly BrowseTab[]): BrowseTab {
    const entries = selection.list();
    /** Row id -> where that row is currently listed, for its stat cells. */
    const listed = new Map<string, { tab: BrowseTab; row: number }>();
    for (const tab of tabs) {
      const { rows } = tabIndex(tab);
      for (const entry of entries) {
        const row = rows.get(entry.ref.id);
        if (row !== undefined) listed.set(entry.ref.id, { tab, row });
      }
    }

    const refs = entries.map((entry) => entry.ref);
    /** Why a pin's line is not drawn, or undefined when it is (or has not
     * rendered yet). */
    const notDrawnWhy = (ref: BrowseRowRef): string | undefined => {
      const line = latest.pinLine(ref.id);
      return line && !line.drawn ? line.reason : undefined;
    };
    const drawnStats = (ref: BrowseRowRef): StatFields | undefined => {
      const line = latest.pinLine(ref.id);
      return line?.drawn ? line.stats : undefined;
    };
    const text = (
      label: string,
      read: (ref: BrowseRowRef) => string,
      category?: true,
    ): BrowseColumn => ({
      key: `selected.${label}`,
      label,
      kind: 'text',
      computed: false,
      ...(category ? { category } : {}),
      value: (row) => read(refs[row]),
    });

    const columns: BrowseColumn[] = [
      text('Case', (ref) => latest.caseLabel(ref.caseId), true),
      text('Kind', (ref) => ref.kind, true),
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
        key: 'selected.drawn',
        label: 'Drawn',
        kind: 'text',
        computed: false,
        value: (row) => {
          const why = notDrawnWhy(refs[row]);
          return why === undefined ? 'yes' : `no: ${why}`;
        },
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
                  .map(
                    (entry) => `${entry.label}: ${pinnedConstraint(entry, ref, latest.caseNames)}`,
                  )
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
          const column = at && tabIndex(at.tab).columns.get(stat.key);
          if (column) return cellClassOf(column, at!.row);
          // As a kind tab classes its stats: the hours a count, a % pin a ratio.
          if (stat.key === 'stat.n') return 'count';
          return refs[row].perUnit ? 'ratio' : 'quantity';
        },
        value: (row: number) => {
          const at = listed.get(refs[row].id);
          const column = at && tabIndex(at.tab).columns.get(stat.key);
          if (column) return column.value(at!.row);
          const stats = drawnStats(refs[row]);
          const value = stats ? statValue(stats, stat.key) : null;
          // A drawn % line reads 100 at its divisor; a tab's % stat is the
          // ratio, which is what the cell's ratio class paints.
          return value !== null && refs[row].perUnit && stat.key !== 'stat.n'
            ? value / PERCENT
            : value;
        },
      })),
    ];

    const missing = refs.filter((ref) => notDrawnWhy(ref) !== undefined).length;
    const notes = missing
      ? [
          `${missing} of ${refs.length} selected series ${missing === 1 ? 'is' : 'are'} not ` +
            'drawn; the Drawn column says why.',
        ]
      : [];
    return {
      id: SELECTED,
      label: 'Selected',
      rows: refs,
      columns,
      notes,
      switches: switches(refs),
      rowSwitches: rowSwitches(refs),
    };
  }

  /** The Case, Variable and Unit controls over some pins: the "Switch all"
   * row over every pin, or one row's over its own. A row lists only what its
   * pin can take; the header also lists what some pin blocks, disabled and
   * naming the pins, and shows "Mixed" while the pins differ. */
  function switchControls(
    refs: readonly BrowseRowRef[],
    answers: SwitchAnswers,
    row: boolean,
    on: {
      case(caseId: string): void;
      variable(variable: string): void;
      percent(on: boolean): void;
    },
  ): Map<string, SwitchControl> {
    const { case: byCase, variable: byVariable, percent: byPercent } = answers;
    const whom = row ? 'this series' : 'every pinned series';
    const mixedOption = {
      value: '',
      label: 'Mixed',
      disabled: 'The pins differ; pick one for all',
    };
    const valid = <T extends { disabled?: string }>(options: T[]): T[] =>
      row ? options.filter((option) => option.disabled === undefined) : options;
    // Mixed: some pins % and some not. Shown as such, never as either.
    const percentMixed = !byPercent.on && refs.some((ref) => ref.perUnit);
    const percentOff =
      byPercent.refusal ??
      (!byPercent.on && !byPercent.next
        ? 'A pin cannot be drawn as % of range; choose Own unit to make them uniform.'
        : undefined);
    return new Map<string, SwitchControl>([
      [
        'selected.Case',
        {
          options: [
            ...(byCase.caseId === '' && byCase.cases.length > 0 ? [mixedOption] : []),
            ...valid(
              byCase.cases.map((option) => ({
                value: option.id,
                label: option.blocked ? `${option.label} (${option.blocked})` : option.label,
                ...(option.blocked ? { disabled: option.blocked } : {}),
              })),
            ),
          ],
          value: byCase.caseId,
          ...(byCase.refusal !== undefined ? { refusal: byCase.refusal } : {}),
          title: byCase.refusal ?? `Switch ${whom} to this Case`,
          onChange: (caseId) => {
            if (caseId !== '') on.case(caseId);
          },
        },
      ],
      [
        'selected.Variable',
        {
          options: [
            ...(byVariable.variable === '' && byVariable.variables.length > 0 ? [mixedOption] : []),
            ...byVariable.variables.map((variable) => ({ value: variable, label: variable })),
          ],
          value: byVariable.variable,
          ...(byVariable.refusal !== undefined ? { refusal: byVariable.refusal } : {}),
          title: byVariable.refusal ?? `Switch ${whom} to this variable`,
          onChange: (variable) => {
            if (variable !== '') on.variable(variable);
          },
        },
      ],
      [
        'selected.Unit',
        {
          options: valid([
            { value: 'own', label: 'Own unit' },
            { value: 'pct', label: '% of range', ...(percentOff ? { disabled: percentOff } : {}) },
            ...(percentMixed
              ? [{ value: 'mixed', label: 'Mixed', disabled: 'Pick one for every pin' }]
              : []),
          ]),
          value: byPercent.on ? 'pct' : percentMixed ? 'mixed' : 'own',
          ...(refs.length === 0 ? { refusal: 'Pin a series to switch it to % of range.' } : {}),
          title:
            refs.length === 0
              ? 'Pin a series to switch it to % of range.'
              : row
                ? (percentOff ?? 'Show this series as a % of its limit, else of its own peak')
                : 'Show every pin as a % of its limit, else of its own peak, or in its own unit',
          onChange: (value) => {
            if (value === 'pct' || value === 'own') on.percent(value === 'pct');
          },
        },
      ],
    ]);
  }

  /** The "Switch all" row: one control above each column it rewrites. */
  function switches(refs: readonly BrowseRowRef[]): ReadonlyMap<string, SwitchControl> {
    return switchControls(
      refs,
      {
        case: latest.selectedCase(),
        variable: latest.selectedVariable(),
        percent: latest.selectedPercent(),
      },
      false,
      {
        case: (caseId) => handlers.onSelectedCaseChange(caseId),
        variable: (variable) => handlers.onSelectedVariableChange(variable),
        percent: (on) => handlers.onSelectedPercent(on),
      },
    );
  }

  /** One row's own controls, by column key, for the Selected tab's cells. */
  function rowSwitches(
    refs: readonly BrowseRowRef[],
  ): ReadonlyMap<string, (row: number) => SwitchControl | undefined> {
    const memo = new Map<number, Map<string, SwitchControl>>();
    const at = (row: number): Map<string, SwitchControl> => {
      let held = memo.get(row);
      if (!held) {
        const id = refs[row].id;
        held = switchControls([refs[row]], latest.selectedRow(id), true, {
          case: (caseId) => handlers.onSelectedRowChange(id, 'case', caseId),
          variable: (variable) => handlers.onSelectedRowChange(id, 'variable', variable),
          percent: (on) => handlers.onSelectedRowChange(id, 'unit', on ? 'pct' : 'own'),
        });
        memo.set(row, held);
      }
      return held;
    };
    return new Map(
      ['selected.Case', 'selected.Variable', 'selected.Unit'].map((key) => [
        key,
        (row: number) => (refs[row] ? at(row).get(key) : undefined),
      ]),
    );
  }

  /** What a slicer lists: the tab's ungrouped form, where its filters are
   * evaluated (`keptRowKeys`), or the Selected tab itself. With the drawer
   * closed only a tab already built is read: closing it must never cost a
   * ranking pass. */
  function slicedTab(tabId: string, open = true): BrowseTab | undefined {
    if (tabId === SELECTED) return open ? (selectedTab ?? selectedNow()) : undefined;
    if (open) return ungroupedTabFor(tabId);
    return built.get(keyOf(tabId, null, puOf(sourceOf(tabId))))?.tab;
  }

  const slicerPane = createSlicerPane(slicerMount);

  function paintSlicers(open: boolean): void {
    const tabId = activeId;
    // Pins can outlive their tables, and Selected still lists them.
    const nothing = latest.tabs.length === 0 && tabId !== SELECTED;
    const tab = nothing ? undefined : slicedTab(tabId, open);
    const why = nothing ? 'Nothing loaded yet.' : 'Open the Browse drawer to slice its tables.';
    slicerPane.paint(
      tab,
      viewOf(tabId),
      {
        filter(key, filter) {
          const view = viewOf(tabId);
          const next = new Map(view.filters);
          if (filter === null) next.delete(key);
          else next.set(key, filter);
          setView(tabId, { ...view, filters: next });
        },
        unslice(key) {
          if (tab) setView(tabId, setSliced(tab, viewOf(tabId), key, false));
        },
      },
      why,
    );
  }

  const popovers = createBrowsePopovers({
    root,
    columnsButton,
    browseScroll,
    viewOf,
    setView,
    activeId: () => activeId,
    activeTab,
    slicers: {
      isSliced(tabId, key) {
        const tab = slicedTab(tabId);
        return tab !== undefined && isSliced(tab, viewOf(tabId), key);
      },
      setSliced(tabId, key, on) {
        const tab = slicedTab(tabId);
        if (tab) setView(tabId, setSliced(tab, viewOf(tabId), key, on));
      },
    },
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
    get notDrawn() {
      return notDrawn;
    },
    view: () => viewOf(activeId),
    setView: (next) => setView(activeId, next),
    toggleFilterPopover: popovers.toggleFilterPopover,
    onSelectionChange: (pinned, previewed) => handlers.onSelectionChange(pinned, previewed),
  });

  function draw(): void {
    renderTabs(latest.tabs);
    // Closed, only the handle paints, and its pin count comes from memory:
    // closing the drawer must never cost a ranking pass.
    const pinned = selection.list().length;
    handleLabel.textContent = pinned > 0 ? `Browse · ${pinned}` : 'Browse';
    notDrawn = notDrawnIds();
    selectedTab = undefined;
    const detent = height.detent();
    if (detent === 'closed') {
      paintSlicers(false);
      return;
    }
    // Built once, before the slicers, which read the same build.
    const tab = activeTab();
    paintSlicers(true);
    if (!tab) {
      grid.clear();
      // No kind to pick a variable of, and a mode set now would greet the
      // first load unasked.
      variableField.hidden = true;
      perUnitToggle.hidden = true;
      notesLine.textContent = 'Nothing loaded yet. Drop a GridView export to browse it.';
      notesLine.hidden = false;
      actionsContainer.replaceChildren();
      chipsContainer.replaceChildren();
      notesRow.hidden = false;
      countLine.textContent = '';
      return;
    }

    // The variables loaded for this kind. The Selected tab's switches sit
    // in its header instead.
    const onSelected = activeId === SELECTED;
    variableField.hidden = onSelected;
    perUnitToggle.hidden = onSelected;
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

    if (!onSelected) {
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

  /** The host's render repaints the drawer (`onSelectionChange`). */
  function adoptPins(entries: readonly SelectionEntry[]): void {
    selection.restore(entries);
    handlers.onSelectionChange(selection.list(), selection.previewed());
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
    replacePins(entries, rescaled) {
      if (rescaled) replaceView(SELECTED, dropRescaledBounds);
      adoptPins(entries);
    },
    activeTabId: () => activeId,
    filteredRows(tabId) {
      // The UNGROUPED form holds the filtered columns; built on demand and
      // cached as a visit would.
      const base = ungroupedTabFor(tabId);
      if (base === undefined) return undefined;
      const view = viewOf(tabId);
      if (!hasActiveFilter(base, view)) return undefined;
      return Array.from(visibleRows(base, view), (row) => base.rows[row]);
    },
    setPerUnit: applyPerUnit,
    detent: height.detent,
    setDetent: height.setDetent,
    heightPx: height.heightPx,
    restoreHeight: height.restoreHeight,
  };
}
