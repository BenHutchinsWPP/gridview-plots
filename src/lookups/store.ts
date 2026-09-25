// src/lookups/store.ts
//
// The session's reference lists: one per variant, session-wide.
//
// WHY A MODULE-LEVEL STORE AND NOT A CASE SLOT. A Case slot would inherit
// `attachTable`, the slot map and the manifest path for free, and would be
// wrong four times over:
//
//   * a list dropped on its own would have to invent a phantom Case to live in;
//   * it would die with the last hourly table detached from the case it
//     arrived with;
//   * `adoptRestoredCases` removes every previously loaded case on Load, and
//     would take the list with it;
//   * a fallback reading one vintage's network for another case's tables is a
//     cross-database join with nothing to say so.
//
// So the store is here, beside `groupings`, and the Case lifecycle cannot
// reach it. Removing a case does not touch it; restoring a bundle replaces it
// only when that bundle carried one.
//
// It is deliberately tiny: a Map, a merge, and the note the merge produced.
// Everything hard is in merge.ts.

import { mergeLookup, type MergeResult } from './merge';
import type { LookupRows } from './parse';
import type { LookupTable, LookupVariant } from './types';
import { VARIANT_OF } from './types';

const lists = new Map<LookupVariant, LookupTable>();

export function lookupFor(variant: LookupVariant): LookupTable | undefined {
  return lists.get(variant);
}

export function allLookups(): ReadonlyMap<LookupVariant, LookupTable> {
  return lists;
}

/** Every file that has contributed to any loaded list, for the UI's
 * "attributes from BusList.csv + GeneratorList.csv, not case-specific" line.
 * The union's provenance is the only thing standing between a user and a
 * cross-database join, so it is never summarised down to a count. */
export function lookupSources(): string[] {
  const sources: string[] = [];
  for (const table of lists.values()) {
    for (const source of table.sources) if (!sources.includes(source)) sources.push(source);
  }
  return sources;
}

/** Attach a parsed file, merging it into the list of its variant. Returns the
 * merge's counts so the caller can write the ingest note. */
export function attachLookup(rows: LookupRows): MergeResult {
  const variant = VARIANT_OF[rows.entity];
  const result = mergeLookup(lists.get(variant), rows);
  lists.set(variant, result.table);
  return result;
}

/** Restore from a bundle, replacing whatever the session held for that
 * variant. A saved list is the state the user saved, not something to merge
 * the current session into. */
export function adoptLookups(restored: Iterable<[LookupVariant, LookupTable]>): void {
  for (const [variant, table] of restored) lists.set(variant, table);
}

/** Tests only: the store is session state and nothing in the app clears it --
 * a list outliving every case is the point. */
export function clearLookups(): void {
  lists.clear();
}

/** The ingest note for one merged file. One sentence, counts only, and it
 * names the discards rather than hiding them. */
export function mergeNote(filename: string, result: MergeResult): string {
  const parts = [`${filename}: ${result.added.toLocaleString()} row(s) added`];
  if (result.alreadyKnown > 0) {
    parts.push(
      `${result.alreadyKnown.toLocaleString()} key(s) already known` +
        (result.differing > 0
          ? `, ${result.differing.toLocaleString()} with differing values (kept first)`
          : ''),
    );
  }
  return `${parts.join(', ')}. ${result.table.rowCount.toLocaleString()} row(s) in the ${result.table.entity} list.`;
}
