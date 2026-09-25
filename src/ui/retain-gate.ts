// src/ui/retain-gate.ts
//
// The gate in front of a kind's column picker: whether to ask, what was
// answered, and forgetting it when the kind's last table goes. Clearing on
// the path every drop takes (not through a mounted section) is why it is its
// own module: otherwise a kind with no section would keep a stale set and
// silently reuse it. Kind-neutral; the kind supplies `ask`.
//
// The Import Dialog's "Load everything" is spent here (the same question as
// `covers`, asked earlier); pricing it stays in the kind's picker.

import type { CaseStore, TableKind } from '../model/case-model';
import { createSectionState, type SectionState } from './section-state';
import type { RetainedBatch } from './shell';

/** What a kind's gate is asked, once per batch. `store` is passed so the
 * table count is read at the moment of the drop. */
export interface RetainGate {
  resolveRetained(store: CaseStore, batch: RetainedBatch): Promise<string[] | null>;
}

/** Ask which columns to keep, given the kind's state (kinds preselect
 * differently). `null` is a cancel, not an empty selection. */
export type RetainAsk = (batch: RetainedBatch, state: SectionState) => Promise<string[] | null>;

/** What a WIDENING drop opens ticked with: everything retained plus every
 * entity never offered (the retained set alone would re-tick a removed one).
 * `firstDrop` is the caller's, since kinds differ on the first drop. */
export function widenedPreselection<T>(
  batch: RetainedBatch,
  state: SectionState,
  firstDrop: T,
): string[] | T {
  const known = state.retainedColumns;
  if (known === null) return firstDrop;
  const offered = new Set(state.offeredColumns ?? []);
  const keep = new Set(known);
  return batch.union.filter((name) => keep.has(name) || !offered.has(name));
}

export function createRetainGate(kind: TableKind, ask: RetainAsk): RetainGate {
  const state = createSectionState(kind);
  return {
    async resolveRetained(store, batch) {
      state.noteTablesChanged(store);
      // `everything` BEFORE `covers`: an "everything" drop after an earlier
      // narrow one IS covered by it, and testing coverage first would reuse the
      // narrow set silently. It still goes through `ask`, because every picker
      // prices keeping everything (asserted in tests/test_dom_contract.mjs).
      if (!batch.everything && state.covers(batch.union)) return state.retainedColumns;
      const chosen = await ask(batch, state);
      // Recorded even when null: a cancelled picker means the next drop asks.
      state.setRetained(chosen, batch.union);
      return chosen;
    },
  };
}
