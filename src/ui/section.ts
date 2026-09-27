// src/ui/section.ts
//
// Mounts the app's one section: the filter rail, pane focus and the four
// chart panes, in one clone of `#section-template`. Every kind draws into it,
// so nothing here is a kind's; the root hands in the one kind fact the
// template needs (the box plot's entity dimension).
//
// **The section is shown whenever ANY case is loaded**, and its hour filters
// scope every kind's browse tab. Anything added here that hides without an
// Area table, or a render path that reads one, would take the whole app's
// filters down for a bus-only study.

import type { DateSet } from '../model/date-range';
import type { Filters } from '../model/types';
import type { FigureCapture } from '../figure/build';
import { within } from './dom';
import { createFilterRail, type FilterRail } from './filter-rail';
import { mountPaneFocus } from './pane-focus';
import { createCharts, type Charts } from './charts';

/** The rail and the four panes, driven by main.ts's one render path. */
export interface SectionHandle {
  rail: FilterRail;
  charts: Charts;
}

/**
 * Mount the section into `root` (its own template clone). Called ONCE per
 * page load: hidden, never unmounted, so hiding and showing never drops the
 * focused pane or the chips. It never touches the global chrome, which
 * `createChrome` owns; wiring it twice would double every Save and drop.
 */
export function mountSection(
  root: HTMLElement,
  handlers: {
    /** The box plot's entity dimension, offered in every pane beside Case. */
    entityDim: string;
    onFiltersChange(patch: Partial<Filters>): void;
    onBoxDimChange(pane: number, dim: string): void;
    onFigure(capture: FigureCapture, shown: { wholeYear: boolean }): void;
    onDatesChange(dates: DateSet): void;
  },
): SectionHandle {
  root.className = 'gv-section';

  for (const hook of [
    '[data-el="box-dim-kind-1"]',
    '[data-el="box-dim-kind-2"]',
    '[data-el="box-dim-kind-3"]',
    '[data-el="box-dim-kind-4"]',
  ]) {
    const kindDim = within<HTMLOptionElement>(root, hook);
    kindDim.value = handlers.entityDim;
    kindDim.textContent = handlers.entityDim;
  }

  const rail = createFilterRail(root, handlers.onFiltersChange);
  mountPaneFocus(root, rail.reset);

  return {
    rail,
    charts: createCharts(root, handlers.onBoxDimChange, {
      onFigure: handlers.onFigure,
      onDatesChange: handlers.onDatesChange,
    }),
  };
}
