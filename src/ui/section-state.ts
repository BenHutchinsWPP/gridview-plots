// src/ui/section-state.ts
//
// One KIND's retained-column state, with no DOM. Despite the name it is per
// kind, not per mounted section: which columns a drop keeps is decided on
// every drop, whatever is on screen. It outlives visibility, so hiding and
// showing never reset the user's choice.
//
// It reads only its OWN kind's tables: a gate reading a cross-kind case list
// would let another kind's drop or removal decide this kind's picker.
// Tested under Node (`tests/test_section_state.mjs`).

import type { CaseStore, TableKind } from '../model/case-model';

/**
 * One kind's state. `retainedColumns` is what its tables were built with;
 * `null` means none loaded (or the last one went), so the next drop asks.
 * Tables carry their own axes, so reusing the choice is a convenience, and
 * `covers` stops it when a drop brings a column never offered.
 */
export interface SectionState {
  readonly kind: TableKind;
  /** Only `setRetained` writes it. */
  readonly retainedColumns: string[] | null;
  /** Every column the picker OFFERED, ticked or not: what a later drop is
   * measured against. A declined column is a decision; a never-shown one
   * reopens the picker. */
  readonly offeredColumns: string[] | null;
  /** `null` records a cancelled picker (the next drop asks again). `offered`
   * is the union the choice was made from. */
  setRetained(columns: string[] | null, offered?: readonly string[]): void;
  /** Whether every column in `union` has been offered already. False when
   * nothing is stored. */
  covers(union: readonly string[]): boolean;
  /** Re-read the store: clears the choice iff THIS kind has no tables left
   * (removing an Area table must not reset the interface choice). */
  noteTablesChanged(store: CaseStore): void;
}

export function createSectionState(kind: TableKind): SectionState {
  let retainedColumns: string[] | null = null;
  let offered: Set<string> | null = null;
  return {
    kind,
    get retainedColumns(): string[] | null {
      return retainedColumns;
    },
    get offeredColumns(): string[] | null {
      return offered === null ? null : [...offered];
    },
    setRetained(columns: string[] | null, offeredNow?: readonly string[]): void {
      retainedColumns = columns;
      if (columns === null) offered = null;
      // Accumulates: a column offered once and declined stays decided.
      else if (offeredNow !== undefined)
        offered = new Set([...(offered ?? []), ...offeredNow, ...columns]);
    },
    covers(union: readonly string[]): boolean {
      const seen = offered;
      if (retainedColumns === null || seen === null) return false;
      return union.every((id) => seen.has(id));
    },
    noteTablesChanged(store: CaseStore): void {
      if (store.tablesOfKind(kind).length === 0) {
        retainedColumns = null;
        offered = null;
      }
    },
  };
}
