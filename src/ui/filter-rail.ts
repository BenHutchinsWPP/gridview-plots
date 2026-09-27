// src/ui/filter-rail.ts
//
// The section's hour-filter rail: the date strip, the hour/day/season/TOU
// chips, each filter's clear, "Clear all filters" and the collapsed Filters
// title naming what is on.
//
// **The rail is the app's, not a kind's.** Its filters scope every kind's
// browse tab and every pane, so nothing here may read a table or hide when
// one kind has none: a bus-only study still needs its hours filtered.

import { DAY_NAMES, SEASON_NAMES, TOU_LABELS } from '../model/calendar';
import type { Filters } from '../model/types';
import { createChipGrid } from './chips';
import { createDateStrip } from './date-strip';
import { within } from './dom';

export interface FilterRail {
  /** `years`: the loaded Cases' distinct years, for the date strip. */
  render(query: { readonly filters: Filters }, years: readonly number[]): void;
  /** Clear every filter at once, as "Clear all filters" and the `r` key do. */
  reset(): void;
}

/** Each filter by its rail label, in rail order, for the collapsed title. */
const FILTER_NAMES: Record<keyof Filters, string> = {
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
    render(query, years) {
      dateStrip.render(query.filters.dates, years);
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
