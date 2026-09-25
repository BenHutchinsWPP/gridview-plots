// src/series/pool.ts
//
// The buffers a drawn line owns, held one set per line and reused across every
// interaction.
//
// **One set per LINE, never per case or per table.** `values` and `sorted` on
// the returned `CaseSeries` are views of these, so two lines sharing one set
// means the second overwrites the first's chart data with nothing thrown and a
// plausible chart at the end of it. That is why the key a caller builds has to
// separate everything that can differ: the Case, the SLOT it sits in, and the
// subject. The slot and not the quantity, because a file whose title line was
// unreadable lands in a slot with no variant while its table still carries a
// quantity, and the two strings are usually equal without being guaranteed to.
//
// Allocating a scratch array inside a render path is how the cost of a sort
// gets multiplied for no reason, which is what this pool exists to avoid.
//
// **Held only while drawn.** A key carries the quantity and "% of range", so
// switching pins through variables mints a new set per step; without `sweep`
// every set ever drawn stays held until its Case goes.

import { createSeriesBuffers, type SeriesBuffers } from './model';

/** NUL-separated, for the reason `specId` is: an entity name may contain a
 * space, so `case-1 gas 2` must not be able to mean two different things. */
const SEP = '\u0000';

export interface SeriesPool {
  /** The buffers for one line, allocated on first ask. `parts` are joined into
   * the key, so the caller decides what makes two lines different. */
  for(...parts: (string | number)[]): SeriesBuffers;
  /** Every buffer belonging to one table, dropped when that table is. */
  dropSlot(caseId: string, slotKey: string): void;
  /** Every buffer belonging to one Case, whatever slot it sat in. */
  dropCase(caseId: string): void;
  /** Drop every buffer not asked for since the last sweep. Called once the
   * whole drawn set has been resolved, so what survives is what is drawn. */
  sweep(): void;
}

export function createSeriesPool(): SeriesPool {
  const held = new Map<string, SeriesBuffers>();
  const asked = new Set<string>();
  const dropPrefix = (prefix: string): void => {
    for (const id of held.keys()) if (id.startsWith(prefix)) held.delete(id);
  };
  return {
    for(...parts) {
      const id = parts.join(SEP);
      asked.add(id);
      let existing = held.get(id);
      if (!existing) {
        existing = createSeriesBuffers();
        held.set(id, existing);
      }
      return existing;
    },
    dropSlot(caseId, slotKey) {
      dropPrefix(`${caseId}${SEP}${slotKey}${SEP}`);
    },
    dropCase(caseId) {
      dropPrefix(`${caseId}${SEP}`);
    },
    sweep() {
      for (const id of held.keys()) if (!asked.has(id)) held.delete(id);
      asked.clear();
    },
  };
}

/**
 * A pool of ONE buffer set, handed to every caller and never swept: for an
 * export, which resolves a series, reads it, and resolves the next. An export
 * never borrows the drawn pool: its keys would hold a set per exported row
 * until the next sweep, and a sweep after an export-only resolve would free
 * every drawn line.
 */
export function createScratchPool(): SeriesPool {
  const only = createSeriesBuffers();
  return {
    for: () => only,
    dropSlot() {},
    dropCase() {},
    sweep() {},
  };
}
