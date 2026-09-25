// src/model/types.ts
//
// Model types no kind owns. A type moves here only when a second kind needs
// it; promoting one early spreads one kind's vocabulary to all.

/** Hour filters over the calendar; `null` means no constraint, a fast path
 * in `buildMask`. */
export interface Filters {
  readonly months: Set<number> | null; // 1-12
  readonly daysOfMonth: Set<number> | null; // 1-31
  readonly hoursOfDay: Set<number> | null; // 1-24, hour-ending (HE)
  readonly daysOfWeek: Set<number> | null; // 0-6, 0 = Monday .. 6 = Sunday
  readonly seasons: Set<string> | null; // 'Winter' | 'Spring' | 'Summer' | 'Fall'
  readonly tou: Set<string> | null; // e.g. 'OnPeak' | 'OffPeak' -- read from file data, never derived
}

/** 'grid' shows the 2x2 layout; 1-4 focuses a pane (keys `1`-`4`, `Esc` back).
 * Not part of a query: focus is layout only, and the panes resize themselves. */
export type PaneView = 'grid' | 1 | 2 | 3 | 4;

/**
 * Hours a table's own input files covered (1 = covered): what a later drop
 * into the slot is gated on. `TouCodes` cannot stand in (a blank TOU field
 * reads as uncovered). `undefined` means UNKNOWN (older bundles), never a
 * year of absence.
 */
export type HoursPresent = Uint8Array;

/** Per-hour TOU code (8,760, indexing TOU_LABELS), read from the file, never
 * derived: tariff calendars are the utility's. */
export type TouCodes = Uint8Array;

/**
 * One drawn series from a kind. `values` is null exactly when REFUSED, and
 * `refusal` says why, shown where the chart would be. `warnings` are
 * non-fatal. Kinds extend it (Area adds its rule and weights) but never read
 * each other's.
 */
export interface SeriesResult {
  values: Float32Array | null;
  refusal?: string;
  warnings: string[];
}
