// src/tables/area/ui/section.ts
//
// The one mounted section: the hour-filter rail, the four-pane grid, focus
// mode and the keyboard handler. It lives under Area because two things it
// needs are Area's rules: the unit-to-scale mapping (`CHART_HOOKS`) and the
// box plot's area dimension.
//
// **What it holds is the app's, not Area's, and that is the footgun.** It is
// shown whenever ANY case is loaded, and its hour filters scope every kind's
// browse tab. A control that hides without an Area table, or a render path
// that reads one, would take the whole app's filters down for a bus-only
// study.
//
// Every element is resolved with `within(root, …)`: sections are clones of
// one template, and a global id lookup works until a second one mounts,
// which is what lets the mistake survive review.

import {
  DAY_NAMES,
  HOURS_PER_YEAR,
  MONTH_NAMES,
  SEASON_NAMES,
  TOU_LABELS,
} from '../../../model/calendar';
import type { Filters, PaneView } from '../../../model/types';
import type { AreaQuery, BoxDim } from '../types';
import { scaleOf, scalesOf } from '../rules';
import { createChipGrid } from '../../../ui/chips';
import { within } from '../../../ui/dom';
import { registerKeys } from '../../../ui/shell';
import { createCharts, type Charts, type ChartsHooks, type SlotType } from '../../../ui/charts';
import type { FigureCapture } from '../../../figure/build';

export interface AreaSectionHandlers {
  onFiltersChange(patch: Partial<Filters>): void;
}

export interface AreaSection {
  render(query: AreaQuery): void;
}

/** The four pane hooks, spelled out (see src/ui/charts.ts). */
const PANE_HOOKS = ['[data-pane="1"]', '[data-pane="2"]', '[data-pane="3"]', '[data-pane="4"]'];

/** Collapse a selection into runs: {1,2,3,7} over Jan..Dec -> "Jan–Mar, Jul". */
function summarise<T>(
  selection: ReadonlySet<T> | null,
  ordered: readonly T[],
  label: (value: T) => string,
  everything: string,
): string {
  if (selection === null || selection.size === ordered.length) return everything;
  if (selection.size === 0) return 'nothing';

  const indices = ordered
    .map((value, index) => (selection.has(value) ? index : -1))
    .filter((i) => i >= 0);
  const parts: string[] = [];
  let start = indices[0];
  let previous = indices[0];
  for (let i = 1; i <= indices.length; i++) {
    const current = indices[i];
    if (current === previous + 1) {
      previous = current;
      continue;
    }
    parts.push(
      start === previous
        ? label(ordered[start])
        : `${label(ordered[start])}–${label(ordered[previous])}`,
    );
    start = current;
    previous = current;
  }
  return parts.join(', ');
}

/** The status bar is a sentence, not a widget: analysts screenshot panes into
 * decks, and a screenshot that states its own filters cannot be misread. */
export function statusSentence(query: AreaQuery, keptHours: number): string {
  const { filters } = query;
  const months = Array.from({ length: 12 }, (_, i) => i + 1);
  const hours = Array.from({ length: 24 }, (_, i) => i + 1);
  const days = Array.from({ length: 7 }, (_, i) => i);

  const parts = [
    `${keptHours.toLocaleString()} of ${HOURS_PER_YEAR.toLocaleString()} h`,
    summarise(filters.months, months, (m) => MONTH_NAMES[m - 1], 'all months'),
    summarise(filters.daysOfWeek, days, (d) => DAY_NAMES[d], 'all days'),
  ];
  if (filters.daysOfMonth !== null) {
    const daysOfMonth = Array.from({ length: 31 }, (_, i) => i + 1);
    parts.push(`day ${summarise(filters.daysOfMonth, daysOfMonth, String, 'all')}`);
  }
  if (filters.hoursOfDay !== null) {
    parts.push(`HE ${summarise(filters.hoursOfDay, hours, String, 'all')}`);
  }
  if (filters.seasons !== null) {
    parts.push(summarise(filters.seasons, SEASON_NAMES, String, 'all seasons'));
  }
  if (filters.tou !== null) {
    parts.push(summarise(filters.tou, TOU_LABELS, String, 'all TOU'));
  }
  const plural = query.cases.length === 1 ? '' : 's';
  parts.push(`${query.cases.length} case${plural}`);
  return parts.join(' · ');
}

/**
 * Mount the section into `root` (its own template clone). Called ONCE per
 * page load: hidden, never unmounted. It never touches the global chrome,
 * which `createChrome` owns; wiring it twice would double every Save and drop.
 */
function createAreaSection(root: HTMLElement, handlers: AreaSectionHandlers): AreaSection {
  root.className = 'gv-section gv-section-area';

  const chartArea = within(root, '[data-el="chart-area"]');

  // The box plot's kind-specific dimension, filled with this kind's axis.
  const kindDim = within<HTMLOptionElement>(root, '[data-el="box-dim-kind"]');
  kindDim.value = 'area';
  kindDim.textContent = 'area';

  // ------------------------------------------------------------ chip grids
  const monthChips = createChipGrid(
    within(root, '[data-el="month-chips"]'),
    MONTH_NAMES.map((label, index) => ({ value: index + 1, label })),
    (next) => handlers.onFiltersChange({ months: next }),
  );
  // 31 chips whatever the month; the 31st simply keeps fewer hours.
  const dayOfMonthChips = createChipGrid(
    within(root, '[data-el="day-of-month-chips"]'),
    Array.from({ length: 31 }, (_, i) => ({ value: i + 1, label: String(i + 1) })),
    (next) => handlers.onFiltersChange({ daysOfMonth: next }),
  );
  const hourChips = createChipGrid(
    within(root, '[data-el="hour-chips"]'),
    Array.from({ length: 24 }, (_, i) => ({ value: i + 1, label: String(i + 1) })),
    (next) => handlers.onFiltersChange({ hoursOfDay: next }),
  );
  const dayChips = createChipGrid(
    within(root, '[data-el="day-chips"]'),
    DAY_NAMES.map((label, index) => ({ value: index, label })),
    (next) => handlers.onFiltersChange({ daysOfWeek: next }),
  );
  const seasonChips = createChipGrid(
    within(root, '[data-el="season-chips"]'),
    SEASON_NAMES.map((name) => ({ value: name as string, label: name })),
    (next) => handlers.onFiltersChange({ seasons: next }),
  );
  const touChips = createChipGrid(
    within(root, '[data-el="tou-chips"]'),
    TOU_LABELS.map((name) => ({ value: name as string, label: name })),
    (next) => handlers.onFiltersChange({ tou: next }),
  );

  function resetFilters(): void {
    handlers.onFiltersChange({
      months: null,
      daysOfMonth: null,
      hoursOfDay: null,
      daysOfWeek: null,
      seasons: null,
      tou: null,
    });
  }

  within(root, '[data-el="reset-filters-btn"]').addEventListener('click', resetFilters);

  // Per-filter clear, one delegated listener. Clearing commits the same null
  // "no constraint" a full chip selection does (src/model/types.ts).
  const filtersSection = within(root, '[data-el="filters-section"]');
  filtersSection.addEventListener('click', (event) => {
    const key = (event.target as HTMLElement).closest<HTMLElement>('.filter-clear')?.dataset.filter;
    if (key) handlers.onFiltersChange({ [key]: null } as Partial<Filters>);
  });

  // ------------------------------------------------------------ focus mode
  let view: PaneView = 'grid';

  function setView(next: PaneView): void {
    view = next;
    chartArea.classList.toggle('focus-mode', next !== 'grid');
    for (let pane = 1; pane <= 4; pane++) {
      const focused = next === pane;
      const element = within(root, PANE_HOOKS[pane - 1]);
      element.classList.toggle('focused', focused);
      const icon = element.querySelector('.pane-icon');
      if (icon) {
        icon.textContent = focused ? '⤡' : '⤢';
        icon.setAttribute(
          'title',
          focused ? 'Back to the grid (or press Esc)' : `Expand this pane (or press ${pane})`,
        );
      }
    }
    // Layout only; charts.ts's ResizeObserver re-fits the panes.
  }

  for (let pane = 1; pane <= 4; pane++) {
    const header = within(root, PANE_HOOKS[pane - 1]).querySelector('.pane-header');
    const toggle = () => setView(view === pane ? 'grid' : (pane as PaneView));
    // The ⤢ acts on one click; double-clicking the header also works.
    header?.querySelector('.pane-icon')?.addEventListener('click', (event) => {
      event.stopPropagation();
      toggle();
    });
    header?.addEventListener('dblclick', toggle);
  }

  registerKeys({
    root,
    handle(event) {
      if (event.key >= '1' && event.key <= '4') {
        const pane = Number(event.key) as PaneView;
        setView(view === pane ? 'grid' : pane);
      } else if (event.key === 'Escape') {
        setView('grid');
      } else if (event.key === 'r') {
        resetFilters();
      }
    },
  });

  // ------------------------------------------------------------ render
  return {
    render(query) {
      monthChips.render(query.filters.months);
      dayOfMonthChips.render(query.filters.daysOfMonth);
      hourChips.render(query.filters.hoursOfDay);
      dayChips.render(query.filters.daysOfWeek);
      seasonChips.render(query.filters.seasons);
      touChips.render(query.filters.tou);
      for (const button of filtersSection.querySelectorAll<HTMLButtonElement>('.filter-clear')) {
        button.disabled = query.filters[button.dataset.filter as keyof Filters] === null;
      }
    },
  };
}

// ------------------------------------------------------------------ mount

/** The rail and the four panes, driven by main.ts's one render path. */
export interface AreaSectionHandle {
  rail: AreaSection;
  charts: Charts;
}

/**
 * What the four panes do differently for Area: its unit-to-scale rules.
 *
 * These hooks run over series of every kind (the drawer feeds all of them to
 * one section's panes), so nothing Area-shaped may live here.
 */
const CHART_HOOKS: ChartsHooks = { scaleOf, scalesOf };

/** The Area section as the registry sees it. State lives in this closure,
 * created once, so hiding and showing never drops the retained-column
 * choice. */
export function mountAreaSection(
  root: HTMLElement,
  handlers: AreaSectionHandlers & {
    onBoxDimChange(dim: BoxDim): void;
    initialLayout?: readonly SlotType[];
    onLayoutChange?: (layout: readonly SlotType[]) => void;
    onFigure?: (capture: FigureCapture) => void;
  },
): AreaSectionHandle {
  return {
    rail: createAreaSection(root, handlers),
    charts: createCharts(root, (dim) => handlers.onBoxDimChange(dim as BoxDim), CHART_HOOKS, {
      initialLayout: handlers.initialLayout,
      onLayoutChange: handlers.onLayoutChange,
      onFigure: handlers.onFigure,
    }),
  };
}
