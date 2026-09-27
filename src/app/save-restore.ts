// src/app/save-restore.ts
//
// Save every Case to a .gvmb and origin-private storage, and restore a bundle
// from either. The order is the point:
//
//   * a restore builds its new Cases before it removes an old one, and a
//     bundle with no readable table is refused with the study untouched;
//   * everything a bundle saved against a Case is re-keyed by its index onto
//     the Case the restore made (`made[i]` is from the i-th saved Case);
//   * the inventory is reconciled last, against every other input's adoption.
//
// BOTH restore paths (a dropped file and Load…) run `adoptSession`, so a rule
// added to one reaches the other. The view (pins, panes, drawer) and the group
// maps are the root's state, adopted through the host; this holds none.

import type { Inventory } from '../inventory/store';
import { LIMITS_COLUMN, SHARED_LIMITS_INPUT } from '../inventory/store';
import { restoreCaseLimits } from '../limits/envelope';
import type { LimitsStore } from '../limits/store';
import type { LookupTable, LookupVariant } from '../lookups/types';
import {
  slotKey,
  type CaseStore,
  type RestoredCase,
  type TableKind,
  type TableSlotKey,
} from '../model/case-model';
import type { BundleContents } from '../storage/envelope';
import { TABLE_KINDS } from '../tables/registry';
import {
  isAbort,
  isMissingBundle,
  type downloadBundle,
  type loadBundle,
  type readBundleFile,
  type RestoredBundle,
  type saveBundle,
} from '../storage/store';

/** Where Load… reads a bundle from, as the Contents Log names it. */
const OPFS_SOURCE = 'origin-private storage';

/** A bundle as a note names it mid-sentence and at its start. */
export interface BundleNamed {
  inline: string;
  start: string;
}

/** A Case a restore made, in bundle order. */
export interface MadeCase {
  id: string;
  name: string;
}

export interface SaveRestoreHost {
  cases: Pick<
    CaseStore,
    'listCases' | 'createCase' | 'attachTable' | 'removeCase' | 'setDisplayName'
  >;
  limits: Pick<LimitsStore, 'dropCaseLimits' | 'adoptLimits' | 'caseLimits'>;
  inventory: Pick<Inventory, 'restore' | 'logRefused' | 'logRefusedSource'>;
  storage: {
    downloadBundle: typeof downloadBundle;
    saveBundle: typeof saveBundle;
    readBundleFile: typeof readBundleFile;
    loadBundle: typeof loadBundle;
  };
  /** Rewrite one notes channel wholesale. */
  say(channel: 'session' | TableKind, lines: readonly string[]): void;
  setBusy(message: string | null): void;
  render(): void;
  closeContents(): void;
  /** Every drawn line's buffers for a Case that is gone. */
  dropCaseBuffers(caseId: string): void;
  /** What a bundle carries besides the Cases, read once per save. */
  contents(): BundleContents;
  /** Put the bundle's view back onto the Cases it made: axis, pins, panes. */
  restoreView(loaded: RestoredBundle, made: readonly MadeCase[]): void;
  /** Adopt the bundle's group maps, adding each input to `taken` once its
   * map is in effect, so a throw part-way leaves the landed ones taken.
   * Returns the notes. */
  adoptGroups(loaded: RestoredBundle, named: BundleNamed, taken: Set<string>): string[];
  adoptLookups(lookups: Map<LookupVariant, LookupTable>): void;
  /** The file names behind the session's reference lists. */
  lookupSources(): string[];
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createSaveRestore(host: SaveRestoreHost) {
  const { cases, limits, inventory } = host;

  /**
   * Replace every loaded Case with a bundle's, with every table.
   * Non-destructive by construction:
   *
   *   1. It runs only after the read SUCCEEDED.
   *   2. A bundle with no readable TABLE is refused, store untouched (unknown
   *      kinds still yield Cases, so a Case count is the wrong test).
   *   3. New Cases are built FIRST and old ones removed only once every table
   *      attached; a throw rolls the new ones back.
   *
   * Returns the Cases made in bundle order, or null when nothing was replaced.
   */
  function adoptRestoredCases(restored: readonly RestoredCase[]): { made: MadeCase[] } | null {
    const tableCount = restored.reduce((total, entry) => total + entry.tables.size, 0);
    if (tableCount === 0) return null;

    const previous = cases.listCases().map((entry) => entry.id);
    const made: MadeCase[] = [];
    try {
      for (const entry of restored) {
        const created = cases.createCase(entry.name);
        made.push({ id: created.id, name: created.name });
        // Every slot the bundle held, at the key it held it under, so every
        // table of one saved Case lands back on ONE Case. No replace: two
        // tables for one slot in a bundle is a refusal.
        for (const table of entry.tables.values()) {
          cases.attachTable(created.id, table.key, table.data);
        }
      }
    } catch (error) {
      for (const { id } of made) cases.removeCase(id);
      throw error;
    }
    // The replacement is complete. Per-case limits go with their old Cases, or
    // they would sit on ids the store no longer has. Drawn-line buffers are
    // keyed by Case id, and a restore hands out fresh ids.
    for (const id of previous) {
      cases.removeCase(id);
      limits.dropCaseLimits(id);
      host.dropCaseBuffers(id);
    }
    // Each kind channel is a drop's account of Cases that are gone now, and
    // neither caller republishes all four: Load… writes only `session`, and a
    // drop carrying nothing but a bundle writes only `area`.
    for (const kind of TABLE_KINDS) host.say(kind, []);
    return { made };
  }

  /**
   * The display names a bundle saved, onto the Cases the restore made. Run
   * after the old Cases are gone, whose names would otherwise refuse them. A
   * name the store refuses (a bundle naming two Cases alike) is left off and
   * said.
   */
  function adoptDisplayNames(
    restored: readonly RestoredCase[],
    made: readonly MadeCase[],
  ): string[] {
    const said: string[] = [];
    restored.forEach((entry, index) => {
      const target = made[index];
      if (entry.displayName === undefined || target === undefined) return;
      try {
        cases.setDisplayName(target.id, entry.displayName);
      } catch (error) {
        said.push(
          `Case "${entry.name}" is shown by its name: its saved display name ` +
            `"${entry.displayName}" was refused. ${messageOf(error)}`,
        );
      }
    });
    return said;
  }

  /** A bundle carrying no lists leaves the session's alone: that is an older
   * study, not an instruction to forget them. */
  function adoptLookups(lookups: Map<LookupVariant, LookupTable>, source: string): string[] {
    if (lookups.size === 0) return [];
    host.adoptLookups(lookups);
    return [
      `${source} carried ${[...lookups.values()]
        .map((table) => `${table.rowCount.toLocaleString()} ${table.entity} row(s)`)
        .join(' and ')}, from ${host.lookupSources().join(' + ')}.`,
    ];
  }

  /** The interface limits a bundle carried, onto the Cases the restore made.
   * A bundle carrying none leaves the session's limits alone. */
  function adoptLimits(
    saved: RestoredBundle['limits'],
    made: readonly MadeCase[],
    source: string,
  ): string[] {
    if (saved.shared === undefined && saved.byIndex.size === 0) return [];
    const remapped = restoreCaseLimits(saved.byIndex, made);
    const orphaned = saved.dropped + saved.byIndex.size - remapped.length;
    limits.adoptLimits(saved.shared, remapped);
    const parts: string[] = [];
    if (saved.shared !== undefined) parts.push(`shared limits from ${saved.shared.source}`);
    if (remapped.length > 0) parts.push(`limits pinned to ${remapped.length} case(s)`);
    return [
      `${source} carried ${parts.join(' and ')}.` +
        (orphaned > 0
          ? ` ${orphaned} case-specific limit table(s) named a Case the bundle no longer ` +
            `carries and were dropped.`
          : ''),
    ];
  }

  /**
   * Take up the bundle's inventory once every table and session input has
   * been adopted: whatever it listed that the restore did not take up is
   * logged `dropped at restore`. `taken` holds each group map as it landed,
   * since one kind can land and the next throw; the rest follow their
   * stores' rules unless their step failed (`landed`): carried lists are
   * adopted, and any limits block replaces the shared limits, even with none.
   */
  function adoptInventory(
    loaded: RestoredBundle,
    made: readonly MadeCase[],
    source: File | string,
    taken: ReadonlySet<string>,
    landed: { lists: boolean; limits: boolean },
  ): void {
    const adopted = new Set(taken);
    if (landed.lists) for (const variant of loaded.lookups.keys()) adopted.add(variant);
    if (landed.limits && (loaded.limits.shared !== undefined || loaded.limits.byIndex.size > 0)) {
      adopted.add(SHARED_LIMITS_INPUT);
    }
    const caseLimits = limits.caseLimits();
    inventory.restore(loaded.inventory, {
      made,
      present: (caseId, slot) =>
        slot.kind === LIMITS_COLUMN
          ? caseLimits.has(caseId)
          : (cases
              .listCases()
              .find((entry) => entry.id === caseId)
              ?.tables.has(slotKey(slot as TableSlotKey)) ?? false),
      adopted,
      source,
    });
  }

  /**
   * Everything a restore adopts once its Cases are made: display names
   * before the view repaints, the inventory last. Returns the notes.
   *
   * Every step runs after the old Cases are gone, so a throw here cannot
   * refuse the restore, and a caller's "nothing was replaced" would be false.
   * A step that throws is said, the steps after it still run, and the
   * inventory is reconciled against what did land.
   */
  function adoptSession(
    loaded: RestoredBundle,
    made: readonly MadeCase[],
    source: File | string,
    named: BundleNamed,
  ): string[] {
    const said = adoptDisplayNames(loaded.restoredCases, made);
    const step = (what: string, run: () => readonly string[] | void): boolean => {
      try {
        said.push(...(run() ?? []));
        return true;
      } catch (error) {
        said.push(`${named.start}: ${what} could not be restored. ${messageOf(error)}`);
        return false;
      }
    };
    step('the view (pins, panes and drawer)', () => host.restoreView(loaded, made));
    const taken = new Set<string>();
    step('the group maps', () => host.adoptGroups(loaded, named, taken));
    const landed = {
      lists: step('the reference lists', () => adoptLookups(loaded.lookups, named.start)),
      limits: step('the limits', () => adoptLimits(loaded.limits, made, named.start)),
    };
    step('the Contents inventory', () => adoptInventory(loaded, made, source, taken, landed));
    return said;
  }

  return {
    /**
     * Save every loaded Case with every table it owns, never only the Area
     * tables. The guard counts TABLES, not Cases, because an empty Case has
     * no data to save.
     */
    async saveAll(): Promise<void> {
      const loaded = cases.listCases();
      const tableCount = loaded.reduce((total, entry) => total + entry.tables.size, 0);
      if (tableCount === 0) {
        host.say('session', ['Nothing to save yet — drop a CSV export first.']);
        host.render();
        return;
      }
      try {
        host.setBusy('Saving…');
        // Two destinations: the .gvmb file the user keeps, and origin-private
        // storage for an instant Load on this machine. The file goes first
        // because its dialog can be cancelled. Read once so the two cannot
        // disagree.
        const contents = host.contents();
        const filename = await host.storage.downloadBundle(
          loaded,
          (done, total) => host.setBusy(`Writing case ${done} of ${total}…`),
          contents,
        );
        await host.storage.saveBundle(
          loaded,
          (done, total) => host.setBusy(`Saving case ${done} of ${total}…`),
          contents,
        );
        host.say('session', [
          `Saved ${loaded.length} case(s) (${tableCount} table(s)) to ${filename}, and to this ` +
            `browser's origin-private storage for the Load button. Drop the .gvmb file back in ` +
            `to restore it anywhere.`,
        ]);
      } catch (error) {
        host.say(
          'session',
          isAbort(error) ? ['Save cancelled.'] : [`Save failed: ${messageOf(error)}`],
        );
      } finally {
        host.setBusy(null);
      }
    },

    /**
     * Restore a dropped .gvmb (or a legacy .gvap/.gvip). Returns its notes
     * rather than writing them, so table files in the same drop cannot
     * overwrite the restore's account.
     */
    async restoreBundleFile(file: File): Promise<string[]> {
      try {
        host.setBusy(`Restoring ${file.name}…`);
        const loaded = await host.storage.readBundleFile(file);
        // Dropped-kind and migration notices are the only account of what the
        // bundle lost, so they show whether or not the restore was taken up.
        const adopted = adoptRestoredCases(loaded.restoredCases);
        if (!adopted) {
          const refusal =
            `${file.name} carried no table this build can read — the loaded study was left as ` +
            `it was, nothing was replaced.`;
          inventory.logRefused([file], refusal);
          return [refusal, ...loaded.warnings];
        }
        return [
          `Restored ${loaded.restoredCases.length} case(s) from ${file.name}.`,
          ...loaded.warnings,
          ...adoptSession(loaded, adopted.made, file, { inline: file.name, start: file.name }),
        ];
      } catch (error) {
        // Nothing was removed: every failure above happens either inside the
        // read (before the store is touched at all) or inside
        // `adoptRestoredCases`, which rolls its own partial work back.
        // `adoptSession` runs after the swap and says its own failures.
        const refusal = `${file.name}: ${messageOf(error)}`;
        inventory.logRefused([file], refusal);
        return [refusal];
      } finally {
        host.setBusy(null);
      }
    },

    /** Restore this browser's origin-private cache. Rejects when there is
     * none (normal on another machine), and the caller falls back to a file. */
    async loadAll(): Promise<void> {
      host.closeContents();
      try {
        host.setBusy('Loading…');
        let loaded: RestoredBundle;
        let adopted: ReturnType<typeof adoptRestoredCases>;
        try {
          loaded = await host.storage.loadBundle();
          adopted = adoptRestoredCases(loaded.restoredCases);
        } catch (error) {
          // "Nothing saved here" is not a refusal: the caller falls through to
          // a file picker. Anything else is a bundle this build turned away.
          if (!isMissingBundle(error)) inventory.logRefusedSource(OPFS_SOURCE, messageOf(error));
          throw error;
        }
        if (!adopted) {
          const refusal =
            'The saved bundle carried no table this build can read — the loaded study was left ' +
            'as it was, nothing was replaced.';
          inventory.logRefusedSource(OPFS_SOURCE, refusal);
          host.say('session', [refusal, ...loaded.warnings]);
          host.render();
          return;
        }
        host.say('session', [
          `Loaded ${loaded.restoredCases.length} case(s) from origin-private storage.`,
          ...loaded.warnings,
          ...adoptSession(loaded, adopted.made, OPFS_SOURCE, {
            inline: 'the saved bundle',
            start: 'The saved bundle',
          }),
        ]);
        host.render();
      } finally {
        host.setBusy(null);
      }
    },
  };
}
