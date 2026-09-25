// src/limits/types.ts
//
// Interface limits: the MIN/MAX schedule a monitored path is operated to, not
// a simulation result.
//
// WHY THIS IS NOT UNDER src/tables/. A limit is not a table KIND. It has no
// hourly cube, no wasm block, no browse tab, no section, no box plot and no
// slot variant, so every capability `src/tables/registry.ts` dispatches on is
// one a limit does not have. `TableKind` therefore does NOT grow a fifth
// member -- the same argument `src/lookups/types.ts` makes, reached from the
// same direction.
//
// WHERE IT DIFFERS FROM A LOOKUP, and the reason this is a separate directory
// rather than a third variant of one: a reference list deliberately OUTLIVES
// the case whose drop it arrived with, because it describes the network. A
// limit schedule may describe ONE RUN -- the analyst's second story is several
// scenarios with different path limits each -- so a per-case limit must die
// with its case. See `store.ts`, which holds both halves for that reason.
//
// Twelve values, never 8,760. The expansion to hours belongs to whatever
// draws the line, because only the pane knows the case's calendar year; a
// store that expanded eagerly would be guessing it.

/** Which side of the band a row carries. Read off the row's own cells by
 * VALUE (see `parse.ts`), never from a header name or a column position. */
export type LimitSide = 'min' | 'max';

/**
 * One interface's limits: twelve monthly values per side, January first.
 *
 * `NaN` means NO LIMIT in that month -- either the cell carried the sentinel
 * (`parse.ts`) or it was blank. A side missing entirely means the file had no
 * row for it, which is legal and common: a path may be limited in one
 * direction only.
 */
export interface InterfaceLimit {
  readonly min?: Float32Array;
  readonly max?: Float32Array;
}

/** One parsed limits file. `source` is the filename, kept for the load note
 * and for the envelope -- a limit the user cannot trace to a file is a number
 * they cannot check. */
export interface LimitTable {
  readonly source: string;
  readonly byInterface: ReadonlyMap<string, InterfaceLimit>;
}

/** Months in a limits row, and so the length of every array above. */
export const MONTHS_PER_YEAR = 12;
