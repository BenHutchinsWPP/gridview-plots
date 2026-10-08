// src/ui/filter-rail.ts
//
// The section's hour-filter rail: the year chips, the date strip, the
// hour/day/season/TOU chips, each filter's clear, "Clear all filters" and the collapsed Filters
// title naming what is on.
//
// **The rail is the app's, not a kind's.** Its filters scope every kind's
// browse tab and every pane, so nothing here may read a table or hide when
// one kind has none: a bus-only study still needs its hours filtered.
//
// **The year chips are the loaded years**, so the group shows only when there
// are two to choose between. A chosen year that stops being loaded is
// dropped by the caller (`yearsStillLoaded`), not here: the rail holds no
// filter state.

import { DAY_NAMES, SEASON_NAMES, TOU_LABELS, type YearSpan } from '../model/calendar';
import type { Filters } from '../model/types';
import { createChipGrid } from './chips';
import { createDateStrip } from './date-strip';
import { within } from './dom';

export interface FilterRail {
  /** `spans`: the loaded Cases' spans, for the date strip. `years`: every
   * year they cover, ascending, for the year chips. */
  render(
    query: { readonly filters: Filters },
    spans: readonly YearSpan[],
    years: readonly number[],
  ): void;
  /** Clear every filter at once, as "Clear all filters" and the `r` key do. */
  reset(): void;
}

/** Each filter by its rail label, in rail order, for the collapsed title. */
const FILTER_NAMES: Record<keyof Filters, string> = {
  years: 'Years',
  dates: 'Dates',
  hoursOfDay: 'Hour',
  daysOfWeek: 'Day',
  seasons: 'Season',
  tou: 'TOU',
};

/** Wire the rail inside `root` (one section clone). Called once per page. */
export function createFilterRail(
  root: HTMLElement,
  onFiltersChange: (patch: Partial<Filters>) => void,
): FilterRail {
  const yearGroup = within(root, '[data-el="year-group"]');
  const yearChips = createChipGrid<number>(within(root, '[data-el="year-chips"]'), [], (next) =>
    onFiltersChange({ years: next }),
  );
  const dateStrip = createDateStrip(within(root, '[data-el="date-strip"]'), (dates) =>
    onFiltersChange({ dates }),
  );
  const hourChips = createChipGrid(
    within(root, '[data-el="hour-chips"]'),
    Array.from({ length: 24 }, (_, i) => ({ value: i + 1, label: String(i + 1) })),
    (next) => onFiltersChange({ hoursOfDay: next }),
  );
  const dayChips = createChipGrid(
    within(root, '[data-el="day-chips"]'),
    DAY_NAMES.map((label, index) => ({ value: index, label })),
    (next) => onFiltersChange({ daysOfWeek: next }),
  );
  const seasonChips = createChipGrid(
    within(root, '[data-el="season-chips"]'),
    SEASON_NAMES.map((name) => ({ value: name as string, label: name })),
    (next) => onFiltersChange({ seasons: next }),
  );
  const touChips = createChipGrid(
    within(root, '[data-el="tou-chips"]'),
    TOU_LABELS.map((name) => ({ value: name as string, label: name })),
    (next) => onFiltersChange({ tou: next }),
  );

  function reset(): void {
    onFiltersChange({
      years: null,
      dates: null,
      hoursOfDay: null,
      daysOfWeek: null,
      seasons: null,
      tou: null,
    });
  }

  within(root, '[data-el="reset-filters-btn"]').addEventListener('click', reset);

  // Per-filter clear, one delegated listener. Clearing commits the same null
  // "no constraint" a full chip selection does (src/model/types.ts).
  const filtersSection = within(root, '[data-el="filters-section"]');
  const filtersOn = within(root, '[data-el="filters-on"]');
  filtersSection.addEventListener('click', (event) => {
    const key = (event.target as HTMLElement).closest<HTMLElement>('.filter-clear')?.dataset.filter;
    if (key) onFiltersChange({ [key]: null } as Partial<Filters>);
  });

  return {
    reset,
    render(query, spans, years) {
      yearGroup.hidden = years.length <= 1;
      yearChips.render(
        query.filters.years,
        years.map((year) => ({ value: year, label: String(year) })),
      );
      dateStrip.render(query.filters.dates, spans, query.filters.years);
      hourChips.render(query.filters.hoursOfDay);
      dayChips.render(query.filters.daysOfWeek);
      seasonChips.render(query.filters.seasons);
      touChips.render(query.filters.tou);
      for (const button of filtersSection.querySelectorAll<HTMLButtonElement>('.filter-clear')) {
        button.disabled = query.filters[button.dataset.filter as keyof Filters] === null;
      }
      const on = (Object.keys(FILTER_NAMES) as (keyof Filters)[])
        .filter((key) => query.filters[key] !== null)
        .map((key) => FILTER_NAMES[key]);
      filtersOn.textContent = on.length === 0 ? '' : `· ${on.join(', ')}`;
    },
  };
}
