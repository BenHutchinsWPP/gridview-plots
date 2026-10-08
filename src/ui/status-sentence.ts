// src/ui/status-sentence.ts
//
// The status bar's text. The status bar is a sentence, not a widget:
// analysts screenshot panes into decks, and a screenshot that states its own
// filters cannot be misread.
//
// Kept free of DOM and chart imports so it loads under Node and is tested as
// behaviour (tests/test_status_sentence.mjs).

import { DAY_NAMES, SEASON_NAMES, TOU_LABELS } from '../model/calendar';
import { setLabel } from '../model/date-range';
import type { Filters } from '../model/types';

/** Collapse a selection into runs: {1,2,3,7} over Jan..Dec -> "Jan–Mar, Jul". */
export function summarise<T>(
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

/** A Years filter as runs: {2035, 2036, 2038} -> "2035–2036, 2038". */
export function yearsLabel(years: ReadonlySet<number>): string {
  const sorted = [...years].sort((a, b) => a - b);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const every = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  return summarise(years, every, String, first === last ? String(first) : `${first}–${last}`);
}

/** What the sentence states: the hour filters and how many Cases they cut. */
export interface StatusView {
  readonly filters: Filters;
  readonly cases: readonly unknown[];
}

/** `keptHours` of `ofHours`: the caller's count and the real hours it was
 * counted out of, never the slot's length. The Years and dates filters shrink
 * the count and leave the whole: "8,784 of 26,304 h · 2036" is 2036 of a
 * three-year Case. */
export function statusSentence(view: StatusView, keptHours: number, ofHours: number): string {
  const { filters } = view;
  const hours = Array.from({ length: 24 }, (_, i) => i + 1);
  const days = Array.from({ length: 7 }, (_, i) => i);

  const parts = [
    `${keptHours.toLocaleString()} of ${ofHours.toLocaleString()} h`,
    ...(filters.years === null ? [] : [yearsLabel(filters.years)]),
    filters.dates === null ? 'all dates' : setLabel(filters.dates, 4),
    summarise(filters.daysOfWeek, days, (d) => DAY_NAMES[d], 'all days'),
  ];
  if (filters.hoursOfDay !== null) {
    parts.push(`HE ${summarise(filters.hoursOfDay, hours, String, 'all')}`);
  }
  if (filters.seasons !== null) {
    parts.push(summarise(filters.seasons, SEASON_NAMES, String, 'all seasons'));
  }
  if (filters.tou !== null) {
    parts.push(summarise(filters.tou, TOU_LABELS, String, 'all TOU'));
  }
  const plural = view.cases.length === 1 ? '' : 's';
  parts.push(`${view.cases.length} case${plural}`);
  return parts.join(' · ');
}
